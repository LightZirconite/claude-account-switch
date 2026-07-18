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
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  modify,
  applyEdits,
  parseTree,
  findNodeAtLocation,
  getNodeValue,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import { credentialsPath, claudeJsonPath, backupsDir, dataDir, ensureDataDirs } from './paths';
import { logger, redactText } from './logger';
import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import { withFileLockSync } from './locks';
import {
  acquireBackupRetentionLease,
  markManualRecovery,
  protectBackupFromRetention,
  pruneManagedBackupDirs,
  releaseBackupRetentionProtection,
} from './retention';
import { findClaudeProcesses, type ProcInfo } from './processes';
import {
  hasCliAuth,
  hasRefreshableOauth,
  type ClaudeAiOauth,
  type LiveAccount,
  type OauthAccount,
  type Profile,
} from './types';

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// On macOS, Claude Code stores the credentials JSON in the login Keychain (service
// "Claude Code-credentials"), not in a file. On Windows/Linux it's a plain file.
// We abstract read/write so the rest of the code is platform-agnostic. (~/.claude.json
// — the oauthAccount/userID side — is a plain file on every platform.)
const CREDS_IN_KEYCHAIN = process.platform === 'darwin';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function keychainItemMissing(error: unknown): boolean {
  const record = error as { status?: number; stderr?: string | Buffer; message?: string };
  const diagnostic = `${record.stderr?.toString() ?? ''} ${record.message ?? ''}`;
  // `security` commonly returns 44 for errSecItemNotFound (-25300). Keep the
  // textual check for macOS versions that expose only the Security.framework text.
  return record.status === 44
    || /(?:specified item|keychain item).*(?:could not be found|not found)|errSecItemNotFound|-25300/i.test(diagnostic);
}

function readCredentialsText(): string | null {
  if (CREDS_IN_KEYCHAIN) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return out.trim() || null;
    } catch (error) {
      if (keychainItemMissing(error)) return null;
      throw new Error('Claude credentials could not be read from the macOS Keychain; transaction aborted.', { cause: error });
    }
  }
  return readText(credentialsPath());
}

function writeCredentialsText(text: string): void {
  if (CREDS_IN_KEYCHAIN) {
    // Apple's `security add-generic-password -w <secret>` accepts the secret only as
    // an argv value. Passing an OAuth envelope there violates our no-secret-in-process-
    // arguments invariant. Until a native Security.framework adapter is bundled, fail
    // closed and direct macOS users to the provider-supported Claude login workflow.
    void text;
    throw new Error('Secure automated Claude Keychain writes are unavailable on macOS. Authenticate the live account directly with the official "claude auth login" command; no live credentials were changed.');
  }
  atomicWriteFile(credentialsPath(), text);
}

function deleteCredentialsText(): void {
  if (CREDS_IN_KEYCHAIN) {
    throw new Error('Refusing to delete Claude credentials from the macOS Keychain without a transactional Security.framework adapter.');
  }
  // Only the provider-owned dotted path participates in live authentication. Preserve
  // an undotted artifact: it is neither read nor written by Claude Code and may be
  // valuable recovery evidence from an older third-party tool.
  fs.rmSync(credentialsPath(), { force: true });
}

function parseJsoncDocument(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length) throw new Error('Invalid Claude JSONC document.');
  return getNodeValue(tree);
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function fmtFor(text: string): FormattingOptions {
  return { insertSpaces: true, tabSize: 2, eol: detectEol(text) };
}

// ---------- Reading ----------

export function readLiveCredentials(): Record<string, unknown> | null {
  const t = readCredentialsText();
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    logger.error('parse .credentials.json failed', e);
    throw new Error('Live Claude credentials are malformed. Maintenance and switching were aborted.', { cause: e });
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

/** Read both live Claude files while the caller holds `claude-live-auth`. */
function readLiveAccountRawUnlocked(): LiveAccount {
  const creds = readLiveCredentials();
  const claudeAiOauth = (creds?.claudeAiOauth as ClaudeAiOauth) ?? null;
  const organizationUuidRoot = creds?.organizationUuid as string | undefined;

  let oauthAccount: OauthAccount | null = null;
  let userID: string | undefined;
  const cjText = readText(claudeJsonPath());
  if (cjText) {
    parseJsoncDocument(cjText);
    oauthAccount = extractClaudeJsonNode<OauthAccount>(cjText, 'oauthAccount') ?? null;
    userID = extractClaudeJsonNode<string>(cjText, 'userID');
  }
  return { claudeAiOauth, organizationUuidRoot, oauthAccount, userID };
}

/** Read while holding `claude-live-auth`, refusing to expose an interrupted midpoint. */
export function readLiveAccountUnlocked(): LiveAccount {
  assertNoInterruptedClaudeLiveAuthTransaction();
  return readLiveAccountRawUnlocked();
}

/** Return one coherent live-auth snapshot; never expose the two-file transaction midpoint. */
export function getLiveAccount(): LiveAccount {
  return withFileLockSync('claude-live-auth', () => readLiveAccountUnlocked());
}

// ---------- Backups ----------

interface ClaudeLiveBackupManifest {
  kind: 'claude-codex-account-switch/claude-live-backup';
  version: 2;
  createdAt: number;
  complete: true;
  credentials: { present: true; sha256: string } | { present: false };
  claudeJson: { present: true; sha256: string } | { present: false };
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

function releaseBackupProtectionSafely(dir: string): void {
  try {
    releaseBackupRetentionProtection(dir);
  } catch (error) {
    // A retained protection marker is a safe storage leak, never a reason to undo a
    // successfully validated authentication transaction.
    logger.warn('Claude backup retention protection could not be released', { dir, error: String(error) });
  }
}

function readBackupManifest(dir: string): ClaudeLiveBackupManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8')) as ClaudeLiveBackupManifest;
    if (manifest?.kind !== 'claude-codex-account-switch/claude-live-backup'
      || manifest.version !== 2
      || manifest.complete !== true
      || !Number.isFinite(manifest.createdAt)
      || manifest.createdAt <= 0) return null;
    const entries: Array<[ClaudeLiveBackupManifest['credentials'], string]> = [
      [manifest.credentials, '.credentials.json'],
      [manifest.claudeJson, '.claude.json'],
    ];
    for (const [entry, file] of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.present !== 'boolean') return null;
      const payload = path.join(dir, file);
      if (entry.present) {
        if (!('sha256' in entry) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
        if (!fs.statSync(payload).isFile() || sha256(fs.readFileSync(payload, 'utf8')) !== entry.sha256) return null;
      } else {
        if ('sha256' in entry || fs.existsSync(payload)) return null;
      }
    }
    return manifest;
  } catch {
    return null;
  }
}

export function backupLive(options: { protectUntilTransactionEnds?: boolean } = {}): string {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsDir(), 'claude-live', `${stamp}-${crypto.randomUUID().slice(0, 8)}`);
  ensurePrivateDir(dir);
  if (options.protectUntilTransactionEnds) {
    protectBackupFromRetention(dir, 'Claude live-auth transaction in progress.');
  }
  const credText = readCredentialsText();
  const cjText = readText(claudeJsonPath());
  if (credText != null) atomicWriteFile(path.join(dir, '.credentials.json'), credText);
  if (cjText != null) atomicWriteFile(path.join(dir, '.claude.json'), cjText);
  const manifest: ClaudeLiveBackupManifest = {
    kind: 'claude-codex-account-switch/claude-live-backup',
    version: 2,
    createdAt: Date.now(),
    complete: true,
    credentials: credText != null ? { present: true, sha256: sha256(credText) } : { present: false },
    claudeJson: cjText != null ? { present: true, sha256: sha256(cjText) } : { present: false },
  };
  // Completion marker is deliberately last: incomplete transaction directories are
  // never eligible for automatic restore.
  atomicWriteFile(path.join(dir, 'transaction.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  pruneManagedBackupDirs(path.join(backupsDir(), 'claude-live'), 20);
  logger.info('backup created', { dir });
  return dir;
}

export function listBackups(): string[] {
  const result: string[] = [];
  try {
    const modernRoot = path.join(backupsDir(), 'claude-live');
    for (const name of fs.readdirSync(modernRoot)) {
      const dir = path.join(modernRoot, name);
      if (fs.statSync(dir).isDirectory() && readBackupManifest(dir)) result.push(dir);
    }
  } catch {
    /* no modern backups */
  }
  // Legacy directories remain on disk as recovery evidence, but are deliberately not
  // offered for automatic restore because they cannot attest a complete generation.
  return result.sort((a, b) => {
    try {
      return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
    } catch {
      return a.localeCompare(b);
    }
  });
}

function verifiedBackupText(
  dir: string,
  file: string,
  expectedHash: string,
  format: 'json' | 'jsonc' = 'json',
): string {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  if (sha256(text) !== expectedHash) throw new Error(`Backup integrity check failed for ${file}.`);
  if (format === 'jsonc') parseJsoncDocument(text);
  else JSON.parse(text);
  return text;
}

function restoreFromBackupUnlocked(dir: string): void {
  const manifest = readBackupManifest(dir);
  if (!manifest) throw new Error('Selected Claude backup does not have a valid v2 integrity manifest.');
  let applied = 0;
  // credentials (Keychain on macOS, file elsewhere)
  // Validate every declared payload before changing either live location.
  const credentialText = manifest.credentials.present
    ? verifiedBackupText(dir, '.credentials.json', manifest.credentials.sha256)
    : null;
  const claudeText = manifest.claudeJson.present
    ? verifiedBackupText(dir, '.claude.json', manifest.claudeJson.sha256, 'jsonc')
    : null;
  if (manifest.credentials.present) {
    writeCredentialsText(credentialText!);
    applied++;
  } else {
    deleteCredentialsText();
    applied++;
  }
  if (manifest.claudeJson.present) {
    atomicWriteFile(claudeJsonPath(), claudeText!);
    applied++;
  } else {
    fs.rmSync(claudeJsonPath(), { force: true });
    applied++;
  }
  if (applied === 0) throw new Error('Selected directory is not a usable Claude live-auth backup.');
  logger.warn('restored from backup', { dir });
}

function assertLiveMatchesBackup(dir: string): void {
  const manifest = readBackupManifest(dir);
  if (!manifest) throw new Error('Claude restore verification requires a valid v2 integrity manifest.');
  const credentials = readCredentialsText();
  const claudeJson = readText(claudeJsonPath());
  if ((credentials != null) !== manifest.credentials.present
    || (claudeJson != null) !== manifest.claudeJson.present) {
    throw new Error('Claude restore verification failed: live file presence differs from the backup manifest.');
  }
  if (manifest.credentials.present
    && (credentials == null || sha256(credentials) !== manifest.credentials.sha256)) {
    throw new Error('Claude restore verification failed for credentials.');
  }
  if (manifest.claudeJson.present
    && (claudeJson == null || sha256(claudeJson) !== manifest.claudeJson.sha256)) {
    throw new Error('Claude restore verification failed for .claude.json.');
  }
  if (!validateLiveFiles()) throw new Error('Claude restore verification found malformed live auth files.');
}

// ---------- Cross-file live-auth transaction journal ----------

type ClaudeLiveAuthJournalState = 'prepared' | 'applying' | 'rolling-back' | 'committed' | 'rolled-back';
type ClaudeLiveAuthJournalOperation = 'apply-profile' | 'restore-backup';

interface ClaudeLiveAuthJournal {
  kind: 'claude-codex-account-switch/claude-live-auth-transaction';
  version: 1;
  transactionId: string;
  operation: ClaudeLiveAuthJournalOperation;
  state: ClaudeLiveAuthJournalState;
  backupDir: string;
  backupManifestSha256: string;
  targetRef: string;
  createdAt: number;
  updatedAt: number;
}

type ClaudeLiveAuthJournalRead =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; journal: ClaudeLiveAuthJournal };

export interface ClaudeLiveAuthRecoveryInspection {
  pending: boolean;
  damaged: boolean;
  journalPath: string;
  state?: ClaudeLiveAuthJournalState;
  operation?: ClaudeLiveAuthJournalOperation;
  backupDir?: string;
}

export interface ClaudeLiveAuthRecoveryResult {
  recovered: boolean;
  action: 'none' | 'rolled-back' | 'cleaned-terminal';
  backupDir?: string;
}

const CLAUDE_LIVE_AUTH_JOURNAL_KIND = 'claude-codex-account-switch/claude-live-auth-transaction' as const;
const CLAUDE_LIVE_AUTH_JOURNAL_STATES = new Set<ClaudeLiveAuthJournalState>([
  'prepared',
  'applying',
  'rolling-back',
  'committed',
  'rolled-back',
]);
const CLAUDE_LIVE_AUTH_JOURNAL_OPERATIONS = new Set<ClaudeLiveAuthJournalOperation>([
  'apply-profile',
  'restore-backup',
]);

export function claudeLiveAuthJournalPath(): string {
  return path.join(dataDir(), 'transactions', 'claude-live-auth.json');
}

function isManagedClaudeBackupPath(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const root = path.resolve(backupsDir(), 'claude-live');
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isRealManagedClaudeBackupPath(candidate: string): boolean {
  if (!isManagedClaudeBackupPath(candidate)) return false;
  try {
    const root = fs.realpathSync(path.join(backupsDir(), 'claude-live'));
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const resolved = fs.realpathSync(candidate);
    const relative = path.relative(root, resolved);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function readClaudeLiveAuthJournal(): ClaudeLiveAuthJournalRead {
  const selected = claudeLiveAuthJournalPath();
  let raw: string;
  try {
    const stat = fs.lstatSync(selected);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'invalid', reason: 'the journal path is not a regular file' };
    }
    raw = fs.readFileSync(selected, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' };
    return { status: 'invalid', reason: 'the journal could not be read safely' };
  }

  try {
    const value = JSON.parse(raw) as Partial<ClaudeLiveAuthJournal>;
    if (value.kind !== CLAUDE_LIVE_AUTH_JOURNAL_KIND
      || value.version !== 1
      || typeof value.transactionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.transactionId)
      || typeof value.operation !== 'string'
      || !CLAUDE_LIVE_AUTH_JOURNAL_OPERATIONS.has(value.operation as ClaudeLiveAuthJournalOperation)
      || typeof value.state !== 'string'
      || !CLAUDE_LIVE_AUTH_JOURNAL_STATES.has(value.state as ClaudeLiveAuthJournalState)
      || typeof value.backupDir !== 'string'
      || !isManagedClaudeBackupPath(value.backupDir)
      || typeof value.backupManifestSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.backupManifestSha256)
      || typeof value.targetRef !== 'string'
      || value.targetRef.length < 1
      || value.targetRef.length > 1_024
      || !Number.isFinite(value.createdAt)
      || Number(value.createdAt) <= 0
      || !Number.isFinite(value.updatedAt)
      || Number(value.updatedAt) < Number(value.createdAt)) {
      return { status: 'invalid', reason: 'the journal schema or managed backup reference is invalid' };
    }
    return { status: 'valid', journal: value as ClaudeLiveAuthJournal };
  } catch {
    return { status: 'invalid', reason: 'the journal is not valid JSON' };
  }
}

function journalFailureMessage(reason: string): string {
  return `Claude live-auth recovery journal is damaged (${reason}). Live authentication is frozen and the evidence was preserved at ${claudeLiveAuthJournalPath()}.`;
}

function assertNoInterruptedClaudeLiveAuthTransaction(): void {
  const observed = readClaudeLiveAuthJournal();
  if (observed.status === 'none') return;
  if (observed.status === 'invalid') throw new Error(journalFailureMessage(observed.reason));
  throw new Error(
    `Claude live-auth transaction ${observed.journal.transactionId} is ${observed.journal.state}. Recover it before reading or changing live authentication.`,
  );
}

function persistClaudeLiveAuthJournal(journal: ClaudeLiveAuthJournal): void {
  ensurePrivateDir(path.dirname(claudeLiveAuthJournalPath()));
  const content = `${JSON.stringify(journal, null, 2)}\n`;
  try {
    atomicWriteFile(claudeLiveAuthJournalPath(), content);
  } catch (error) {
    // A directory-fsync failure can be reported after the atomic rename succeeded.
    // Treat the requested state as durable only when a strict reread proves it.
    const observed = readClaudeLiveAuthJournal();
    if (observed.status === 'valid'
      && JSON.stringify(observed.journal) === JSON.stringify(journal)) {
      logger.warn('Claude live-auth journal write reported an error after durable replacement', {
        transactionId: journal.transactionId,
        state: journal.state,
      });
      return;
    }
    throw error;
  }
}

function beginClaudeLiveAuthTransaction(
  operation: ClaudeLiveAuthJournalOperation,
  backupDir: string,
  targetRef: string,
): ClaudeLiveAuthJournal {
  assertNoInterruptedClaudeLiveAuthTransaction();
  if (!isRealManagedClaudeBackupPath(backupDir)) {
    throw new Error('Refusing to begin a Claude live-auth transaction without a verified managed rollback backup.');
  }
  const manifestPath = path.join(backupDir, 'transaction.json');
  const manifestBeforeValidation = fs.readFileSync(manifestPath, 'utf8');
  const backupManifestSha256 = sha256(manifestBeforeValidation);
  if (!readBackupManifest(backupDir)
    || sha256(fs.readFileSync(manifestPath, 'utf8')) !== backupManifestSha256) {
    throw new Error('Refusing to begin a Claude live-auth transaction without one stable, verified rollback generation.');
  }
  const now = Date.now();
  const journal: ClaudeLiveAuthJournal = {
    kind: CLAUDE_LIVE_AUTH_JOURNAL_KIND,
    version: 1,
    transactionId: crypto.randomUUID(),
    operation,
    state: 'prepared',
    backupDir: path.resolve(backupDir),
    backupManifestSha256,
    targetRef,
    createdAt: now,
    updatedAt: now,
  };
  persistClaudeLiveAuthJournal(journal);
  return journal;
}

function journalRollbackBackupMatches(journal: ClaudeLiveAuthJournal): boolean {
  if (!isRealManagedClaudeBackupPath(journal.backupDir)) return false;
  try {
    const selected = path.join(journal.backupDir, 'transaction.json');
    const before = fs.readFileSync(selected, 'utf8');
    if (sha256(before) !== journal.backupManifestSha256 || !readBackupManifest(journal.backupDir)) return false;
    return sha256(fs.readFileSync(selected, 'utf8')) === journal.backupManifestSha256;
  } catch {
    return false;
  }
}

function transitionClaudeLiveAuthJournal(
  journal: ClaudeLiveAuthJournal,
  state: ClaudeLiveAuthJournalState,
): ClaudeLiveAuthJournal {
  const observed = readClaudeLiveAuthJournal();
  if (observed.status === 'invalid') throw new Error(journalFailureMessage(observed.reason));
  if (observed.status !== 'valid' || observed.journal.transactionId !== journal.transactionId) {
    throw new Error('Claude live-auth journal ownership changed during the transaction; live authentication is frozen.');
  }
  const next: ClaudeLiveAuthJournal = {
    ...observed.journal,
    state,
    updatedAt: Math.max(Date.now(), observed.journal.updatedAt + 1),
  };
  persistClaudeLiveAuthJournal(next);
  return next;
}

function clearTerminalClaudeLiveAuthJournal(journal: ClaudeLiveAuthJournal): void {
  const observed = readClaudeLiveAuthJournal();
  if (observed.status !== 'valid'
    || observed.journal.transactionId !== journal.transactionId
    || (observed.journal.state !== 'committed' && observed.journal.state !== 'rolled-back')) {
    throw new Error('Refusing to clear a non-terminal or replaced Claude live-auth journal.');
  }
  fs.rmSync(claudeLiveAuthJournalPath());
}

function finishClaudeLiveAuthTransaction(
  journal: ClaudeLiveAuthJournal,
  terminalState: 'committed' | 'rolled-back',
): void {
  const terminal = transitionClaudeLiveAuthJournal(journal, terminalState);
  // The backup remains transaction-pinned until the terminal state is durable.
  releaseBackupProtectionSafely(terminal.backupDir);
  try {
    clearTerminalClaudeLiveAuthJournal(terminal);
  } catch (error) {
    // A terminal journal is safe to replay as cleanup on startup. Never convert an
    // already-validated commit into a rollback merely because journal deletion failed.
    logger.warn('Claude terminal live-auth journal cleanup was deferred', {
      transactionId: terminal.transactionId,
      state: terminal.state,
      error: String(error),
    });
  }
}

export function inspectClaudeLiveAuthRecovery(): ClaudeLiveAuthRecoveryInspection {
  const observed = readClaudeLiveAuthJournal();
  if (observed.status === 'none') {
    return { pending: false, damaged: false, journalPath: claudeLiveAuthJournalPath() };
  }
  if (observed.status === 'invalid') {
    return { pending: true, damaged: true, journalPath: claudeLiveAuthJournalPath() };
  }
  return {
    pending: true,
    damaged: false,
    journalPath: claudeLiveAuthJournalPath(),
    state: observed.journal.state,
    operation: observed.journal.operation,
    backupDir: observed.journal.backupDir,
  };
}

/**
 * Recover an interrupted two-file mutation while holding the same live-auth lock used
 * by switches and restores. Non-terminal transactions are conservatively rolled back;
 * a durable terminal state only needs retention/journal cleanup.
 */
export function recoverClaudeLiveAuthTransaction(
  options: { processInventory?: () => ProcInfo[] } = {},
): ClaudeLiveAuthRecoveryResult {
  const initial = readClaudeLiveAuthJournal();
  if (initial.status === 'none') return { recovered: false, action: 'none' };
  if (initial.status === 'invalid') throw new Error(journalFailureMessage(initial.reason));

  const processInventory = options.processInventory ?? findClaudeProcesses;
  let running: ProcInfo[] = [];
  const initialIsTerminal = initial.journal.state === 'committed' || initial.journal.state === 'rolled-back';
  if (!initialIsTerminal) {
    try {
      running = processInventory();
    } catch (error) {
      throw new Error(`Claude process safety could not be verified before live-auth recovery: ${redactText(error)}`);
    }
    if (running.length) {
      throw new Error(`Claude live-auth recovery is pending. Close Claude first (process ${running.map((item) => item.pid).join(', ')}); no recovery write was attempted.`);
    }
  }

  // The interactive switch holds provider-switch outside live-auth. A hard process
  // death can abandon both, so recovery reclaims them in the normal lock order and
  // only through the explicit, fenced takeover path.
  return withFileLockSync('claude-provider-switch', () => (
    withFileLockSync('claude-live-auth', () => {
      const observed = readClaudeLiveAuthJournal();
      if (observed.status === 'none') return { recovered: false, action: 'none' };
      if (observed.status === 'invalid') throw new Error(journalFailureMessage(observed.reason));
      const journal = observed.journal;

      // Terminal means the live pair was already verified (commit) or restored
      // (rollback). Cleanup does not inspect or mutate provider files and is safe even
      // if Claude has since started.
      if (journal.state === 'committed' || journal.state === 'rolled-back') {
        releaseBackupProtectionSafely(journal.backupDir);
        clearTerminalClaudeLiveAuthJournal(journal);
        return { recovered: true, action: 'cleaned-terminal', backupDir: journal.backupDir };
      }

      try {
        running = processInventory();
      } catch (error) {
        throw new Error(`Claude process safety could not be verified under the recovery locks: ${redactText(error)}`);
      }
      if (running.length) {
        throw new Error(`A Claude process appeared before live-auth recovery (process ${running.map((item) => item.pid).join(', ')}). No recovery write was attempted.`);
      }

      if (CREDS_IN_KEYCHAIN) {
        throw new Error('Interrupted Claude live-auth recovery requires a transactional Keychain adapter on macOS. Evidence and the protected backup were preserved.');
      }
      if (!journalRollbackBackupMatches(journal)) {
        throw new Error('Claude live-auth recovery backup is missing, outside the managed backup root, failed integrity validation, or no longer matches the manifest generation anchored by the journal. Evidence was preserved and live authentication was not changed.');
      }

      let rollingBack = journal;
      if (journal.state !== 'rolling-back') {
        rollingBack = transitionClaudeLiveAuthJournal(journal, 'rolling-back');
      }
      try {
        running = processInventory();
      } catch (error) {
        throw new Error(`Claude process safety could not be verified at the recovery mutation boundary: ${redactText(error)}`);
      }
      if (running.length) {
        throw new Error(`A Claude process appeared at the live-auth recovery boundary (process ${running.map((item) => item.pid).join(', ')}). The protected backup and journal were retained.`);
      }
      if (!journalRollbackBackupMatches(rollingBack)) {
        throw new Error('Claude live-auth recovery backup changed after staging. The protected evidence was retained and no live recovery write was attempted.');
      }

      try {
        restoreFromBackupUnlocked(rollingBack.backupDir);
        assertLiveMatchesBackup(rollingBack.backupDir);
        finishClaudeLiveAuthTransaction(rollingBack, 'rolled-back');
        logger.warn('recovered interrupted Claude live-auth transaction', {
          transactionId: rollingBack.transactionId,
          operation: rollingBack.operation,
          backupDir: rollingBack.backupDir,
        });
        return { recovered: true, action: 'rolled-back', backupDir: rollingBack.backupDir };
      } catch (error) {
        try {
          markManualRecovery(rollingBack.backupDir, 'Interrupted Claude live-auth transaction could not be recovered automatically.');
        } catch (markerError) {
          throw new AggregateError(
            [error, markerError],
            `Claude live-auth recovery failed and manual-recovery evidence could not be marked. The transaction protection and journal remain at ${rollingBack.backupDir}.`,
          );
        }
        throw new Error(`Claude live-auth recovery failed. The journal and protected backup were preserved at ${rollingBack.backupDir}: ${redactText(error)}`, {
          cause: error,
        });
      }
    }, { recoverAbandoned: true })
  ), { recoverAbandoned: true });
}

function validateClaudeBackupSelection(dir: string): void {
  const manifestFile = path.join(dir, 'transaction.json');
  const manifest = readBackupManifest(dir);
  if (fs.existsSync(manifestFile) && !manifest) {
    throw new Error('Selected Claude backup has an incomplete or invalid transaction manifest.');
  }
  if (manifest) {
    if (manifest.credentials.present) {
      verifiedBackupText(dir, '.credentials.json', manifest.credentials.sha256);
    }
    if (manifest.claudeJson.present) {
      verifiedBackupText(dir, '.claude.json', manifest.claudeJson.sha256, 'jsonc');
    }
    return;
  }
  throw new Error('This legacy Claude backup predates complete integrity manifests and cannot be restored automatically. Its files were preserved for manual import/recovery.');
}

export function restoreFromBackup(
  dir: string,
  options: { processInventory?: () => ProcInfo[] } = {},
): void {
  if (CREDS_IN_KEYCHAIN) {
    throw new Error('Automated Claude backup restoration is disabled on macOS because transactional Keychain writes are unavailable. Use the official Claude login workflow.');
  }
  // Validate the complete selected generation before creating a rollback point or
  // touching either live file.
  validateClaudeBackupSelection(dir);
  const releaseSelectedBackup = acquireBackupRetentionLease(
    dir,
    'Claude backup selected for an in-progress restore.',
  );
  try {
    // Re-read under the durable retention pin. Another process may have completed a
    // pruning pass between the optimistic validation and lease acquisition.
    validateClaudeBackupSelection(dir);
    const processInventory = options.processInventory ?? findClaudeProcesses;
    const beforeLock = processInventory();
    if (beforeLock.length) {
      throw new Error(`Close Claude before restoring authentication (process ${beforeLock.map((item) => item.pid).join(', ')}).`);
    }
    withFileLockSync('claude-live-auth', () => {
      assertNoInterruptedClaudeLiveAuthTransaction();
      const afterLock = processInventory();
      if (afterLock.length) {
        throw new Error(`A Claude process appeared before restore (process ${afterLock.map((item) => item.pid).join(', ')}). Nothing changed.`);
      }
      // A manual restore is itself a live-auth transaction. Preserve the current state
      // first so failure of the second provider file can never leave a hybrid identity.
      const rollbackDir = backupLive({ protectUntilTransactionEnds: true });
      let journal: ClaudeLiveAuthJournal;
      try {
        journal = beginClaudeLiveAuthTransaction('restore-backup', rollbackDir, path.basename(path.resolve(dir)));
        journal = transitionClaudeLiveAuthJournal(journal, 'applying');
      } catch (error) {
        // No provider file was touched. Keep a backup pinned whenever a journal may
        // exist, since startup recovery must be able to resolve partial journal I/O.
        if (!inspectClaudeLiveAuthRecovery().pending) releaseBackupProtectionSafely(rollbackDir);
        throw new Error(`Claude restore could not create its durable live-auth journal. Nothing changed: ${redactText(error)}`, {
          cause: error,
        });
      }

      let beforeMutation: ProcInfo[];
      try {
        beforeMutation = processInventory();
      } catch (error) {
        try {
          finishClaudeLiveAuthTransaction(journal, 'rolled-back');
        } catch {
          /* the protected journal remains recoverable */
        }
        throw new Error(`Claude process safety could not be verified after staging the restore. Nothing changed: ${redactText(error)}`);
      }
      if (beforeMutation.length) {
        try {
          finishClaudeLiveAuthTransaction(journal, 'rolled-back');
        } catch {
          /* the protected journal remains recoverable */
        }
        throw new Error(`A Claude process appeared while staging the restore (process ${beforeMutation.map((item) => item.pid).join(', ')}). Nothing changed.`);
      }

      try {
        restoreFromBackupUnlocked(dir);
        assertLiveMatchesBackup(dir);
        finishClaudeLiveAuthTransaction(journal, 'committed');
      } catch (error) {
        let rollingBack = journal;
        try {
          rollingBack = transitionClaudeLiveAuthJournal(journal, 'rolling-back');
          const beforeRollback = processInventory();
          if (beforeRollback.length) {
            throw new Error(`Automatic rollback was deferred because Claude appeared (process ${beforeRollback.map((item) => item.pid).join(', ')}).`);
          }
          if (!journalRollbackBackupMatches(rollingBack)) {
            throw new Error('Automatic rollback backup no longer matches the manifest generation anchored by the live-auth journal.');
          }
          restoreFromBackupUnlocked(rollbackDir);
          assertLiveMatchesBackup(rollbackDir);
          finishClaudeLiveAuthTransaction(rollingBack, 'rolled-back');
        } catch (rollbackError) {
          markManualRecovery(rollbackDir, 'Claude manual restore and rollback both failed or rollback was deferred because Claude became active.');
          throw new AggregateError(
            [error, rollbackError],
            `Claude restore failed and automatic rollback also failed. Manual recovery is required from ${rollbackDir}.`,
          );
        }
        throw new Error(`Claude restore failed; the previous live authentication was restored: ${String((error as Error).message ?? error)}`, {
          cause: error,
        });
      }
    });
  } finally {
    try {
      releaseSelectedBackup();
    } catch (error) {
      logger.warn('Claude selected-backup retention lease could not be released', { dir, error: String(error) });
    }
  }
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
  if (!hasRefreshableOauth(claudeAiOauth)) {
    throw new Error('Refusing to write invalid Claude Code OAuth credentials.');
  }
  const t = readCredentialsText();
  let obj: Record<string, unknown> = {};
  if (t) {
    try {
      obj = JSON.parse(t);
    } catch {
      throw new Error('Refusing to overwrite malformed live Claude credentials. Restore or repair the file first.');
    }
  }
  obj.claudeAiOauth = claudeAiOauth; // preserves mcpOAuth and any other keys
  const normalizedOrganization = organizationUuidRoot?.trim() || undefined;
  if (normalizedOrganization !== undefined) obj.organizationUuid = normalizedOrganization;
  else delete obj.organizationUuid;
  writeCredentialsText(JSON.stringify(obj, null, 2) + '\n');
}

function writeClaudeJson(oauthAccount: OauthAccount, userID?: string): void {
  const p = claudeJsonPath();
  let text = readText(p);
  if (text == null) text = '{}\n';
  const fmt = fmtFor(text);
  text = applyEdits(text, modify(text, ['oauthAccount'], oauthAccount, { formattingOptions: fmt }));
  // userID is account-scoped. jsonc-parser treats `undefined` as deletion, preventing
  // a legacy/raw target from inheriting the outgoing account's identity.
  text = applyEdits(text, modify(text, ['userID'], userID, { formattingOptions: fmt }));
  atomicWriteFile(p, text);
}

/**
 * Sync a rotated `claudeAiOauth` back into the LIVE credentials file, preserving
 * mcpOAuth and other keys. Used when we refresh the ACTIVE account's token so the
 * running Claude session doesn't end up holding an invalidated refresh token.
 */
export function updateLiveCredentials(claudeAiOauth: ClaudeAiOauth, organizationUuidRoot?: string): void {
  if (CREDS_IN_KEYCHAIN) {
    throw new Error('Refusing to rotate Claude credentials through an argv-based macOS Keychain command.');
  }
  withFileLockSync('claude-live-auth', () => {
    assertNoInterruptedClaudeLiveAuthTransaction();
    if (!hasRefreshableOauth(claudeAiOauth)) {
      throw new Error('Refusing to sync invalid Claude Code OAuth credentials.');
    }
    const t = readCredentialsText();
    let obj: Record<string, unknown> = {};
    if (t) {
      try {
        obj = JSON.parse(t);
      } catch {
        throw new Error('Refusing to replace malformed live Claude credentials during token sync.');
      }
    }
    obj.claudeAiOauth = claudeAiOauth;
    const normalizedOrganization = organizationUuidRoot?.trim() || undefined;
    if (normalizedOrganization !== undefined) obj.organizationUuid = normalizedOrganization;
    else delete obj.organizationUuid;
    writeCredentialsText(JSON.stringify(obj, null, 2) + '\n');
    logger.info('synced rotated token to live credentials');
  });
}

/** Both files must still parse as JSON after a write. */
export function validateLiveFiles(): boolean {
  const c = readCredentialsText();
  const j = readText(claudeJsonPath());
  try {
    if (c) JSON.parse(c);
    if (j) parseJsoncDocument(j);
    return true;
  } catch {
    return false;
  }
}

function liveAccountMatchesProfile(profile: Profile): boolean {
  if (!hasCliAuth(profile)) return false;
  // The caller is validating its own in-progress journaled transaction, so it must
  // inspect the raw pair rather than the public midpoint guard.
  const live = readLiveAccountRawUnlocked();
  if (!hasRefreshableOauth(live.claudeAiOauth) || !live.oauthAccount) return false;
  if (live.claudeAiOauth.accessToken !== profile.claudeAiOauth.accessToken
    || live.claudeAiOauth.refreshToken !== profile.claudeAiOauth.refreshToken
    || live.oauthAccount.accountUuid !== profile.oauthAccount.accountUuid) return false;
  if ((live.oauthAccount.organizationUuid || undefined) !== (profile.oauthAccount.organizationUuid || undefined)) return false;
  const expectedRoot = profile.organizationUuidRoot?.trim() || profile.organizationUuid?.trim() || undefined;
  if ((live.organizationUuidRoot?.trim() || undefined) !== expectedRoot) return false;
  if (live.userID !== profile.userID) return false;
  return true;
}

export interface ApplyResult {
  ok: boolean;
  backupDir?: string;
  error?: string;
  rollback?: 'not-needed' | 'succeeded' | 'failed';
  dryRun?: DryRunReport;
}

export interface DryRunReport {
  credentials: { willSet: string[]; preserved: string[] };
  claudeJson: { willSet: string[]; preserved: string[]; stillValid: boolean };
}

function topLevelKeys(text: string | null, format: 'json' | 'jsonc' = 'json'): string[] {
  if (!text) return [];
  try {
    const value = format === 'jsonc' ? parseJsoncDocument(text) : JSON.parse(text);
    return value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : [];
  } catch {
    return [];
  }
}

export function dryRunApply(p: Profile): DryRunReport {
  assertNoInterruptedClaudeLiveAuthTransaction();
  if (!hasCliAuth(p)) {
    return {
      credentials: { willSet: [], preserved: [] },
      claudeJson: { willSet: [], preserved: [], stillValid: true },
    };
  }
  const orgRoot = p.organizationUuidRoot ?? p.organizationUuid;

  const credKeys = topLevelKeys(readCredentialsText());
  const credWillSet = ['claudeAiOauth', ...(orgRoot !== undefined ? ['organizationUuid'] : [])];
  const credPreserved = credKeys.filter((k) => !credWillSet.includes(k));

  const cjText = readText(claudeJsonPath());
  const cjKeys = topLevelKeys(cjText, 'jsonc');
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
    parseJsoncDocument(text);
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
export function applyProfile(
  p: Profile,
  opts: { dryRun?: boolean; processInventory?: () => ProcInfo[] } = {},
): ApplyResult {
  if (!hasCliAuth(p)) {
    return { ok: false, error: 'This profile has no Claude Code credentials captured.' };
  }
  if (p.needsReauth) {
    return { ok: false, error: 'This profile needs re-authentication before it can be switched in.' };
  }
  if (CREDS_IN_KEYCHAIN && !opts.dryRun) {
    return {
      ok: false,
      rollback: 'not-needed',
      error: 'Automated Claude switching is disabled on macOS until credentials can be written through Security.framework without exposing tokens in process arguments. Authenticate the live account directly with the official "claude auth login" command.',
    };
  }
  if (opts.dryRun) {
    return { ok: true, rollback: 'not-needed', dryRun: dryRunApply(p) };
  }
  const processInventory = opts.processInventory ?? findClaudeProcesses;
  return withFileLockSync('claude-live-auth', () => {
    try {
      assertNoInterruptedClaudeLiveAuthTransaction();
    } catch (error) {
      return { ok: false, rollback: 'not-needed', error: redactText(error) };
    }
    let running: ProcInfo[];
    try {
      running = processInventory();
    } catch (error) {
      return { ok: false, rollback: 'not-needed', error: `Claude process safety could not be verified: ${redactText(error)}` };
    }
    if (running.length) {
      return {
        ok: false,
        rollback: 'not-needed',
        error: `Close Claude before switching authentication (process ${running.map((item) => item.pid).join(', ')}). No live credentials were changed.`,
      };
    }
    let backupDir: string;
    try {
      backupDir = backupLive({ protectUntilTransactionEnds: true });
    } catch (error) {
      logger.error('live Claude backup failed; switch aborted before writes', error, { profile: p.email });
      return {
        ok: false,
        rollback: 'not-needed',
        error: `Could not prove and back up the current Claude login: ${(error as Error).message}`,
      };
    }
    let journal: ClaudeLiveAuthJournal;
    try {
      journal = beginClaudeLiveAuthTransaction('apply-profile', backupDir, p.id);
      journal = transitionClaudeLiveAuthJournal(journal, 'applying');
    } catch (error) {
      if (!inspectClaudeLiveAuthRecovery().pending) releaseBackupProtectionSafely(backupDir);
      return {
        ok: false,
        backupDir,
        rollback: 'not-needed',
        error: `Could not create the durable Claude live-auth journal. No live credentials were changed: ${redactText(error)}`,
      };
    }
    try {
      running = processInventory();
    } catch (error) {
      try {
        finishClaudeLiveAuthTransaction(journal, 'rolled-back');
      } catch {
        /* the protected journal remains recoverable */
      }
      return {
        ok: false,
        backupDir,
        rollback: 'not-needed',
        error: `Claude process safety could not be verified after staging the switch. No live credentials were changed: ${redactText(error)}`,
      };
    }
    if (running.length) {
      try {
        finishClaudeLiveAuthTransaction(journal, 'rolled-back');
      } catch {
        /* the protected journal remains recoverable */
      }
      return {
        ok: false,
        backupDir,
        rollback: 'not-needed',
        error: `A Claude process appeared while staging the switch (process ${running.map((item) => item.pid).join(', ')}). No live credentials were changed.`,
      };
    }
    try {
      writeCredentials(p.claudeAiOauth, p.organizationUuidRoot?.trim() || p.organizationUuid?.trim() || undefined);
      writeClaudeJson(p.oauthAccount, p.userID);
      if (!validateLiveFiles() || !liveAccountMatchesProfile(p)) {
        throw new Error('Validation failed after writing the target Claude login: the live identity or rotating credential chain did not match the selected profile.');
      }
      finishClaudeLiveAuthTransaction(journal, 'committed');
      logger.info('switched account', { to: p.email, subscription: p.subscriptionType, backupDir });
      return { ok: true, backupDir, rollback: 'not-needed' };
    } catch (e) {
      let rollingBack = journal;
      try {
        rollingBack = transitionClaudeLiveAuthJournal(journal, 'rolling-back');
        running = processInventory();
        if (running.length) {
          throw new Error(`Automatic rollback was deferred because Claude appeared (process ${running.map((item) => item.pid).join(', ')}).`);
        }
        if (!journalRollbackBackupMatches(rollingBack)) {
          throw new Error('Automatic rollback backup no longer matches the manifest generation anchored by the live-auth journal.');
        }
        restoreFromBackupUnlocked(backupDir);
        assertLiveMatchesBackup(backupDir);
        finishClaudeLiveAuthTransaction(rollingBack, 'rolled-back');
      } catch (rollbackError) {
        try {
          markManualRecovery(backupDir, 'Claude live-auth rollback failed or was deferred; inspect the live-auth journal before manual restore.');
        } catch (markerError) {
          logger.error('apply, rollback, and manual-recovery marker all failed', markerError, { profile: p.email, backupDir });
          return {
            ok: false,
            backupDir,
            rollback: 'failed',
            error: `${redactText(e)}; rollback failed: ${redactText(rollbackError)}; recovery marker failed: ${redactText(markerError)}`,
          };
        }
        logger.error('apply and rollback both failed', rollbackError, { profile: p.email, backupDir });
        return {
          ok: false,
          backupDir,
          rollback: 'failed',
          error: `${redactText(e)}; rollback also failed: ${redactText(rollbackError)}`,
        };
      }
      logger.error('apply failed, rolled back', e, { profile: p.email });
      return { ok: false, backupDir, rollback: 'succeeded', error: redactText(e) };
    }
  });
}
