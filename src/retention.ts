import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFile } from './atomicFile';
import { withFileLockSync } from './locks';

export const MANUAL_RECOVERY_MARKER = '.manual-recovery-required';
/** A transaction-owned backup is never eligible for retention until its journal releases it. */
export const BACKUP_RETENTION_PROTECTION_MARKER = '.transaction-backup-protected';

function hasBackupRetentionProtection(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name === BACKUP_RETENTION_PROTECTION_MARKER
      || name.startsWith(`${BACKUP_RETENTION_PROTECTION_MARKER}.lease-`));
  } catch {
    return false;
  }
}

/** Must be created before the corresponding live mutation begins. */
export function protectBackupFromRetention(dir: string, detail: string): void {
  atomicWriteFile(path.join(dir, BACKUP_RETENTION_PROTECTION_MARKER), `${detail}\n`);
}

/** Release only after success or a fully verified rollback. Failure safely leaks a backup. */
export function releaseBackupRetentionProtection(dir: string): void {
  fs.rmSync(path.join(dir, BACKUP_RETENTION_PROTECTION_MARKER), { force: true });
}

/**
 * Pin a selected generation for the whole operation that consumes it.
 *
 * A unique marker avoids one concurrent restore releasing another restore's pin.
 * Creation is serialized with pruning, so the caller either owns a durable pin or
 * fails before treating a concurrently-pruned directory as reusable evidence.
 */
export function acquireBackupRetentionLease(dir: string, detail: string): () => void {
  const marker = path.join(
    dir,
    `${BACKUP_RETENTION_PROTECTION_MARKER}.lease-${process.pid}-${crypto.randomUUID()}`,
  );
  withFileLockSync('backup-retention', () => {
    if (!fs.statSync(dir).isDirectory()) throw new Error('Selected backup is no longer available.');
    atomicWriteFile(marker, `${detail}\n`);
  });
  let released = false;
  return () => {
    if (released) return;
    withFileLockSync('backup-retention', () => {
      fs.rmSync(marker, { force: true });
    });
    released = true;
  };
}

function isManagedChild(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function hasDurableCompletionMarker(dir: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8')) as { complete?: unknown };
    return marker.complete === true;
  } catch {
    // Unknown, partial, and legacy-unmarked directories may be the only recovery
    // evidence. Retention must prove completion before deleting, never infer it.
    return false;
  }
}

/** Bound completed transaction backups while retaining every manual-recovery case. */
export function pruneManagedBackupDirs(root: string, keep: number): void {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Backup retention must keep at least one generation.');
  withFileLockSync('backup-retention', () => {
    let candidates: Array<{ dir: string; mtimeMs: number }> = [];
    try {
      candidates = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = path.join(root, entry.name);
          return { dir, mtimeMs: fs.statSync(dir).mtimeMs };
        })
        .filter(({ dir }) => !fs.existsSync(path.join(dir, MANUAL_RECOVERY_MARKER))
          && !hasBackupRetentionProtection(dir)
          && hasDurableCompletionMarker(dir))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return;
    }
    for (const { dir } of candidates.slice(keep)) {
      if (!isManagedChild(root, dir)
        || fs.existsSync(path.join(dir, MANUAL_RECOVERY_MARKER))
        || hasBackupRetentionProtection(dir)
        || !hasDurableCompletionMarker(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* retention is retried after the next completed transaction */
      }
    }
  });
}

export function markManualRecovery(dir: string, detail: string): void {
  // Silently swallowing this failure lets a later retention pass delete the only
  // recovery copy. Fail closed so the caller can keep its transaction protection and
  // report that durable operator intervention could not be recorded.
  atomicWriteFile(path.join(dir, MANUAL_RECOVERY_MARKER), `${detail}\n`);
}
