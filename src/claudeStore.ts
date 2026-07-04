// Reads and writes the LIVE Claude Code credential files, safely.
//
// A live account = `claudeAiOauth` (+ root `organizationUuid`) in .credentials.json
//                + `oauthAccount` (+ `userID`) in .claude.json
//
// Writes are: backup -> atomic write -> validate -> rollback-on-failure.
// .claude.json is edited SURGICALLY (jsonc-parser) so we never touch/collapse its
// other keys (it can contain case-duplicate project keys that JSON.parse would lose).
import fs from 'node:fs';
import path from 'node:path';
import {
  modify,
  applyEdits,
  parseTree,
  findNodeAtLocation,
  getNodeValue,
  type FormattingOptions,
} from 'jsonc-parser';
import { credentialsPath, claudeJsonPath, backupsDir, ensureDataDirs } from './paths';
import { logger } from './logger';
import type { ClaudeAiOauth, LiveAccount, OauthAccount, Profile } from './types';

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function fmtFor(text: string): FormattingOptions {
  return { insertSpaces: true, tabSize: 2, eol: detectEol(text) };
}

/** Write atomically: temp file then rename over target. Falls back to direct write. */
function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.writeFileSync(target, content, 'utf8');
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------- Reading ----------

export function readLiveCredentials(): Record<string, unknown> | null {
  const t = readText(credentialsPath());
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    logger.error('parse .credentials.json failed', e);
    return null;
  }
}

/** Extract a top-level node's value from .claude.json without collapsing duplicate keys. */
function extractClaudeJsonNode<T>(text: string, key: string): T | undefined {
  const tree = parseTree(text);
  if (!tree) return undefined;
  const node = findNodeAtLocation(tree, [key]);
  if (!node) return undefined;
  return getNodeValue(node) as T;
}

export function getLiveAccount(): LiveAccount {
  const creds = readLiveCredentials();
  const claudeAiOauth = (creds?.claudeAiOauth as ClaudeAiOauth) ?? null;
  const organizationUuidRoot = creds?.organizationUuid as string | undefined;

  let oauthAccount: OauthAccount | null = null;
  let userID: string | undefined;
  const cjText = readText(claudeJsonPath());
  if (cjText) {
    oauthAccount = extractClaudeJsonNode<OauthAccount>(cjText, 'oauthAccount') ?? null;
    userID = extractClaudeJsonNode<string>(cjText, 'userID');
  }
  return { claudeAiOauth, organizationUuidRoot, oauthAccount, userID };
}

// ---------- Backups ----------

export function backupLive(): string {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsDir(), stamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const src of [credentialsPath(), claudeJsonPath()]) {
    const t = readText(src);
    if (t != null) fs.writeFileSync(path.join(dir, path.basename(src)), t, 'utf8');
  }
  logger.info('backup created', { dir });
  return dir;
}

export function listBackups(): string[] {
  try {
    return fs
      .readdirSync(backupsDir())
      .map((n) => path.join(backupsDir(), n))
      .filter((p) => fs.statSync(p).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

export function restoreFromBackup(dir: string): void {
  const map: Array<[string, string]> = [
    ['.credentials.json', credentialsPath()],
    ['credentials.json', credentialsPath()],
    ['.claude.json', claudeJsonPath()],
  ];
  for (const [name, target] of map) {
    const src = path.join(dir, name);
    if (fs.existsSync(src)) {
      const t = readText(src);
      if (t != null) atomicWrite(target, t);
    }
  }
  logger.warn('restored from backup', { dir });
}

export function restoreLatestBackup(): string | null {
  const all = listBackups();
  if (!all.length) return null;
  const latest = all[all.length - 1];
  restoreFromBackup(latest);
  return latest;
}

// ---------- Writing ----------

function writeCredentials(claudeAiOauth: ClaudeAiOauth, organizationUuidRoot?: string): void {
  const p = credentialsPath();
  const t = readText(p);
  let obj: Record<string, unknown> = {};
  if (t) {
    try {
      obj = JSON.parse(t);
    } catch {
      obj = {};
    }
  }
  obj.claudeAiOauth = claudeAiOauth; // preserves mcpOAuth and any other keys
  if (organizationUuidRoot !== undefined) obj.organizationUuid = organizationUuidRoot;
  atomicWrite(p, JSON.stringify(obj, null, 2) + '\n');
}

function writeClaudeJson(oauthAccount: OauthAccount, userID?: string): void {
  const p = claudeJsonPath();
  let text = readText(p);
  if (text == null) text = '{}\n';
  const fmt = fmtFor(text);
  text = applyEdits(text, modify(text, ['oauthAccount'], oauthAccount, { formattingOptions: fmt }));
  if (userID !== undefined) {
    text = applyEdits(text, modify(text, ['userID'], userID, { formattingOptions: fmt }));
  }
  atomicWrite(p, text);
}

/**
 * Sync a rotated `claudeAiOauth` back into the LIVE credentials file, preserving
 * mcpOAuth and other keys. Used when we refresh the ACTIVE account's token so the
 * running Claude session doesn't end up holding an invalidated refresh token.
 */
export function updateLiveCredentials(claudeAiOauth: ClaudeAiOauth, organizationUuidRoot?: string): void {
  const p = credentialsPath();
  const t = readText(p);
  let obj: Record<string, unknown> = {};
  if (t) {
    try {
      obj = JSON.parse(t);
    } catch {
      logger.warn('updateLiveCredentials: cannot parse live credentials, skipping to avoid data loss');
      return;
    }
  }
  obj.claudeAiOauth = claudeAiOauth;
  if (organizationUuidRoot !== undefined) obj.organizationUuid = organizationUuidRoot;
  atomicWrite(p, JSON.stringify(obj, null, 2) + '\n');
  logger.info('synced rotated token to live credentials');
}

/** Both files must still parse as JSON after a write. */
export function validateLiveFiles(): boolean {
  const c = readText(credentialsPath());
  const j = readText(claudeJsonPath());
  try {
    if (c) JSON.parse(c);
    if (j) JSON.parse(j); // JSON.parse tolerates duplicate keys (last wins)
    return true;
  } catch {
    return false;
  }
}

export interface ApplyResult {
  ok: boolean;
  backupDir?: string;
  error?: string;
  dryRun?: DryRunReport;
}

export interface DryRunReport {
  credentials: { willSet: string[]; preserved: string[] };
  claudeJson: { willSet: string[]; preserved: string[]; stillValid: boolean };
}

function topLevelKeys(text: string | null): string[] {
  if (!text) return [];
  try {
    return Object.keys(JSON.parse(text));
  } catch {
    return [];
  }
}

export function dryRunApply(p: Profile): DryRunReport {
  const orgRoot = p.organizationUuidRoot ?? p.organizationUuid;

  const credKeys = topLevelKeys(readText(credentialsPath()));
  const credWillSet = ['claudeAiOauth', ...(orgRoot !== undefined ? ['organizationUuid'] : [])];
  const credPreserved = credKeys.filter((k) => !credWillSet.includes(k));

  const cjText = readText(claudeJsonPath());
  const cjKeys = topLevelKeys(cjText);
  const cjWillSet = ['oauthAccount', ...(p.userID !== undefined ? ['userID'] : [])];
  const cjPreserved = cjKeys.filter((k) => !cjWillSet.includes(k));

  // Simulate the surgical edit in memory and confirm the result is valid JSON.
  let stillValid = true;
  try {
    let text = cjText ?? '{}\n';
    const fmt = fmtFor(text);
    text = applyEdits(text, modify(text, ['oauthAccount'], p.oauthAccount, { formattingOptions: fmt }));
    if (p.userID !== undefined) {
      text = applyEdits(text, modify(text, ['userID'], p.userID, { formattingOptions: fmt }));
    }
    JSON.parse(text);
  } catch {
    stillValid = false;
  }

  const report: DryRunReport = {
    credentials: { willSet: credWillSet, preserved: credPreserved },
    claudeJson: { willSet: cjWillSet, preserved: cjPreserved, stillValid },
  };
  logger.info('dry-run', {
    profile: p.email,
    credWillSet,
    credPreservedCount: credPreserved.length,
    cjWillSet,
    cjPreservedCount: cjPreserved.length,
    stillValid,
  });
  return report;
}

/** Swap in a profile: backup -> write -> validate -> rollback on failure. */
export function applyProfile(p: Profile, opts: { dryRun?: boolean } = {}): ApplyResult {
  if (opts.dryRun) {
    return { ok: true, dryRun: dryRunApply(p) };
  }
  const backupDir = backupLive();
  try {
    writeCredentials(p.claudeAiOauth, p.organizationUuidRoot ?? p.organizationUuid);
    writeClaudeJson(p.oauthAccount, p.userID);
    if (!validateLiveFiles()) {
      restoreFromBackup(backupDir);
      logger.error('validation failed after write, rolled back', undefined, { profile: p.email });
      return { ok: false, backupDir, error: 'Validation failed after write. Rolled back.' };
    }
    logger.info('switched account', { to: p.email, subscription: p.subscriptionType, backupDir });
    return { ok: true, backupDir };
  } catch (e) {
    restoreFromBackup(backupDir);
    logger.error('apply failed, rolled back', e, { profile: p.email });
    return { ok: false, backupDir, error: (e as Error).message };
  }
}
