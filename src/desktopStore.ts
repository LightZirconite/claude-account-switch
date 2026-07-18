// Claude Desktop stores its session in an opaque Electron/Chromium bundle.  A bundle
// is useful only on the same OS user/machine, but it must still receive the same
// durability guarantees as a credential file: fail-closed validation, atomic publish,
// and an interruptible live swap with a durable rollback journal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  backupsDir,
  desktopStoreDir,
  desktopUserDataDir,
  DESKTOP_BUNDLE_ENTRIES,
  ensureDataDirs,
} from './paths';
import { logger, redactText } from './logger';
import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import {
  BACKUP_RETENTION_PROTECTION_MARKER,
  markManualRecovery,
  pruneManagedBackupDirs,
} from './retention';
import { withFileLockSync } from './locks';
import { findClaudeProcesses } from './processes';

const PROFILE_BUNDLE_KIND = 'claude-codex-account-switch/claude-desktop-bundle';
const LIVE_BACKUP_KIND = 'claude-codex-account-switch/claude-desktop-live-backup';
const LIVE_TRANSACTION_KIND = 'claude-codex-account-switch/claude-desktop-live-transaction';
const CAPTURE_TRANSACTION_KIND = 'claude-codex-account-switch/claude-desktop-capture-transaction';
const BUNDLE_MANIFEST = '.bundle.json';
const TRANSACTION_MANIFEST = 'transaction.json';
const TRANSACTION_VERSION = 1;
const BUNDLE_VERSION = 2;
const DESKTOP_SCOPE_VERSION = 1;

type BundleEntry = (typeof DESKTOP_BUNDLE_ENTRIES)[number];
type BundleKind = typeof PROFILE_BUNDLE_KIND | typeof LIVE_BACKUP_KIND;

interface EntryFingerprint {
  type: 'file' | 'directory';
  sha256: string;
  bytes: number;
  files: number;
  directories: number;
}

export interface DesktopBundleManifest {
  kind: BundleKind;
  version: typeof BUNDLE_VERSION;
  complete: true;
  capturedAt: number;
  scopeVersion: typeof DESKTOP_SCOPE_VERSION;
  profileId?: string;
  transactionId?: string;
  entries: BundleEntry[];
  fingerprints: Record<string, EntryFingerprint>;
  /** Complete, canonical mutation scope for this bundle format/generation. */
  scopeEntries: BundleEntry[];
  /** Entries in scope that were explicitly observed absent at capture time. */
  absentEntries: BundleEntry[];
  /** Detects accidental edits to entries, absences, fingerprints, or identity metadata. */
  contentSha256: string;
}

type LiveTransactionState = 'prepared' | 'applying' | 'rolling-back' | 'committed' | 'rolled-back' | 'manual-recovery';

interface LiveTransactionJournal {
  kind: typeof LIVE_TRANSACTION_KIND;
  version: typeof TRANSACTION_VERSION;
  transactionId: string;
  state: LiveTransactionState;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  sourceDescription: string;
  affectedEntries: BundleEntry[];
  backupManifestSha256: string;
}

type CaptureTransactionState = 'prepared' | 'publishing' | 'committed' | 'rolled-back' | 'manual-recovery';

interface CaptureTransactionJournal {
  kind: typeof CAPTURE_TRANSACTION_KIND;
  version: typeof TRANSACTION_VERSION;
  transactionId: string;
  state: CaptureTransactionState;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  profileId: string;
  hadPrevious: boolean;
  candidateManifestSha256: string;
}

type DesktopTransactionJournal = LiveTransactionJournal | CaptureTransactionJournal;

export interface DesktopRecoveryInspection {
  livePending: number;
  capturePending: number;
  damaged: number;
}

export interface DesktopRecoveryResult {
  recoveredLive: number;
  recoveredCaptures: number;
}

export interface DesktopOperationOptions {
  /** Test seam; production defaults to a fresh OS process inventory. */
  assertClaudeClosed?: () => void;
  /** Deterministic race seam used only by filesystem transaction tests. */
  afterCandidateCopiedForTest?: () => void;
}

class DesktopProcessGuardError extends Error {
  constructor(error: unknown) {
    super(redactText(error));
    this.name = 'DesktopProcessGuardError';
  }
}

function assertClaudeClosedByProcessInventory(): void {
  const running = findClaudeProcesses();
  if (running.length) {
    throw new Error(
      `Claude is still running (${running.map((process) => process.pid).join(', ')}). Close it normally before changing Desktop session files.`,
    );
  }
}

function closedGuard(options: DesktopOperationOptions): () => void {
  const guard = options.assertClaudeClosed ?? assertClaudeClosedByProcessInventory;
  return () => {
    try {
      guard();
    } catch (error) {
      throw error instanceof DesktopProcessGuardError ? error : new DesktopProcessGuardError(error);
    }
  };
}

class DesktopLiveTransactionError extends Error {
  constructor(
    message: string,
    readonly rollback: 'not-needed' | 'succeeded' | 'deferred' | 'failed',
    readonly backupDir?: string,
    readonly transactionDir?: string,
  ) {
    super(message);
    this.name = 'DesktopLiveTransactionError';
  }
}

function transactionRoot(): string {
  return path.join(backupsDir(), 'desktop-transactions');
}

function transactionDirs(): string[] {
  try {
    return fs.readdirSync(transactionRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(transactionRoot(), entry.name));
  } catch {
    return [];
  }
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function manifestHash(dir: string): string {
  return sha256(fs.readFileSync(path.join(dir, BUNDLE_MANIFEST)));
}

function manifestContentHash(manifest: Omit<DesktopBundleManifest, 'contentSha256'> | DesktopBundleManifest): string {
  const { contentSha256: _contentSha256, ...content } = manifest as DesktopBundleManifest;
  return sha256(JSON.stringify(content));
}

function normalizedRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashFileContents(target: string): { sha256: string; bytes: number } {
  const fd = fs.openSync(target, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    const final = fs.fstatSync(fd);
    if (!final.isFile() || final.size !== bytes) throw new Error(`Desktop file changed while it was being hashed: ${target}`);
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Hash a file or a whole directory tree deterministically. Symlinks and special files
 * are rejected: following them could copy secrets outside the Desktop data root, while
 * hashing the link itself would not prove what Electron later opens.
 */
function fingerprintEntry(target: string): EntryFingerprint {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`Desktop bundle contains a symbolic link: ${target}`);
  if (stat.isFile()) {
    const content = hashFileContents(target);
    return {
      type: 'file',
      sha256: content.sha256,
      bytes: content.bytes,
      files: 1,
      directories: 0,
    };
  }
  if (!stat.isDirectory()) throw new Error(`Desktop bundle contains an unsupported filesystem entry: ${target}`);

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let files = 0;
  let directories = 0;
  const walk = (dir: string, relative: string): void => {
    directories++;
    hash.update(`D\0${normalizedRelative(relative)}\0`);
    const children = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name));
    for (const child of children) {
      const childPath = path.join(dir, child.name);
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const childStat = fs.lstatSync(childPath);
      if (childStat.isSymbolicLink()) throw new Error(`Desktop bundle contains a symbolic link: ${childPath}`);
      if (childStat.isDirectory()) {
        walk(childPath, childRelative);
        continue;
      }
      if (!childStat.isFile()) throw new Error(`Desktop bundle contains an unsupported filesystem entry: ${childPath}`);
      const content = hashFileContents(childPath);
      const fileHash = content.sha256;
      bytes += content.bytes;
      files++;
      hash.update(`F\0${normalizedRelative(childRelative)}\0${content.bytes}\0${fileHash}\0`);
    }
  };
  walk(target, '');
  return { type: 'directory', sha256: hash.digest('hex'), bytes, files, directories };
}

function sameFingerprint(a: EntryFingerprint, b: EntryFingerprint): boolean {
  return a.type === b.type
    && a.sha256 === b.sha256
    && a.bytes === b.bytes
    && a.files === b.files
    && a.directories === b.directories;
}

function isBundleEntry(value: unknown): value is BundleEntry {
  return typeof value === 'string' && DESKTOP_BUNDLE_ENTRIES.includes(value as BundleEntry);
}

function canonicalEntries(values: readonly BundleEntry[]): BundleEntry[] {
  const selected = new Set(values);
  return DESKTOP_BUNDLE_ENTRIES.filter((entry) => selected.has(entry));
}

function parseEntryList(value: unknown, field: string, allowEmpty: boolean): BundleEntry[] {
  if (!Array.isArray(value) || value.some((entry) => !isBundleEntry(entry))) {
    throw new Error(`Desktop bundle ${field} is invalid.`);
  }
  const entries = value as BundleEntry[];
  const canonical = canonicalEntries(entries);
  if (canonical.length !== entries.length || canonical.some((entry, index) => entry !== entries[index])) {
    throw new Error(`Desktop bundle ${field} must be unique and canonically ordered.`);
  }
  if (!allowEmpty && !entries.length) throw new Error(`Desktop bundle ${field} is empty.`);
  return entries;
}

function presentExpectedEntries(root: string): BundleEntry[] {
  return DESKTOP_BUNDLE_ENTRIES.filter((entry) => fs.existsSync(path.join(root, entry)));
}

function fingerprintMap(root: string, entries: readonly BundleEntry[]): Record<string, EntryFingerprint> {
  return Object.fromEntries(entries.map((entry) => [entry, fingerprintEntry(path.join(root, entry))]));
}

function validateFingerprintShape(value: unknown): value is EntryFingerprint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EntryFingerprint>;
  return (candidate.type === 'file' || candidate.type === 'directory')
    && typeof candidate.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.sha256)
    && Number.isSafeInteger(candidate.bytes) && candidate.bytes! >= 0
    && Number.isSafeInteger(candidate.files) && candidate.files! >= 0
    && Number.isSafeInteger(candidate.directories) && candidate.directories! >= 0;
}

function readAndValidateManifest(
  root: string,
  expectedKind: BundleKind,
  options: { requireExactPhysicalEntries?: boolean } = {},
): DesktopBundleManifest {
  const file = path.join(root, BUNDLE_MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Desktop session manifest is missing or unreadable (${redactText(error)}). Recapture this account before switching.`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('Desktop session manifest is invalid. Recapture this account before switching.');
  const manifest = raw as Partial<DesktopBundleManifest>;
  if (manifest.kind !== expectedKind || manifest.version !== BUNDLE_VERSION || manifest.complete !== true
    || manifest.scopeVersion !== DESKTOP_SCOPE_VERSION || !Number.isFinite(manifest.capturedAt)) {
    throw new Error('Desktop session manifest is legacy, incomplete, or invalid. Recapture this account before switching.');
  }
  const entries = parseEntryList(manifest.entries, 'entries', expectedKind === LIVE_BACKUP_KIND);
  if (typeof manifest.contentSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(manifest.contentSha256)
    || manifestContentHash(manifest as DesktopBundleManifest) !== manifest.contentSha256) {
    throw new Error('Desktop session manifest content integrity check failed. Recapture this account.');
  }
  if (expectedKind === PROFILE_BUNDLE_KIND && (typeof manifest.profileId !== 'string' || !manifest.profileId.trim())) {
    throw new Error('Desktop profile manifest has no profile identity.');
  }
  if (!manifest.fingerprints || typeof manifest.fingerprints !== 'object' || Array.isArray(manifest.fingerprints)) {
    throw new Error('Desktop session manifest has no fingerprint map.');
  }
  const fingerprintKeys = Object.keys(manifest.fingerprints);
  if (fingerprintKeys.length !== entries.length || entries.some((entry) => !validateFingerprintShape(manifest.fingerprints![entry]))) {
    throw new Error('Desktop session manifest does not describe every captured entry.');
  }
  if (fingerprintKeys.some((entry) => !entries.includes(entry as BundleEntry))) {
    throw new Error('Desktop session manifest contains an unexpected fingerprint.');
  }
  for (const entry of entries) {
    const target = path.join(root, entry);
    if (!fs.existsSync(target)) {
      // A manifest is never allowed to turn an absent source entry into an implicit
      // delete request. The operation aborts before touching live Desktop data.
      throw new Error(`Desktop session entry declared by the manifest is absent: ${entry}`);
    }
    const actual = fingerprintEntry(target);
    if (!sameFingerprint(actual, manifest.fingerprints[entry])) {
      throw new Error(`Desktop session integrity check failed for ${entry}. Recapture this account.`);
    }
  }
  if (options.requireExactPhysicalEntries !== false) {
    const present = presentExpectedEntries(root);
    if (present.length !== entries.length || present.some((entry, index) => entry !== entries[index])) {
      throw new Error('Desktop session folder and manifest entry list do not match.');
    }
  }

  const scope = parseEntryList(manifest.scopeEntries, 'scopeEntries', false);
  const absent = parseEntryList(manifest.absentEntries, 'absentEntries', true);
  const entrySet = new Set(entries);
  if (absent.some((entry) => entrySet.has(entry))) throw new Error('Desktop manifest marks an entry both present and absent.');
  const union = canonicalEntries([...entries, ...absent]);
  if (union.length !== scope.length || union.some((entry, index) => entry !== scope[index])) {
    throw new Error('Desktop manifest does not attest its complete transaction scope.');
  }
  if (expectedKind === PROFILE_BUNDLE_KIND
    && (scope.length !== DESKTOP_BUNDLE_ENTRIES.length
      || scope.some((entry, index) => entry !== DESKTOP_BUNDLE_ENTRIES[index]))) {
    throw new Error('Desktop profile manifest does not cover the complete versioned session scope.');
  }
  manifest.entries = entries;
  manifest.scopeEntries = scope;
  manifest.absentEntries = absent;
  return manifest as DesktopBundleManifest;
}

/** Read-only validation used by metadata reconstruction and diagnostics. */
export function validateDesktopProfileSnapshot(snapshotDir: string, expectedProfileId?: string): DesktopBundleManifest {
  const manifest = readAndValidateManifest(snapshotDir, PROFILE_BUNDLE_KIND);
  if (expectedProfileId !== undefined && manifest.profileId !== expectedProfileId) {
    throw new Error('Desktop profile manifest identity does not match its storage directory.');
  }
  return manifest;
}

function assertEntryFingerprints(root: string, manifest: DesktopBundleManifest): void {
  for (const entry of manifest.entries) {
    const target = path.join(root, entry);
    if (!fs.existsSync(target)) throw new Error(`Desktop post-write validation found ${entry} absent.`);
    if (!sameFingerprint(fingerprintEntry(target), manifest.fingerprints[entry])) {
      throw new Error(`Desktop post-write validation failed for ${entry}.`);
    }
  }
}

function copyEntries(sourceRoot: string, destinationRoot: string, entries: readonly BundleEntry[]): void {
  ensurePrivateDir(destinationRoot);
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry);
    if (!fs.existsSync(source)) throw new Error(`Desktop source entry disappeared during copy: ${entry}`);
    const sourceFingerprint = fingerprintEntry(source);
    const destination = path.join(destinationRoot, entry);
    ensurePrivateDir(path.dirname(destination));
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const copiedFingerprint = fingerprintEntry(destination);
    if (!sameFingerprint(sourceFingerprint, copiedFingerprint)) {
      throw new Error(`Desktop entry changed while it was being captured: ${entry}`);
    }
  }
}

function writeBundleManifest(root: string, manifest: DesktopBundleManifest): string {
  manifest.contentSha256 = manifestContentHash(manifest);
  atomicWriteFile(path.join(root, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestHash(root);
}

function createProfileCandidate(
  sourceRoot: string,
  candidateRoot: string,
  profileId: string,
  afterCandidateCopiedForTest?: () => void,
): string {
  const entries = presentExpectedEntries(sourceRoot);
  if (!entries.length) throw new Error('Claude Desktop contains none of the expected session entries.');
  copyEntries(sourceRoot, candidateRoot, entries);
  const manifest: DesktopBundleManifest = {
    kind: PROFILE_BUNDLE_KIND,
    version: BUNDLE_VERSION,
    complete: true,
    capturedAt: Date.now(),
    scopeVersion: DESKTOP_SCOPE_VERSION,
    profileId,
    entries,
    fingerprints: fingerprintMap(candidateRoot, entries),
    scopeEntries: [...DESKTOP_BUNDLE_ENTRIES],
    absentEntries: DESKTOP_BUNDLE_ENTRIES.filter((entry) => !entries.includes(entry)),
    contentSha256: '',
  };
  const hash = writeBundleManifest(candidateRoot, manifest);
  readAndValidateManifest(candidateRoot, PROFILE_BUNDLE_KIND);
  afterCandidateCopiedForTest?.();
  // The candidate alone being internally coherent is insufficient: it could combine
  // generations if Desktop changed an entry already copied, or created an entry that
  // was initially absent. Re-prove the complete live scope against the candidate.
  assertEntryFingerprints(sourceRoot, manifest);
  for (const entry of manifest.absentEntries) {
    if (fs.existsSync(path.join(sourceRoot, entry))) {
      throw new Error(`Desktop live entry appeared while the profile snapshot was captured: ${entry}`);
    }
  }
  return hash;
}

function createLiveBackup(liveRoot: string, backupRoot: string, transactionId: string, scope: readonly BundleEntry[]): string {
  const entries = canonicalEntries(scope.filter((entry) => fs.existsSync(path.join(liveRoot, entry))));
  const absentEntries = canonicalEntries(scope.filter((entry) => !fs.existsSync(path.join(liveRoot, entry))));
  copyEntries(liveRoot, backupRoot, entries);
  const manifest: DesktopBundleManifest = {
    kind: LIVE_BACKUP_KIND,
    version: BUNDLE_VERSION,
    complete: true,
    capturedAt: Date.now(),
    scopeVersion: DESKTOP_SCOPE_VERSION,
    transactionId,
    entries,
    fingerprints: fingerprintMap(backupRoot, entries),
    scopeEntries: canonicalEntries(scope),
    absentEntries,
    contentSha256: '',
  };
  const hash = writeBundleManifest(backupRoot, manifest);
  readAndValidateManifest(backupRoot, LIVE_BACKUP_KIND);
  // Re-read the live side after copying. If Desktop restarted or another writer
  // changed any scoped entry, this backup is not an exact rollback point and the
  // transaction must stop before its journal can enter the applying state.
  assertEntryFingerprints(liveRoot, manifest);
  for (const entry of absentEntries) {
    if (fs.existsSync(path.join(liveRoot, entry))) {
      throw new Error(`Desktop live entry appeared while its rollback backup was created: ${entry}`);
    }
  }
  atomicWriteFile(path.join(backupRoot, BACKUP_RETENTION_PROTECTION_MARKER), `${transactionId}\n`);
  return hash;
}

function writeJournal(txDir: string, journal: DesktopTransactionJournal): void {
  atomicWriteFile(path.join(txDir, TRANSACTION_MANIFEST), `${JSON.stringify(journal, null, 2)}\n`);
}

function updateLiveJournal(txDir: string, journal: LiveTransactionJournal, state: LiveTransactionState): void {
  journal.state = state;
  journal.complete = state === 'committed' || state === 'rolled-back';
  journal.updatedAt = Date.now();
  writeJournal(txDir, journal);
}

function updateCaptureJournal(txDir: string, journal: CaptureTransactionJournal, state: CaptureTransactionState): void {
  journal.state = state;
  journal.complete = state === 'committed' || state === 'rolled-back';
  journal.updatedAt = Date.now();
  writeJournal(txDir, journal);
}

function readJournal(txDir: string): DesktopTransactionJournal | null {
  const file = path.join(txDir, TRANSACTION_MANIFEST);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DesktopTransactionJournal>;
    if ((value.kind !== LIVE_TRANSACTION_KIND && value.kind !== CAPTURE_TRANSACTION_KIND)
      || value.version !== TRANSACTION_VERSION
      || typeof value.transactionId !== 'string'
      || path.basename(txDir) !== value.transactionId
      || !Number.isFinite(value.createdAt)
      || !Number.isFinite(value.updatedAt)) return null;
    return value as DesktopTransactionJournal;
  } catch {
    return null;
  }
}

function isLiveJournal(value: DesktopTransactionJournal): value is LiveTransactionJournal {
  return value.kind === LIVE_TRANSACTION_KIND;
}

function validateLiveJournal(txDir: string, journal: LiveTransactionJournal): DesktopBundleManifest {
  validateLiveJournalShape(journal);
  const backupDir = path.join(txDir, 'before');
  const manifest = readAndValidateManifest(backupDir, LIVE_BACKUP_KIND);
  if (manifestHash(backupDir) !== journal.backupManifestSha256) throw new Error('Desktop rollback manifest changed after transaction preparation.');
  if (manifest.scopeEntries!.length !== journal.affectedEntries.length
    || manifest.scopeEntries!.some((entry, index) => entry !== journal.affectedEntries[index])) {
    throw new Error('Desktop transaction scope does not match its rollback backup.');
  }
  return manifest;
}

function validateLiveJournalShape(journal: LiveTransactionJournal): void {
  const allowedStates: LiveTransactionState[] = ['prepared', 'applying', 'rolling-back', 'committed', 'rolled-back', 'manual-recovery'];
  if (!allowedStates.includes(journal.state)
    || typeof journal.sourceDescription !== 'string'
    || typeof journal.backupManifestSha256 !== 'string') throw new Error('Desktop live transaction journal is invalid.');
  const affected = parseEntryList(journal.affectedEntries, 'affectedEntries', false);
  journal.affectedEntries = affected;
}

function ensureLiveRoot(): string {
  const live = desktopUserDataDir();
  if (!live) throw new Error('Claude Desktop data folder not found on this machine.');
  return live;
}

function stageManifestEntries(sourceRoot: string, stageRoot: string, manifest: DesktopBundleManifest): void {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  copyEntries(sourceRoot, stageRoot, manifest.entries);
  assertEntryFingerprints(stageRoot, manifest);
}

function applyStagedPlan(
  liveRoot: string,
  stageRoot: string,
  displacedRoot: string,
  affectedEntries: readonly BundleEntry[],
  sourceEntries: ReadonlySet<BundleEntry>,
): void {
  ensurePrivateDir(displacedRoot);
  for (const entry of affectedEntries) {
    const destination = path.join(liveRoot, entry);
    const displaced = path.join(displacedRoot, entry);
    if (fs.existsSync(destination)) {
      ensurePrivateDir(path.dirname(displaced));
      fs.renameSync(destination, displaced);
    }
    if (sourceEntries.has(entry)) {
      const staged = path.join(stageRoot, entry);
      if (!fs.existsSync(staged)) throw new Error(`Staged Desktop entry is absent: ${entry}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(staged, destination);
    }
  }
}

/** Idempotently restore the exact pre-transaction state from the protected copy. */
function restoreLiveFromBackup(
  txDir: string,
  journal: LiveTransactionJournal,
  backup: DesktopBundleManifest,
  assertClaudeClosed: () => void,
): void {
  const liveRoot = ensureLiveRoot();
  const backupRoot = path.join(txDir, 'before');
  const stageRoot = path.join(txDir, `recovery-stage-${process.pid}`);
  try {
    stageManifestEntries(backupRoot, stageRoot, backup);
    assertClaudeClosed();
    const present = new Set(backup.entries);
    for (const entry of journal.affectedEntries) {
      const destination = path.join(liveRoot, entry);
      fs.rmSync(destination, { recursive: true, force: true });
      if (present.has(entry)) {
        const staged = path.join(stageRoot, entry);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(staged, destination);
      }
    }
    assertEntryFingerprints(liveRoot, backup);
    for (const entry of backup.absentEntries ?? []) {
      if (fs.existsSync(path.join(liveRoot, entry))) throw new Error(`Desktop rollback could not restore absence of ${entry}.`);
    }
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

function releaseBackupProtection(txDir: string): void {
  fs.rmSync(path.join(txDir, 'before', BACKUP_RETENTION_PROTECTION_MARKER), { force: true });
  fs.rmSync(path.join(txDir, BACKUP_RETENTION_PROTECTION_MARKER), { force: true });
}

function markTransactionManual(txDir: string, detail: string): void {
  // Keep the protection marker in place even if writing either manual-recovery marker
  // fails. Generic retention treats the protection marker as authoritative.
  const failures: unknown[] = [];
  for (const dir of [txDir, path.join(txDir, 'before')]) {
    try {
      markManualRecovery(dir, detail);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `${detail} Recovery evidence could not be fully marked.`);
}

function rollbackLiveTransaction(
  txDir: string,
  journal: LiveTransactionJournal,
  assertClaudeClosed: () => void,
  originalError?: unknown,
): void {
  try {
    const backup = validateLiveJournal(txDir, journal);
    updateLiveJournal(txDir, journal, 'rolling-back');
    restoreLiveFromBackup(txDir, journal, backup, assertClaudeClosed);
    updateLiveJournal(txDir, journal, 'rolled-back');
    releaseBackupProtection(txDir);
  } catch (rollbackError) {
    if (rollbackError instanceof DesktopProcessGuardError) {
      // Leave rolling-back + the protection marker durable. The next startup can
      // retry automatically once Claude is actually closed.
      throw rollbackError;
    }
    try {
      updateLiveJournal(txDir, journal, 'manual-recovery');
    } catch {
      /* the existing incomplete journal remains fail-closed */
    }
    markTransactionManual(txDir, 'Claude Desktop rollback failed; protected transaction backup retained.');
    throw new Error(
      originalError
        ? `${redactText(originalError)}; Desktop rollback also failed: ${redactText(rollbackError)}`
        : `Desktop transaction recovery failed: ${redactText(rollbackError)}`,
    );
  }
}

function executeLiveTransaction(
  sourceRoot: string,
  sourceManifest: DesktopBundleManifest,
  removeEntries: readonly BundleEntry[],
  sourceDescription: string,
  assertClaudeClosed: () => void,
): { backupDir: string; transactionDir: string } {
  assertClaudeClosed();
  const liveRoot = ensureLiveRoot();
  const affectedEntries = canonicalEntries([...sourceManifest.entries, ...removeEntries]);
  if (!affectedEntries.length) throw new Error('Desktop transaction has an empty mutation scope.');
  const transactionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const txDir = path.join(transactionRoot(), transactionId);
  const beforeDir = path.join(txDir, 'before');
  const stageDir = path.join(txDir, 'stage');
  const displacedDir = path.join(txDir, 'displaced');
  ensurePrivateDir(txDir);
  atomicWriteFile(path.join(txDir, BACKUP_RETENTION_PROTECTION_MARKER), `${transactionId}\n`);

  let journal: LiveTransactionJournal | null = null;
  try {
    stageManifestEntries(sourceRoot, stageDir, sourceManifest);
    const backupManifestSha256 = createLiveBackup(liveRoot, beforeDir, transactionId, affectedEntries);
    journal = {
      kind: LIVE_TRANSACTION_KIND,
      version: TRANSACTION_VERSION,
      transactionId,
      state: 'prepared',
      complete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceDescription,
      affectedEntries,
      backupManifestSha256,
    };
    writeJournal(txDir, journal);
    // Staging and hashing may take time for IndexedDB/Local Storage. Narrow the
    // process TOCTOU window by checking again immediately before declaring/applying
    // the first live rename.
    assertClaudeClosed();
    updateLiveJournal(txDir, journal, 'applying');
    applyStagedPlan(liveRoot, stageDir, displacedDir, affectedEntries, new Set(sourceManifest.entries));
    assertEntryFingerprints(liveRoot, sourceManifest);
    for (const entry of removeEntries) {
      if (fs.existsSync(path.join(liveRoot, entry))) throw new Error(`Desktop transaction could not restore absence of ${entry}.`);
    }
    updateLiveJournal(txDir, journal, 'committed');
    releaseBackupProtection(txDir);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(displacedDir, { recursive: true, force: true });
    // The caller may still need this exact backup if its outer CLI/metadata commit
    // fails. Old completed transactions were pruned before this operation; never make
    // the just-returned rollback path eligible in the same call.
    return { backupDir: beforeDir, transactionDir: txDir };
  } catch (error) {
    if (!journal) {
      fs.rmSync(txDir, { recursive: true, force: true });
      throw new DesktopLiveTransactionError(redactText(error), 'not-needed');
    }
    if (journal.state === 'prepared') {
      updateLiveJournal(txDir, journal, 'rolled-back');
      releaseBackupProtection(txDir);
      throw new DesktopLiveTransactionError(redactText(error), 'not-needed', beforeDir, txDir);
    }
    try {
      rollbackLiveTransaction(txDir, journal, assertClaudeClosed, error);
    } catch (rollbackError) {
      throw new DesktopLiveTransactionError(
        redactText(rollbackError),
        rollbackError instanceof DesktopProcessGuardError ? 'deferred' : 'failed',
        beforeDir,
        txDir,
      );
    }
    throw new DesktopLiveTransactionError(redactText(error), 'succeeded', beforeDir, txDir);
  }
}

function validProfileId(profileId: string): string {
  if (!profileId || profileId.length > 200 || path.basename(profileId) !== profileId || profileId === '.' || profileId === '..') {
    throw new Error('Desktop profile id is not a safe path component.');
  }
  return profileId;
}

export function snapshotDirFor(profileId: string): string {
  return path.join(desktopStoreDir(), validProfileId(profileId));
}

function rollbackCaptureTransaction(txDir: string, journal: CaptureTransactionJournal): void {
  const destination = snapshotDirFor(journal.profileId);
  const previous = path.join(txDir, 'previous');
  try {
    if (journal.state === 'prepared') {
      // The durable state declaration precedes the first rename, so a prepared
      // capture has not modified the published profile directory.
    } else if (journal.hadPrevious) {
      if (fs.existsSync(previous)) {
        fs.rmSync(destination, { recursive: true, force: true });
        fs.renameSync(previous, destination);
      } else if (!fs.existsSync(path.join(txDir, 'candidate')) && fs.existsSync(destination)) {
        throw new Error('The prior Desktop profile snapshot is missing from an interrupted capture.');
      }
    } else {
      fs.rmSync(destination, { recursive: true, force: true });
    }
    updateCaptureJournal(txDir, journal, 'rolled-back');
    fs.rmSync(path.join(txDir, BACKUP_RETENTION_PROTECTION_MARKER), { force: true });
  } catch (error) {
    try {
      updateCaptureJournal(txDir, journal, 'manual-recovery');
    } catch {
      /* preserve the existing incomplete journal */
    }
    markTransactionManual(txDir, 'Claude Desktop profile recapture rollback failed; transaction retained.');
    throw error;
  }
}

function validateCaptureJournal(txDir: string, journal: CaptureTransactionJournal): void {
  const states: CaptureTransactionState[] = ['prepared', 'publishing', 'committed', 'rolled-back', 'manual-recovery'];
  validProfileId(journal.profileId);
  if (!states.includes(journal.state)
    || typeof journal.hadPrevious !== 'boolean'
    || typeof journal.candidateManifestSha256 !== 'string') throw new Error('Desktop capture transaction journal is invalid.');
  const candidate = path.join(txDir, 'candidate');
  if ((journal.state === 'prepared' || journal.state === 'publishing') && fs.existsSync(candidate)) {
    readAndValidateManifest(candidate, PROFILE_BUNDLE_KIND);
    if (manifestHash(candidate) !== journal.candidateManifestSha256) throw new Error('Desktop capture candidate changed after preparation.');
  }
}

function recoverTransactionsUnlocked(assertClaudeClosed = assertClaudeClosedByProcessInventory): DesktopRecoveryResult {
  let recoveredLive = 0;
  let recoveredCaptures = 0;
  for (const txDir of transactionDirs()) {
    const journal = readJournal(txDir);
    if (!journal) {
      if (fs.existsSync(path.join(txDir, TRANSACTION_MANIFEST))) {
        markTransactionManual(txDir, 'Unreadable Desktop transaction journal; inspect before continuing.');
        throw new Error(`Unreadable Desktop transaction journal retained at ${txDir}.`);
      }
      // No journal means the process stopped before declaring any mutation. Preserve
      // the candidate for diagnostics; it cannot require a live rollback.
      continue;
    }
    if (isLiveJournal(journal)) {
      validateLiveJournalShape(journal);
      if (journal.state === 'prepared') {
        validateLiveJournal(txDir, journal);
        updateLiveJournal(txDir, journal, 'rolled-back');
        releaseBackupProtection(txDir);
        recoveredLive++;
      } else if (journal.state === 'applying' || journal.state === 'rolling-back') {
        validateLiveJournal(txDir, journal);
        assertClaudeClosed();
        rollbackLiveTransaction(txDir, journal, assertClaudeClosed);
        recoveredLive++;
      } else if (journal.state === 'manual-recovery') {
        throw new Error(`Claude Desktop transaction requires manual recovery: ${txDir}`);
      } else {
        updateLiveJournal(txDir, journal, journal.state);
        releaseBackupProtection(txDir);
      }
      continue;
    }
    validateCaptureJournal(txDir, journal);
    if (journal.state === 'prepared' || journal.state === 'publishing') {
      rollbackCaptureTransaction(txDir, journal);
      recoveredCaptures++;
    } else if (journal.state === 'manual-recovery') {
      throw new Error(`Claude Desktop capture requires manual recovery: ${txDir}`);
    } else {
      updateCaptureJournal(txDir, journal, journal.state);
      fs.rmSync(path.join(txDir, BACKUP_RETENTION_PROTECTION_MARKER), { force: true });
    }
  }
  pruneManagedBackupDirs(transactionRoot(), 20);
  return { recoveredLive, recoveredCaptures };
}

export function inspectDesktopRecovery(): DesktopRecoveryInspection {
  const result: DesktopRecoveryInspection = { livePending: 0, capturePending: 0, damaged: 0 };
  for (const txDir of transactionDirs()) {
    const journal = readJournal(txDir);
    if (!journal) {
      if (fs.existsSync(path.join(txDir, TRANSACTION_MANIFEST))) result.damaged++;
      continue;
    }
    const terminal = journal.state === 'committed' || journal.state === 'rolled-back';
    if (typeof journal.complete !== 'boolean' || journal.complete !== terminal) {
      result.damaged++;
      continue;
    }
    if (terminal) continue;
    if (isLiveJournal(journal)) result.livePending++;
    else result.capturePending++;
  }
  return result;
}

/** Recover every declared but incomplete Desktop mutation before another operation. */
export function recoverDesktopTransactions(options: DesktopOperationOptions = {}): DesktopRecoveryResult {
  return withFileLockSync('claude-desktop-live', () => recoverTransactionsUnlocked(closedGuard(options)));
}

export function isDesktopInstalled(): boolean {
  return desktopUserDataDir() !== null;
}

/** Snapshot Desktop's live session into a rollback-safe, atomically published bundle. */
export function snapshotLiveDesktopInto(profileId: string, options: DesktopOperationOptions = {}): string {
  return withFileLockSync('claude-desktop-live', () => {
    const assertClaudeClosed = closedGuard(options);
    recoverTransactionsUnlocked(assertClaudeClosed);
    assertClaudeClosed();
    const live = ensureLiveRoot();
    ensureDataDirs();
    const safeId = validProfileId(profileId);
    const destination = snapshotDirFor(safeId);
    const transactionId = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
    const txDir = path.join(transactionRoot(), transactionId);
    const candidate = path.join(txDir, 'candidate');
    const previous = path.join(txDir, 'previous');
    ensurePrivateDir(txDir);
    atomicWriteFile(path.join(txDir, BACKUP_RETENTION_PROTECTION_MARKER), `${transactionId}\n`);
    let journal: CaptureTransactionJournal | null = null;
    try {
      const candidateManifestSha256 = createProfileCandidate(
        live,
        candidate,
        safeId,
        options.afterCandidateCopiedForTest,
      );
      journal = {
        kind: CAPTURE_TRANSACTION_KIND,
        version: TRANSACTION_VERSION,
        transactionId,
        state: 'prepared',
        complete: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        profileId: safeId,
        hadPrevious: fs.existsSync(destination),
        candidateManifestSha256,
      };
      writeJournal(txDir, journal);
      // The bundle can be large. Re-prove closure after hashing/copying and
      // immediately before the first publish rename.
      assertClaudeClosed();
      updateCaptureJournal(txDir, journal, 'publishing');
      if (journal.hadPrevious) fs.renameSync(destination, previous);
      ensurePrivateDir(path.dirname(destination));
      fs.renameSync(candidate, destination);
      readAndValidateManifest(destination, PROFILE_BUNDLE_KIND);
      if (manifestHash(destination) !== candidateManifestSha256) throw new Error('Published Desktop snapshot differs from its staged candidate.');
      updateCaptureJournal(txDir, journal, 'committed');
      fs.rmSync(path.join(txDir, BACKUP_RETENTION_PROTECTION_MARKER), { force: true });

      if (journal.hadPrevious && fs.existsSync(previous)) {
        try {
          const historyRoot = path.join(backupsDir(), 'desktop-profiles', safeId);
          const history = path.join(historyRoot, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
          ensurePrivateDir(historyRoot);
          fs.cpSync(previous, history, { recursive: true, errorOnExist: true });
          atomicWriteFile(path.join(history, TRANSACTION_MANIFEST), `${JSON.stringify({
            kind: 'claude-codex-account-switch/claude-desktop-profile-history',
            version: 1,
            complete: true,
            profileId: safeId,
            createdAt: Date.now(),
          }, null, 2)}\n`);
          pruneManagedBackupDirs(historyRoot, 3);
        } catch (error) {
          logger.warn('Desktop profile history copy failed; transaction copy remains retained', { profileId: safeId, error: redactText(error) });
        }
      }
      pruneManagedBackupDirs(transactionRoot(), 20);
      logger.info('captured Claude Desktop session', { profileId: safeId, destination });
      return destination;
    } catch (error) {
      if (journal) rollbackCaptureTransaction(txDir, journal);
      else fs.rmSync(txDir, { recursive: true, force: true });
      throw error;
    }
  });
}

export interface DesktopApplyResult {
  ok: boolean;
  error?: string;
  backupDir?: string;
  transactionDir?: string;
  rollback?: 'not-needed' | 'succeeded' | 'deferred' | 'failed';
}

/** Restore an exact v2 transaction backup without trusting undeclared absences. */
export function restoreDesktopBackup(backupDir: string, options: DesktopOperationOptions = {}): void {
  withFileLockSync('claude-desktop-live', () => {
    const assertClaudeClosed = closedGuard(options);
    recoverTransactionsUnlocked(assertClaudeClosed);
    const manifest = readAndValidateManifest(backupDir, LIVE_BACKUP_KIND);
    executeLiveTransaction(
      backupDir,
      manifest,
      manifest.absentEntries ?? [],
      `manual rollback from ${path.basename(path.dirname(backupDir))}`,
      assertClaudeClosed,
    );
  });
}

/**
 * Validate target -> back up its complete declared scope -> apply present bytes and
 * explicit absences -> validate live state. Omitted/corrupt scope data fails pre-write.
 */
export function applyDesktopSnapshot(snapshotDir: string, options: DesktopOperationOptions = {}): DesktopApplyResult {
  return withFileLockSync('claude-desktop-live', () => {
    const assertClaudeClosed = closedGuard(options);
    try {
      recoverTransactionsUnlocked(assertClaudeClosed);
    } catch (error) {
      return { ok: false, rollback: 'not-needed', error: `Pending Desktop recovery failed: ${redactText(error)}` };
    }
    let installed: boolean;
    try {
      installed = isDesktopInstalled();
    } catch (error) {
      return { ok: false, rollback: 'not-needed', error: redactText(error) };
    }
    if (!installed) return { ok: false, rollback: 'not-needed', error: 'Claude Desktop is not installed on this machine.' };

    let manifest: DesktopBundleManifest;
    try {
      manifest = readAndValidateManifest(snapshotDir, PROFILE_BUNDLE_KIND);
    } catch (error) {
      logger.error('Desktop target validation failed; switch aborted before writes', error, { snapshotDir });
      return { ok: false, rollback: 'not-needed', error: redactText(error) };
    }
    try {
      const transaction = executeLiveTransaction(
        snapshotDir,
        manifest,
        manifest.absentEntries,
        `profile ${manifest.profileId}`,
        assertClaudeClosed,
      );
      logger.info('switched Claude Desktop session', { snapshotDir, ...transaction });
      return { ok: true, ...transaction, rollback: 'not-needed' };
    } catch (error) {
      const message = redactText(error);
      logger.error('Desktop apply failed', error, { snapshotDir });
      if (error instanceof DesktopLiveTransactionError) {
        return {
          ok: false,
          rollback: error.rollback,
          backupDir: error.backupDir,
          transactionDir: error.transactionDir,
          error: message,
        };
      }
      return {
        ok: false,
        rollback: 'not-needed',
        error: message,
      };
    }
  });
}

/** Allocate a fresh profile id + snapshot dir for a newly captured Desktop account. */
export function newDesktopProfileId(): string {
  return crypto.randomUUID();
}
