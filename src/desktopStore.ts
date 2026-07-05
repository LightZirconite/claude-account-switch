// Captures and restores Claude Desktop's session bundle as an opaque blob.
//
// Unlike Claude Code CLI, Desktop's OAuth token is OS-encrypted (Windows DPAPI /
// macOS Keychain "Claude Safe Storage") — it can't be read or written field by field.
// So a Desktop "account" is just a folder snapshot of Desktop's own session files,
// captured once (right after a real login) and restored verbatim on switch. Because
// the encryption key lives alongside the ciphertext (DPAPI-wrapped in `Local State`,
// bound to this Windows user), a restored snapshot decrypts fine on THIS machine —
// but the bundle is NOT portable to a different PC/user (see paths.ts DESKTOP_BUNDLE_ENTRIES).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { desktopUserDataDir, desktopStoreDir, backupsDir, DESKTOP_BUNDLE_ENTRIES, ensureDataDirs } from './paths';
import { logger } from './logger';

export function isDesktopInstalled(): boolean {
  return desktopUserDataDir() !== null;
}

function copyEntry(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (stat.isDirectory()) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}

/** Copy the bundle entries from `srcRoot` into `destRoot`, clearing destRoot first. */
function copyBundle(srcRoot: string, destRoot: string): void {
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of DESKTOP_BUNDLE_ENTRIES) {
    copyEntry(path.join(srcRoot, entry), path.join(destRoot, entry));
  }
}

export function snapshotDirFor(profileId: string): string {
  return path.join(desktopStoreDir(), profileId);
}

/** Snapshot Desktop's LIVE session into the given profile's stored bundle. Desktop must be closed. */
export function snapshotLiveDesktopInto(profileId: string): string {
  const live = desktopUserDataDir();
  if (!live) throw new Error('Claude Desktop data folder not found on this machine.');
  ensureDataDirs();
  const dest = snapshotDirFor(profileId);
  copyBundle(live, dest);
  logger.info('captured Claude Desktop session', { profileId, dest });
  return dest;
}

/** Restore a stored bundle back into Desktop's LIVE session folder. Desktop must be closed. */
function restoreDesktopSnapshot(snapshotDir: string): void {
  const live = desktopUserDataDir();
  if (!live) throw new Error('Claude Desktop data folder not found on this machine.');
  if (!fs.existsSync(snapshotDir)) throw new Error('Saved Desktop session bundle is missing.');
  copyBundle(snapshotDir, live);
}

/** Timestamped backup of the current LIVE Desktop bundle, for rollback on failure. */
function backupLiveDesktop(): string {
  const live = desktopUserDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsDir(), `desktop-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  if (live) copyBundle(live, dir);
  return dir;
}

export interface DesktopApplyResult {
  ok: boolean;
  error?: string;
}

/**
 * Swap in a Desktop-captured profile's session bundle: backup current live bundle ->
 * restore target -> rollback on failure. Caller must ensure Claude Desktop is CLOSED
 * before calling this (open SQLite/LevelDB files would otherwise be locked/corrupted).
 */
export function applyDesktopSnapshot(snapshotDir: string): DesktopApplyResult {
  if (!isDesktopInstalled()) {
    return { ok: false, error: 'Claude Desktop is not installed on this machine.' };
  }
  const backupDir = backupLiveDesktop();
  try {
    restoreDesktopSnapshot(snapshotDir);
    logger.info('switched Claude Desktop session', { snapshotDir, backupDir });
    return { ok: true };
  } catch (e) {
    try {
      restoreDesktopSnapshot(backupDir);
    } catch (rollbackErr) {
      logger.error('desktop rollback failed', rollbackErr);
    }
    logger.error('desktop apply failed, rolled back', e);
    return { ok: false, error: (e as Error).message };
  }
}

/** Allocate a fresh profile id + snapshot dir for a newly captured Desktop account. */
export function newDesktopProfileId(): string {
  return crypto.randomUUID();
}

export function deleteDesktopSnapshot(profileId: string): void {
  try {
    fs.rmSync(snapshotDirFor(profileId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
