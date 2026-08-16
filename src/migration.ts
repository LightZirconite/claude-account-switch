import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBrotliCompress, createBrotliDecompress, constants as zlibConstants } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomicCopyFile, atomicCopyFileRange, atomicWriteFile, ensurePrivateDir } from './atomicFile';
import {
  backupsDir,
  claudeConfigDir,
  claudeJsonPath,
  claudeProfileCredentialsPath,
  codexAuthPath,
  codexHome,
  codexProfileHome,
  dataDir,
  desktopUserDataDir,
  exportDir,
} from './paths';
import { loadStore } from './profiles';
import { loadCodexStore } from './codexProfiles';
import { withFileLock } from './locks';
import { findClaudeProcesses } from './processes';
import { findCodexProcesses } from './codexSwitch';
import type { ProcInfo } from './processes';
import type { CodexProcessInfo } from './codexSwitch';
import pkg from '../package.json';

const OUTER_MAGIC = Buffer.from('CCSWMIG1', 'ascii');
const PAYLOAD_MAGIC = Buffer.from('CCSWPAY1', 'ascii');
const AUTH_TAG_BYTES = 16;
const MAX_PUBLIC_HEADER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;
const MIGRATION_EXTENSION = '.ccswitch-migration';
export const PORTABLE_MIGRATION_KEY_NAME = 'Claude-Codex-Coder-Recovery-Key.txt';
const MAX_PASSPHRASE_FILE_BYTES = 8 * 1024;

export type MigrationScope = 'switch' | 'claude' | 'claude-meta' | 'codex' | 'recovery';

export interface MigrationEntry {
  scope: MigrationScope;
  path: string;
  size: number;
  mode: number;
  sha256: string;
}

export interface MigrationAccountHealth {
  provider: 'claude' | 'codex';
  id: string;
  label: string;
  email: string;
  status: 'saved-unverified' | 'reauth-required';
  reason?: string;
}

export interface MigrationManifest {
  kind: 'claude-codex-account-switch/migration';
  version: 1;
  archiveId: string;
  createdAt: string;
  source: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    switcher: string;
    claudeCli: string;
    codexCli: string;
  };
  entries: MigrationEntry[];
  exclusions: Array<{ scope: MigrationScope; path: string; reason: string }>;
  portabilityWarnings: Array<{ scope: MigrationScope; path: string; reason: string }>;
  sources: Array<{ scope: MigrationScope; description: string; present: boolean; restore: 'live' | 'recovery-only' }>;
  accounts: MigrationAccountHealth[];
  totalBytes: number;
}

export interface MigrationPlan {
  manifest: MigrationManifest;
  warnings: string[];
}

interface SourceRoot {
  scope: MigrationScope;
  root: string;
  prefix: string;
  description: string;
  restore: 'live' | 'recovery-only';
  singleFile?: boolean;
}

interface PublicHeader {
  kind: 'claude-codex-account-switch/encrypted-migration';
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tagBytes: number };
  compression: 'brotli';
}

interface DecryptedPayload {
  tempDir: string;
  payloadFile: string;
  manifest: MigrationManifest;
  dataOffset: number;
}

function toolVersion(exe: string): string {
  try {
    const result = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return result.status === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/u)[0] || 'unknown' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function normalizeArchivePath(value: string): string {
  return value.split(path.sep).join('/');
}

function safeArchivePath(value: string): string[] {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`Unsafe absolute migration path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /\0|[\r\n]/u.test(part))) {
    throw new Error(`Unsafe migration path segment: ${value}`);
  }
  return parts;
}

function hashFile(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function excludedPath(scope: MigrationScope, relative: string, recovery: boolean): string | null {
  const parts = normalizeArchivePath(relative).split('/');
  const first = parts[0]?.toLowerCase();
  const base = parts.at(-1)?.toLowerCase() ?? '';
  if (scope === 'switch' && (first === 'locks' || first === 'jobs' || first === 'migration-work')) {
    return 'ephemeral lock/job/work state';
  }
  if (scope === 'switch' && first === 'exports' && base.endsWith('.ccswitch-migration')) {
    return 'previous encrypted migration archive is not recursively nested inside the new archive';
  }
  if (scope === 'switch' && process.platform === 'win32' && first === 'desktop') {
    return 'Windows Claude Desktop captures are archived separately as recovery-only evidence';
  }
  if (scope === 'claude' && first === '.claude.json') {
    return 'Claude root metadata is archived separately through the portable claude-meta mapping';
  }
  if (scope === 'codex' && first === '.sandbox' && base.endsWith('.log')) {
    return 'ephemeral Codex sandbox runtime log';
  }
  if (first === 'tmp' || first === '.tmp' || first === 'run') return 'ephemeral runtime state';
  if (/\.(?:lock|sock|pid|tmp)$/iu.test(base)) return 'ephemeral lock/socket/process state';
  if (recovery && parts.some((part) => /^(?:cache|code cache|gpucache|crashpad)$/iu.test(part))) {
    return 'rebuildable Desktop cache';
  }
  return null;
}

function accountHealth(): MigrationAccountHealth[] {
  const claude = loadStore().profiles.map((profile): MigrationAccountHealth => {
    const hasCredential = !!profile.claudeAiOauth?.refreshToken || fs.existsSync(claudeProfileCredentialsPath(profile.id));
    return {
      provider: 'claude',
      id: profile.id,
      label: profile.label,
      email: profile.email,
      status: profile.needsReauth || !hasCredential ? 'reauth-required' : 'saved-unverified',
      reason: profile.needsReauth || !hasCredential
        ? 'No currently reusable refresh credential is recorded; metadata and recovery evidence remain included.'
        : undefined,
    };
  });
  let liveCodexAccountId: string | null = null;
  try {
    const auth = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')) as { tokens?: { account_id?: unknown } };
    liveCodexAccountId = typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : null;
  } catch {
    /* live Codex auth is absent or unreadable; isolated envelopes remain authoritative */
  }
  const codex = loadCodexStore().profiles.map((profile): MigrationAccountHealth => {
    const hasCredential = fs.existsSync(codexAuthPath(codexProfileHome(profile.id))) || profile.accountId === liveCodexAccountId;
    return {
      provider: 'codex',
      id: profile.id,
      label: profile.label,
      email: profile.email,
      status: profile.needsReauth || !hasCredential ? 'reauth-required' : 'saved-unverified',
      reason: profile.needsReauth || !hasCredential ? 'No reusable file-backed Codex credential is present in the saved or live home.' : undefined,
    };
  });
  return [...claude, ...codex];
}

function migrationRoots(exclusions: MigrationManifest['exclusions'], includeDesktopRecovery: boolean): SourceRoot[] {
  const roots: SourceRoot[] = [
    { scope: 'switch', root: dataDir(), prefix: '', description: 'Switcher profiles, credential envelopes, backups, tombstones, imports and logs', restore: 'live' },
    { scope: 'claude', root: claudeConfigDir(), prefix: '', description: 'Claude Code settings, sessions, projects, plugins, memories and live credential file', restore: 'live' },
    { scope: 'codex', root: codexHome(), prefix: '', description: 'Codex settings, sessions, skills, plugins, memories, history and auth.json', restore: 'live' },
  ];
  const metadata = claudeJsonPath();
  roots.push({ scope: 'claude-meta', root: metadata, prefix: path.basename(metadata), description: 'Claude Code root identity/settings metadata', restore: 'live', singleFile: true });
  if (process.platform === 'win32' && includeDesktopRecovery) {
    roots.push({
      scope: 'recovery',
      root: path.join(dataDir(), 'desktop'),
      prefix: 'windows/switcher-claude-desktop-captures',
      description: 'Switcher-captured Windows Claude Desktop sessions (recovery-only)',
      restore: 'recovery-only',
    });
    try {
      const claudeDesktop = desktopUserDataDir();
      if (claudeDesktop) {
        roots.push({
          scope: 'recovery',
          root: claudeDesktop,
          prefix: 'windows/claude-desktop-live',
          description: 'Windows Claude Desktop state (recovery-only; never injected into Linux)',
          restore: 'recovery-only',
        });
      }
    } catch (error) {
      exclusions.push({ scope: 'recovery', path: 'windows/claude-desktop-live', reason: `not archived because the source is ambiguous: ${String((error as Error).message ?? error)}` });
    }
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      roots.push({
        scope: 'recovery',
        root: path.join(localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0'),
        prefix: 'windows/codex-desktop-package',
        description: 'Windows Codex Desktop package state (recovery-only; never injected into Linux)',
        restore: 'recovery-only',
      });
    }
  }
  return roots;
}

function scanSource(
  root: SourceRoot,
  entries: MigrationEntry[],
  exclusions: MigrationManifest['exclusions'],
  portabilityWarnings: MigrationManifest['portabilityWarnings'],
): void {
  if (!fs.existsSync(root.root)) return;
  const rootStat = fs.lstatSync(root.root);
  if (rootStat.isSymbolicLink()) {
    exclusions.push({ scope: root.scope, path: root.prefix || '.', reason: 'symbolic-link root is not portable and was not followed' });
    return;
  }
  const addFile = (file: string, archivePath: string): void => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      exclusions.push({ scope: root.scope, path: archivePath, reason: 'symbolic link was not followed' });
      return;
    }
    if (!stat.isFile()) {
      exclusions.push({ scope: root.scope, path: archivePath, reason: 'non-regular filesystem entry' });
      return;
    }
    let scope = root.scope;
    let selectedArchivePath = archivePath;
    if (process.platform === 'win32'
      && (root.scope === 'claude' || root.scope === 'codex')
      && /\.(?:bat|cmd|dll|exe|ps1)$/iu.test(archivePath)) {
      scope = 'recovery';
      selectedArchivePath = `windows/provider-machine-files/${root.scope}/${archivePath}`;
      exclusions.push({
        scope: root.scope,
        path: archivePath,
        reason: 'Windows-only executable/script archived as recovery-only evidence instead of being applied on Linux',
      });
    }
    if (process.platform === 'win32'
      && (root.scope === 'claude' || root.scope === 'codex' || root.scope === 'claude-meta')
      && /(?:^|\/)(?:config\.toml|settings\.json|\.claude\.json|claude_desktop_config\.json|\.mcp\.json|mcp\.json)$/iu.test(archivePath)
      && stat.size <= 8 * 1024 * 1024) {
      const text = fs.readFileSync(file, 'utf8');
      if (/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\])/u.test(text)) {
        portabilityWarnings.push({
          scope: root.scope,
          path: archivePath,
          reason: 'contains Windows absolute/UNC paths; imported verbatim and requires Linux path review',
        });
      }
    }
    entries.push({
      scope,
      path: selectedArchivePath,
      size: stat.size,
      mode: stat.mode & 0o777,
      sha256: hashFile(file),
    });
  };
  if (root.singleFile) {
    addFile(root.root, root.prefix);
    return;
  }
  if (!rootStat.isDirectory()) throw new Error(`Migration source is not a directory: ${root.root}`);
  const walk = (directory: string, relative: string): void => {
    const children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const archivePath = normalizeArchivePath(root.prefix ? path.join(root.prefix, childRelative) : childRelative);
      const reason = excludedPath(root.scope, childRelative, root.restore === 'recovery-only');
      if (reason) {
        exclusions.push({ scope: root.scope, path: archivePath, reason });
        continue;
      }
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink()) {
        exclusions.push({ scope: root.scope, path: archivePath, reason: 'symbolic link was not followed' });
      } else if (child.isDirectory()) {
        walk(absolute, childRelative);
      } else {
        addFile(absolute, archivePath);
      }
    }
  };
  walk(root.root, '');
}

export function prepareMigration(options: { includeDesktopRecovery?: boolean } = {}): MigrationPlan {
  const exclusions: MigrationManifest['exclusions'] = [];
  const portabilityWarnings: MigrationManifest['portabilityWarnings'] = [];
  const entries: MigrationEntry[] = [];
  const roots = migrationRoots(exclusions, options.includeDesktopRecovery !== false);
  for (const root of roots) scanSource(root, entries, exclusions, portabilityWarnings);
  entries.sort((a, b) => `${a.scope}/${a.path}`.localeCompare(`${b.scope}/${b.path}`));
  const accounts = accountHealth();
  const warnings = accounts
    .filter((account) => account.status === 'reauth-required')
    .map((account) => `${account.provider}: ${account.label} <${account.email}> requires official re-authentication; its saved evidence is still included.`);
  return {
    manifest: {
      kind: 'claude-codex-account-switch/migration',
      version: 1,
      archiveId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      source: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        switcher: pkg.version,
        claudeCli: toolVersion(process.platform === 'win32' ? 'claude.exe' : 'claude'),
        codexCli: toolVersion(process.platform === 'win32' ? 'codex.exe' : 'codex'),
      },
      entries,
      exclusions,
      portabilityWarnings,
      sources: roots.map((root) => ({
        scope: root.scope,
        description: root.description,
        present: fs.existsSync(root.root),
        restore: root.restore,
      })),
      accounts,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    },
    warnings,
  };
}

function sourceForEntry(entry: MigrationEntry): string {
  const parts = safeArchivePath(entry.path);
  if (entry.scope === 'switch') return path.join(dataDir(), ...parts);
  if (entry.scope === 'claude') return path.join(claudeConfigDir(), ...parts);
  if (entry.scope === 'claude-meta') return claudeJsonPath();
  if (entry.scope === 'codex') return path.join(codexHome(), ...parts);
  if (entry.scope === 'recovery') {
    const relative = parts.slice(2);
    if (parts[0] !== 'windows' || !relative.length) throw new Error(`Unsupported recovery source: ${entry.path}`);
    if (parts[1] === 'claude-desktop-live') {
      const root = desktopUserDataDir();
      if (!root) throw new Error('Claude Desktop recovery source disappeared during export.');
      return path.join(root, ...relative);
    }
    if (parts[1] === 'codex-desktop-package') {
      const local = process.env.LOCALAPPDATA?.trim();
      if (!local) throw new Error('LOCALAPPDATA disappeared during export.');
      return path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', ...relative);
    }
    if (parts[1] === 'switcher-claude-desktop-captures') {
      return path.join(dataDir(), 'desktop', ...relative);
    }
    if (parts[1] === 'provider-machine-files') {
      const provider = parts[2];
      const providerRelative = parts.slice(3);
      if (!providerRelative.length) throw new Error(`Invalid provider recovery source: ${entry.path}`);
      if (provider === 'claude') return path.join(claudeConfigDir(), ...providerRelative);
      if (provider === 'codex') return path.join(codexHome(), ...providerRelative);
      throw new Error(`Invalid provider recovery scope: ${entry.path}`);
    }
  }
  throw new Error(`Unsupported migration source scope: ${entry.scope}`);
}

async function* payloadChunks(plan: MigrationPlan, options: MigrationSafetyOptions): AsyncGenerator<Buffer> {
  const manifest = Buffer.from(JSON.stringify(plan.manifest), 'utf8');
  if (manifest.length > MAX_MANIFEST_BYTES) throw new Error('Migration manifest is unexpectedly large.');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(manifest.length);
  yield PAYLOAD_MAGIC;
  yield length;
  yield manifest;
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  let lastProviderCheckAt = Date.now();
  for (const entry of plan.manifest.entries) {
    const source = sourceForEntry(entry);
    const fd = fs.openSync(source, 'r');
    const hash = crypto.createHash('sha256');
    let total = 0;
    try {
      for (;;) {
        if (Date.now() - lastProviderCheckAt >= 30_000) {
          assertProvidersQuiescent('migration export in progress', options);
          lastProviderCheckAt = Date.now();
        }
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!read) break;
        const chunk = Buffer.from(buffer.subarray(0, read));
        total += read;
        hash.update(chunk);
        yield chunk;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total !== entry.size || hash.digest('hex') !== entry.sha256) {
      throw new Error(`Migration source changed while it was being encrypted: ${entry.scope}/${entry.path}`);
    }
  }
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 12) throw new Error('Migration passphrase must contain at least 12 characters.');
  if (/\0|[\r\n]/u.test(passphrase)) throw new Error('Migration passphrase must be one line without NUL bytes.');
}

/**
 * Resolve either an archive file or a portable folder containing exactly one
 * migration archive. Directory lookup is deliberately shallow so an unrelated
 * tree cannot silently select stale nested credentials.
 */
export function resolveMigrationArchiveInput(input: string): string {
  const selected = path.resolve(input);
  const stat = fs.lstatSync(selected);
  if (stat.isSymbolicLink()) throw new Error('Migration input cannot be a symbolic link.');
  if (stat.isFile()) return selected;
  if (!stat.isDirectory()) throw new Error('Migration input must be a regular archive file or directory.');

  const candidates = fs.readdirSync(selected, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(MIGRATION_EXTENSION))
    .map((entry) => path.join(selected, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (!candidates.length) {
    throw new Error(`No ${MIGRATION_EXTENSION} archive was found directly inside: ${selected}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple ${MIGRATION_EXTENSION} archives were found inside ${selected}; select the intended archive file explicitly.`);
  }
  return candidates[0];
}

/** Return a migration archive only when a pasted generic import path represents one. */
export function discoverMigrationArchiveInput(input: string): string | null {
  const selected = path.resolve(input);
  const stat = fs.lstatSync(selected);
  if (stat.isSymbolicLink()) throw new Error('Import input cannot be a symbolic link.');
  if (stat.isFile()) {
    return selected.toLowerCase().endsWith(MIGRATION_EXTENSION) ? selected : null;
  }
  if (!stat.isDirectory()) return null;
  const candidates = fs.readdirSync(selected, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(MIGRATION_EXTENSION));
  if (!candidates.length) return null;
  return resolveMigrationArchiveInput(selected);
}

/** Find the deliberately portable recovery key stored beside a migration archive. */
export function discoverPortableMigrationPassphraseFile(input: string): string | null {
  const selected = path.resolve(input);
  const stat = fs.lstatSync(selected);
  if (stat.isSymbolicLink()) throw new Error('Migration input cannot be a symbolic link.');
  const directory = stat.isDirectory() ? selected : path.dirname(selected);
  const candidate = path.join(directory, PORTABLE_MIGRATION_KEY_NAME);
  try {
    const keyStat = fs.lstatSync(candidate);
    if (!keyStat.isFile() || keyStat.isSymbolicLink()) {
      throw new Error(`Portable migration key must be a regular, non-symbolic-link file: ${candidate}`);
    }
    if (keyStat.size > MAX_PASSPHRASE_FILE_BYTES) {
      throw new Error(`Portable migration key exceeds ${MAX_PASSPHRASE_FILE_BYTES} bytes.`);
    }
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function deriveKey(passphrase: string, header: PublicHeader): Buffer {
  return crypto.scryptSync(passphrase, Buffer.from(header.kdf.salt, 'base64'), 32, {
    N: header.kdf.N,
    r: header.kdf.r,
    p: header.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function defaultMigrationOutput(): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return path.join(exportDir(), `migration-${stamp}.ccswitch-migration`);
}

function migrationWorkRoot(): string {
  const root = path.join(dataDir(), 'migration-work');
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Migration work root cannot be a symbolic link: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  ensurePrivateDir(root);
  return root;
}

function assembleArchive(output: string, header: PublicHeader, encryptedBody: string, tag: Buffer): void {
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite an existing migration archive: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(output), `.${path.basename(output)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(headerBytes.length);
  const out = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeSync(out, OUTER_MAGIC);
    fs.writeSync(out, headerLength);
    fs.writeSync(out, headerBytes);
    const body = fs.openSync(encryptedBody, 'r');
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    try {
      for (;;) {
        const read = fs.readSync(body, buffer, 0, buffer.length, null);
        if (!read) break;
        fs.writeSync(out, buffer, 0, read);
      }
    } finally {
      fs.closeSync(body);
    }
    fs.writeSync(out, tag);
    fs.fsyncSync(out);
  } catch (error) {
    fs.closeSync(out);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(out);
  fs.renameSync(temp, output);
  if (process.platform !== 'win32') fs.chmodSync(output, 0o600);
}

async function exportMigrationUnlocked(
  passphrase: string,
  output: string,
  options: MigrationSafetyOptions,
): Promise<MigrationPlan & { output: string }> {
  validatePassphrase(passphrase);
  const selected = path.resolve(output);
  const workRoot = migrationWorkRoot();
  const plan = prepareMigration({ includeDesktopRecovery: options.includeDesktopRecovery });
  assertProvidersQuiescent('migration export after inventory', options);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header: PublicHeader = {
    kind: 'claude-codex-account-switch/encrypted-migration',
    version: 1,
    kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tagBytes: AUTH_TAG_BYTES },
    compression: 'brotli',
  };
  const key = deriveKey(passphrase, header);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  key.fill(0);
  const bodyTempDir = fs.mkdtempSync(path.join(workRoot, 'encrypted-'));
  fs.chmodSync(bodyTempDir, 0o700);
  const bodyTemp = path.join(bodyTempDir, 'body.bin');
  fs.mkdirSync(path.dirname(selected), { recursive: true, mode: 0o700 });
  try {
    await pipeline(
      Readable.from(payloadChunks(plan, options)),
      // Quality 1 keeps the portable archive compact without turning multi-gigabyte
      // Desktop recovery evidence into a long CPU-bound operation.
      createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } }),
      cipher,
      fs.createWriteStream(bodyTemp, { flags: 'wx', mode: 0o600 }),
    );
    const rechecked = prepareMigration({ includeDesktopRecovery: options.includeDesktopRecovery });
    const consistencyProjection = (value: MigrationPlan): string => JSON.stringify({
      entries: value.manifest.entries,
      exclusions: value.manifest.exclusions,
      portabilityWarnings: value.manifest.portabilityWarnings,
      sources: value.manifest.sources,
      accounts: value.manifest.accounts,
    });
    if (consistencyProjection(plan) !== consistencyProjection(rechecked)) {
      throw new Error('Migration sources changed while the archive was being encrypted. Close provider tools and retry; no archive was published.');
    }
    assertProvidersQuiescent('migration export at the publication boundary', options);
    assembleArchive(selected, header, bodyTemp, cipher.getAuthTag());
  } finally {
    fs.rmSync(bodyTempDir, { recursive: true, force: true });
  }
  return { ...plan, output: selected };
}

interface MigrationSafetyOptions {
  /** Test seam; production CLI always uses a fresh operating-system inventory. */
  claudeProcessInventory?: () => ProcInfo[];
  /** Test seam; production CLI always uses a fresh operating-system inventory. */
  codexProcessInventory?: () => CodexProcessInfo[];
  /** Test seam for bounded fixtures; production includes machine-bound Desktop recovery evidence. */
  includeDesktopRecovery?: boolean;
  /** Test seam for cross-OS import policy; production always uses process.platform. */
  targetPlatform?: NodeJS.Platform;
}

function assertProvidersQuiescent(operation: string, options: MigrationSafetyOptions): void {
  const claude = (options.claudeProcessInventory ?? findClaudeProcesses)();
  if (claude.length) {
    throw new Error(`Close Claude Code/Desktop normally before ${operation} (process ${claude.map((item) => item.pid).join(', ')}). Nothing was changed.`);
  }
  const codex = (options.codexProcessInventory ?? findCodexProcesses)();
  if (codex.length) {
    throw new Error(`Close Codex CLI/Desktop before ${operation} (process ${codex.map((item) => item.pid).join(', ')}). Nothing was changed.`);
  }
}

async function withMigrationLocks<T>(operation: string, task: () => Promise<T>, options: MigrationSafetyOptions): Promise<T> {
  const recovery = { recoverAbandoned: true };
  return withFileLock('migration-operation', () => (
    withFileLock('claude-provider-switch', () => (
      withFileLock('codex-live-auth', async () => {
        assertProvidersQuiescent(operation, options);
        return task();
      }, recovery)
    ), recovery)
  ), recovery);
}

export async function exportMigration(
  passphrase: string,
  output = defaultMigrationOutput(),
  options: MigrationSafetyOptions = {},
): Promise<MigrationPlan & { output: string }> {
  return withMigrationLocks('migration export', () => exportMigrationUnlocked(passphrase, output, options), options);
}

function parsePublicHeader(file: string): { header: PublicHeader; bodyStart: number; bodyEnd: number; tag: Buffer } {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const prefix = Buffer.allocUnsafe(OUTER_MAGIC.length + 4);
    if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length || !prefix.subarray(0, OUTER_MAGIC.length).equals(OUTER_MAGIC)) {
      throw new Error('Not a Claude + Codex Account Switch migration archive.');
    }
    const headerLength = prefix.readUInt32BE(OUTER_MAGIC.length);
    if (!headerLength || headerLength > MAX_PUBLIC_HEADER_BYTES) throw new Error('Invalid migration public header length.');
    const headerBytes = Buffer.allocUnsafe(headerLength);
    if (fs.readSync(fd, headerBytes, 0, headerLength, prefix.length) !== headerLength) throw new Error('Truncated migration public header.');
    const header = JSON.parse(headerBytes.toString('utf8')) as PublicHeader;
    if (header.kind !== 'claude-codex-account-switch/encrypted-migration'
      || header.version !== 1
      || header.kdf?.name !== 'scrypt'
      || header.kdf.N !== 32768
      || header.kdf.r !== 8
      || header.kdf.p !== 1
      || header.cipher?.name !== 'aes-256-gcm'
      || header.cipher.tagBytes !== AUTH_TAG_BYTES
      || header.compression !== 'brotli') {
      throw new Error('Unsupported or unsafe migration encryption parameters.');
    }
    const salt = Buffer.from(header.kdf.salt, 'base64');
    const iv = Buffer.from(header.cipher.iv, 'base64');
    if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid migration salt or IV.');
    const bodyStart = prefix.length + headerLength;
    const bodyEnd = stat.size - AUTH_TAG_BYTES - 1;
    if (bodyEnd < bodyStart) throw new Error('Truncated migration ciphertext.');
    const tag = Buffer.allocUnsafe(AUTH_TAG_BYTES);
    if (fs.readSync(fd, tag, 0, tag.length, stat.size - tag.length) !== tag.length) throw new Error('Truncated migration authentication tag.');
    return { header, bodyStart, bodyEnd, tag };
  } finally {
    fs.closeSync(fd);
  }
}

function readExact(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (!read) throw new Error('Truncated migration payload.');
    offset += read;
  }
  return buffer;
}

function validateManifest(value: unknown): MigrationManifest {
  if (!value || typeof value !== 'object') throw new Error('Migration manifest must be an object.');
  const manifest = value as MigrationManifest;
  if (manifest.kind !== 'claude-codex-account-switch/migration' || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('Unsupported migration manifest.');
  }
  if (!Array.isArray(manifest.exclusions) || !Array.isArray(manifest.portabilityWarnings) || !Array.isArray(manifest.accounts) || !Array.isArray(manifest.sources)) {
    throw new Error('Migration manifest inventory sections are missing or malformed.');
  }
  if (!/^[a-f0-9-]{36}$/iu.test(manifest.archiveId ?? '')) throw new Error('Invalid migration archive id.');
  let total = 0;
  const seen = new Set<string>();
  let claudeMetaEntries = 0;
  for (const entry of manifest.entries) {
    if (!['switch', 'claude', 'claude-meta', 'codex', 'recovery'].includes(entry.scope)) throw new Error('Unsupported migration scope.');
    safeArchivePath(entry.path);
    if (entry.scope === 'claude-meta' && (entry.path !== '.claude.json' || ++claudeMetaEntries > 1)) {
      throw new Error('Claude root metadata scope must contain exactly one canonical .claude.json path.');
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid size for ${entry.scope}/${entry.path}.`);
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`Invalid hash for ${entry.scope}/${entry.path}.`);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error(`Invalid mode for ${entry.scope}/${entry.path}.`);
    const key = `${entry.scope}/${entry.path}`;
    if (seen.has(key)) throw new Error(`Duplicate migration path: ${key}`);
    seen.add(key);
    total += entry.size;
    if (!Number.isSafeInteger(total)) throw new Error('Migration total size exceeds safe integer limits.');
  }
  if (total !== manifest.totalBytes) throw new Error('Migration manifest total does not match its entries.');
  for (const warning of manifest.portabilityWarnings) {
    if (!['switch', 'claude', 'claude-meta', 'codex', 'recovery'].includes(warning.scope)
      || typeof warning.reason !== 'string'
      || !warning.reason
      || typeof warning.path !== 'string') {
      throw new Error('Invalid migration portability warning.');
    }
    safeArchivePath(warning.path);
  }
  return manifest;
}

function readManifest(payloadFile: string): { manifest: MigrationManifest; dataOffset: number } {
  const fd = fs.openSync(payloadFile, 'r');
  try {
    const prefix = readExact(fd, PAYLOAD_MAGIC.length + 4, 0);
    if (!prefix.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC)) throw new Error('Invalid decrypted migration payload.');
    const length = prefix.readUInt32BE(PAYLOAD_MAGIC.length);
    if (!length || length > MAX_MANIFEST_BYTES) throw new Error('Invalid migration manifest length.');
    const bytes = readExact(fd, length, prefix.length);
    const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
    const dataOffset = prefix.length + length;
    if (dataOffset + manifest.totalBytes !== fs.fstatSync(fd).size) throw new Error('Migration payload has missing or trailing file data.');
    return { manifest, dataOffset };
  } finally {
    fs.closeSync(fd);
  }
}

async function decryptMigration(file: string, passphrase: string): Promise<DecryptedPayload> {
  validatePassphrase(passphrase);
  const archive = resolveMigrationArchiveInput(file);
  const parsed = parsePublicHeader(archive);
  const key = deriveKey(passphrase, parsed.header);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.header.cipher.iv, 'base64'));
  key.fill(0);
  decipher.setAuthTag(parsed.tag);
  const tempDir = fs.mkdtempSync(path.join(migrationWorkRoot(), 'decrypted-'));
  fs.chmodSync(tempDir, 0o700);
  const payloadFile = path.join(tempDir, 'payload.bin');
  let decompressed = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decompressed += chunk.length;
      if (decompressed > MAX_DECOMPRESSED_BYTES) callback(new Error('Decrypted migration exceeds the 64 GiB safety limit.'));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(archive, { start: parsed.bodyStart, end: parsed.bodyEnd }),
      decipher,
      createBrotliDecompress(),
      limiter,
      fs.createWriteStream(payloadFile, { flags: 'wx', mode: 0o600 }),
    );
    const { manifest, dataOffset } = readManifest(payloadFile);
    return { tempDir, payloadFile, manifest, dataOffset };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error('Migration decryption failed: wrong passphrase, modified archive, or invalid encrypted payload.', { cause: error });
  }
}

function verifyPayload(payload: DecryptedPayload): void {
  const fd = fs.openSync(payload.payloadFile, 'r');
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  let position = payload.dataOffset;
  try {
    for (const entry of payload.manifest.entries) {
      const hash = crypto.createHash('sha256');
      let remaining = entry.size;
      while (remaining > 0) {
        const wanted = Math.min(buffer.length, remaining);
        const read = fs.readSync(fd, buffer, 0, wanted, position);
        if (!read) throw new Error(`Truncated data for ${entry.scope}/${entry.path}.`);
        position += read;
        remaining -= read;
        hash.update(buffer.subarray(0, read));
      }
      if (hash.digest('hex') !== entry.sha256) throw new Error(`Hash mismatch for ${entry.scope}/${entry.path}.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export async function inspectMigration(file: string, passphrase: string): Promise<MigrationManifest> {
  const payload = await decryptMigration(file, passphrase);
  try {
    verifyPayload(payload);
    return payload.manifest;
  } finally {
    fs.rmSync(payload.tempDir, { recursive: true, force: true });
  }
}

export async function verifyMigration(file: string, passphrase: string): Promise<MigrationManifest> {
  return inspectMigration(file, passphrase);
}

function rootForEntry(manifest: MigrationManifest, scope: MigrationScope): string {
  if (scope === 'switch') return dataDir();
  if (scope === 'claude') return claudeConfigDir();
  if (scope === 'claude-meta') return path.dirname(claudeJsonPath());
  if (scope === 'codex') return codexHome();
  return path.join(backupsDir(), 'migration-recovery', manifest.archiveId);
}

function targetForEntry(manifest: MigrationManifest, entry: MigrationEntry): string {
  const parts = safeArchivePath(entry.path);
  if (entry.scope === 'claude-meta') return claudeJsonPath();
  const root = path.resolve(rootForEntry(manifest, entry.scope));
  const target = path.resolve(root, ...parts);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Migration path escapes its target root: ${entry.path}`);
  return target;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Refusing to import through symbolic-link root: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    if (!part) continue;
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to import through symbolic-link directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
}

function sensitiveMode(entry: MigrationEntry): number {
  const base = path.posix.basename(entry.path).toLowerCase();
  if (entry.scope === 'switch' || base === 'auth.json' || base === '.credentials.json' || base.endsWith('.ccswitch.json')) return 0o600;
  return entry.mode || 0o600;
}

export interface MigrationImportResult {
  manifest: MigrationManifest;
  written: number;
  identical: number;
  backupDir: string | null;
  recoveryDir: string | null;
  desktopLinksDetached: number;
  portabilityReviewFile: string | null;
}

function detachMachineBoundDesktopLinks(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  let detached = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.desktopSnapshotDir === 'string') {
      delete record.desktopSnapshotDir;
      const oauth = record.claudeAiOauth;
      const refreshToken = oauth && typeof oauth === 'object'
        ? (oauth as Record<string, unknown>).refreshToken
        : null;
      if (typeof refreshToken !== 'string' || !refreshToken) record.needsReauth = true;
      detached++;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  if (detached) atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  return detached;
}

async function importMigrationUnlocked(
  file: string,
  passphrase: string,
  options: { replaceExisting?: boolean } = {},
): Promise<MigrationImportResult> {
  const payload = await decryptMigration(file, passphrase);
  let preserveTempForRecovery = false;
  try {
    // Authentication and every content hash are proven before the first target or
    // rollback-backup write. The verified payload then remains in a private temp file
    // and individual ranges are streamed atomically with bounded memory.
    verifyPayload(payload);
    const payloadOffsets = new Map<string, number>();
    let payloadOffset = payload.dataOffset;
    for (const entry of payload.manifest.entries) {
      payloadOffsets.set(`${entry.scope}/${entry.path}`, payloadOffset);
      payloadOffset += entry.size;
    }
    const targetPaths = new Set<string>();
    for (const entry of payload.manifest.entries) {
      const target = path.resolve(targetForEntry(payload.manifest, entry));
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      if (targetPaths.has(key)) throw new Error(`Multiple migration entries resolve to the same target: ${target}`);
      targetPaths.add(key);
    }
    const conflicts: string[] = [];
    const identical = new Set<string>();
    const targetPlatform = (options as MigrationSafetyOptions).targetPlatform ?? process.platform;
    const detachWindowsDesktop = payload.manifest.source.platform === 'win32' && targetPlatform !== 'win32';
    for (const entry of payload.manifest.entries) {
      const target = targetForEntry(payload.manifest, entry);
      const root = path.resolve(rootForEntry(payload.manifest, entry.scope));
      assertNoSymlinkComponents(root, target);
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Import target is not a regular file: ${target}`);
        if (stat.size === entry.size && hashFile(target) === entry.sha256) identical.add(`${entry.scope}/${entry.path}`);
        else conflicts.push(`${entry.scope}/${entry.path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (detachWindowsDesktop) {
      identical.delete('switch/profiles.json');
      identical.delete('switch/profiles.json.bak');
    }
    if (conflicts.length && !options.replaceExisting) {
      const preview = conflicts.slice(0, 10).join(', ');
      throw new Error(`Migration would replace ${conflicts.length} existing file(s): ${preview}${conflicts.length > 10 ? ', …' : ''}. Inspect first, then retry with --replace-existing to create rollback backups and proceed.`);
    }

    const changed = payload.manifest.entries.filter((entry) => !identical.has(`${entry.scope}/${entry.path}`));
    const backupDir = changed.some((entry) => fs.existsSync(targetForEntry(payload.manifest, entry)))
      ? path.join(backupsDir(), `migration-import-${payload.manifest.archiveId}-${Date.now()}`)
      : null;
    if (backupDir) ensurePrivateDir(backupDir);
    const rollback: Array<{ target: string; backup: string | null; mode: number }> = [];
    let written = 0;
    let desktopLinksDetached = 0;
    try {
      assertProvidersQuiescent('migration import at the mutation boundary', options as MigrationSafetyOptions);
      for (const entry of changed) {
        const target = targetForEntry(payload.manifest, entry);
        const targetRoot = path.resolve(rootForEntry(payload.manifest, entry.scope));
        assertNoSymlinkComponents(targetRoot, target);
        let backup: string | null = null;
        let previousMode = 0o600;
        if (fs.existsSync(target)) {
          const targetStat = fs.lstatSync(target);
          if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`Import target changed into a non-regular file: ${target}`);
          previousMode = targetStat.mode & 0o777;
          backup = path.join(backupDir!, entry.scope, ...safeArchivePath(entry.path));
          ensurePrivateDir(path.dirname(backup));
          atomicCopyFile(target, backup, 0o600);
        }
        rollback.push({ target, backup, mode: previousMode });
        const sourceOffset = payloadOffsets.get(`${entry.scope}/${entry.path}`);
        if (sourceOffset === undefined) throw new Error(`Verified migration entry offset disappeared: ${entry.scope}/${entry.path}`);
        assertNoSymlinkComponents(targetRoot, target);
        atomicCopyFileRange(payload.payloadFile, sourceOffset, entry.size, target, sensitiveMode(entry));
        written++;
      }
      for (const entry of payload.manifest.entries) {
        const target = targetForEntry(payload.manifest, entry);
        if (fs.statSync(target).size !== entry.size || hashFile(target) !== entry.sha256) {
          throw new Error(`Post-import verification failed for ${entry.scope}/${entry.path}.`);
        }
      }
      if (detachWindowsDesktop) {
        desktopLinksDetached += detachMachineBoundDesktopLinks(path.join(dataDir(), 'profiles.json'));
        desktopLinksDetached += detachMachineBoundDesktopLinks(path.join(dataDir(), 'profiles.json.bak'));
      }
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const item of rollback.reverse()) {
        try {
          if (item.backup) atomicCopyFile(item.backup, item.target, item.mode || 0o600);
          else fs.rmSync(item.target, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
        }
      }
      if (rollbackErrors.length) {
        preserveTempForRecovery = true;
        throw new AggregateError([error as Error, ...rollbackErrors], `Migration import failed and rollback was incomplete. Private recovery evidence is in ${backupDir ?? payload.tempDir}.`);
      }
      throw new Error(`Migration import failed; all modified files were rolled back: ${String((error as Error).message ?? error)}`, { cause: error });
    }

    if (backupDir) {
      atomicWriteFile(path.join(backupDir, 'receipt.json'), `${JSON.stringify({
        kind: 'claude-codex-account-switch/migration-import-backup',
        version: 1,
        archiveId: payload.manifest.archiveId,
        importedAt: new Date().toISOString(),
        replacedFiles: rollback.filter((item) => item.backup).length,
        desktopLinksDetached,
      }, null, 2)}\n`, 0o600);
    }
    const recoveryDir = payload.manifest.entries.some((entry) => entry.scope === 'recovery') || payload.manifest.portabilityWarnings.length
      ? rootForEntry(payload.manifest, 'recovery')
      : null;
    let portabilityReviewFile: string | null = null;
    if (payload.manifest.portabilityWarnings.length && recoveryDir) {
      const review = path.join(recoveryDir, 'portability-review.json');
      try {
        atomicWriteFile(review, `${JSON.stringify({
          kind: 'claude-codex-account-switch/portability-review',
          version: 1,
          sourcePlatform: payload.manifest.source.platform,
          targetPlatform: (options as MigrationSafetyOptions).targetPlatform ?? process.platform,
          warnings: payload.manifest.portabilityWarnings,
        }, null, 2)}\n`, 0o600);
        portabilityReviewFile = review;
      } catch {
        // The encrypted manifest remains the authoritative portability report. A
        // secondary convenience copy must not turn a verified live import into a
        // false transactional failure after all provider files were committed.
      }
    }
    return { manifest: payload.manifest, written, identical: identical.size, backupDir, recoveryDir, desktopLinksDetached, portabilityReviewFile };
  } finally {
    if (!preserveTempForRecovery) fs.rmSync(payload.tempDir, { recursive: true, force: true });
  }
}

export async function importMigration(
  file: string,
  passphrase: string,
  options: { replaceExisting?: boolean } & MigrationSafetyOptions = {},
): Promise<MigrationImportResult> {
  return withMigrationLocks('migration import', () => importMigrationUnlocked(file, passphrase, options), options);
}

function pathIsSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function readMigrationPassphraseFile(file: string, options: { forExport?: boolean } = {}): string {
  const selected = path.resolve(file);
  const stat = fs.lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Passphrase file must be a regular, non-symbolic-link file.');
  if (stat.size > MAX_PASSPHRASE_FILE_BYTES) throw new Error(`Passphrase file exceeds ${MAX_PASSPHRASE_FILE_BYTES} bytes.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Passphrase file permissions are too broad; run chmod 600 on it first.');
  }
  if (options.forExport) {
    const directoryRoots = [dataDir(), claudeConfigDir(), codexHome()];
    if (directoryRoots.some((root) => pathIsSameOrInside(selected, root)) || path.resolve(selected) === path.resolve(claudeJsonPath())) {
      throw new Error('The migration passphrase file must be stored outside the switcher, Claude, and Codex data roots so it cannot be archived with the data it protects.');
    }
  }
  const passphrase = fs.readFileSync(selected, 'utf8').replace(/\r?\n$/u, '');
  validatePassphrase(passphrase);
  return passphrase;
}

/**
 * Read the exact portable-key filename beside an archive. Removable NTFS mounts
 * may not expose POSIX chmod bits, so this deliberate convenience format cannot
 * require mode 0600. Anyone holding the folder can decrypt its archive.
 */
export function readPortableMigrationPassphraseFile(file: string): string {
  const selected = path.resolve(file);
  if (path.basename(selected) !== PORTABLE_MIGRATION_KEY_NAME) {
    throw new Error(`Portable migration key must be named ${PORTABLE_MIGRATION_KEY_NAME}.`);
  }
  const stat = fs.lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Portable migration key must be a regular, non-symbolic-link file.');
  if (stat.size > MAX_PASSPHRASE_FILE_BYTES) throw new Error(`Portable migration key exceeds ${MAX_PASSPHRASE_FILE_BYTES} bytes.`);
  const passphrase = fs.readFileSync(selected, 'utf8').replace(/\r?\n$/u, '');
  validatePassphrase(passphrase);
  return passphrase;
}

async function hiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('A TTY is required for a hidden passphrase prompt. Use --passphrase-file with a 0600 file instead.');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    const value: number[] = [];
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('Migration passphrase entry cancelled.'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(Buffer.from(value).toString('utf8'));
          return;
        }
        if (byte === 127 || byte === 8) {
          let start = value.length - 1;
          while (start > 0 && (value[start] & 0xc0) === 0x80) start--;
          if (start >= 0) value.splice(start);
        } else {
          value.push(byte);
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function promptMigrationPassphrase(confirm = false): Promise<string> {
  const first = await hiddenLine('Migration passphrase (hidden): ');
  validatePassphrase(first);
  if (confirm) {
    const second = await hiddenLine('Confirm passphrase (hidden): ');
    const firstBytes = Buffer.from(first);
    const secondBytes = Buffer.from(second);
    if (firstBytes.length !== secondBytes.length || !crypto.timingSafeEqual(firstBytes, secondBytes)) {
      throw new Error('Migration passphrases do not match.');
    }
  }
  return first;
}
