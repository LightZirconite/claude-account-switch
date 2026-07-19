import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { codexAuthPath, codexHome, codexProfileHome, backupsDir, dataDir, ensureDataDirs } from './paths';
import {
  CodexAppServerShutdownError,
  claimCodexAppServerHome,
  clearCodexLoginHelperMarker,
  inspectCodexHome,
  type CodexInspection,
} from './codexAppServer';
import {
  codexCredentialLockName,
  loadCodexStore,
  readCodexAuth,
  readCodexAuthState,
  reconcileLiveCodexUnlocked,
  setActiveCodexProfile,
  syncCodexProfileAuthFromHome,
} from './codexProfiles';
import { withFileLock } from './locks';
import { logger } from './logger';
import { atomicCopyFile, atomicWriteFile, ensurePrivateDir } from './atomicFile';
import {
  acquireBackupRetentionLease,
  markManualRecovery,
  protectBackupFromRetention,
  pruneManagedBackupDirs,
  releaseBackupRetentionProtection,
} from './retention';

export interface CodexProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  kind: 'app' | 'cli' | 'helper' | 'ancestor';
}

export interface CodexSwitchResult {
  ok: boolean;
  profileId: string;
  message: string;
  backupDir?: string;
}

export interface RawProcess {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string;
  CommandLine?: string;
  ExecutablePath?: string;
}

export type CodexAuthTransactionResult<T> =
  | { ok: true; value: T; backupDir: string }
  | { ok: false; error: Error; backupDir: string; rollbackSucceeded: boolean; rollbackError?: Error };

interface CodexLiveBackupManifest {
  kind: 'claude-codex-account-switch/codex-live-backup';
  version: 1 | 2;
  complete: true;
  createdAt: number;
  hadAuth: boolean;
  /** Present on v2; binds recovery to the exact credential bytes captured originally. */
  authSha256?: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GRACEFUL_DESKTOP_CLOSE_MS = 8_000;
const FORCED_DESKTOP_CLOSE_WAIT_MS = 10_000;
const CODEX_WORKER_MUTATION_WINDOW_MS = 120_000;
const CODEX_WORKER_RESULT_WINDOW_MS = 175_000;

function configuredMutationDeadline(explicit?: number): number | null {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  const inherited = Number(process.env.CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT);
  return Number.isFinite(inherited) && inherited > 0 ? inherited : null;
}

function assertMutationDeadline(deadlineAt: number | null): void {
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    throw new Error('Codex switch transaction deadline elapsed before mutation.');
  }
}

function lockTimeoutBefore(deadlineAt: number | null): number {
  if (deadlineAt === null) return 60_000;
  return Math.max(1, Math.min(60_000, deadlineAt - Date.now()));
}

function windowsProcesses(): RawProcess[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath)",
    "'__SWITCHER_CIM_OK__'",
    '$items | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
    const [marker, ...payloadLines] = out.split(/\r?\n/);
    if (marker?.trim() !== '__SWITCHER_CIM_OK__') throw new Error('Windows process inventory did not return its success marker.');
    const payload = payloadLines.join('\n').trim();
    if (!payload) return [];
    const value = JSON.parse(payload) as RawProcess | RawProcess[];
    return Array.isArray(value) ? value : [value];
  } catch (error) {
    logger.error('codex process inspection failed', error);
    throw new Error(`Could not safely inspect running Codex processes: ${String((error as Error).message ?? error)}`);
  }
}

function unixProcesses(): RawProcess[] {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 10_000 });
    return out.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return [];
      return [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Name: match[3], CommandLine: match[4], ExecutablePath: match[3] }];
    });
  } catch (error) {
    logger.error('codex process inspection failed', error);
    throw new Error(`Could not safely inspect running Codex processes: ${String((error as Error).message ?? error)}`);
  }
}

export function classifyCodexProcesses(rows: RawProcess[], currentPid = process.pid): CodexProcessInfo[] {
  const relevant = rows.filter((row) => {
    const name = path.basename(row.Name ?? row.ExecutablePath ?? '');
    const executable = row.ExecutablePath ?? '';
    return /^(?:codex|ChatGPT)(?:\.exe)?$/i.test(name)
      || /[\\/]WindowsApps[\\/]OpenAI\.Codex_/i.test(executable);
  });
  const byPid = new Map(rows.map((row) => [Number(row.ProcessId), row]));
  const ancestorPids = new Set<number>();
  let ancestor = currentPid;
  while (ancestor > 0 && !ancestorPids.has(ancestor)) {
    ancestorPids.add(ancestor);
    ancestor = Number(byPid.get(ancestor)?.ParentProcessId ?? 0);
  }
  const appPids = new Set(relevant.filter((row) => {
    const name = row.Name ?? '';
    const executable = row.ExecutablePath ?? '';
    const commandLine = row.CommandLine ?? '';
    return /chatgpt/i.test(name)
      || /[\\/]WindowsApps[\\/]OpenAI\.Codex_/i.test(executable)
      || /\.app[\\/]Contents[\\/]MacOS[\\/]/i.test(commandLine);
  }).map((row) => Number(row.ProcessId)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of relevant) {
      if (appPids.has(Number(row.ParentProcessId)) && !appPids.has(Number(row.ProcessId))) {
        appPids.add(Number(row.ProcessId));
        changed = true;
      }
    }
  }
  return relevant
    .filter((row) => Number(row.ProcessId) > 0 && Number(row.ProcessId) !== currentPid)
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: row.Name ?? 'codex',
      commandLine: row.CommandLine ?? '',
      kind: ancestorPids.has(Number(row.ProcessId))
        ? 'ancestor'
        : /(?:^|\s)app-server(?:\s|$)/i.test(row.CommandLine ?? '')
          || (/^codex(?:\.exe)?$/i.test(path.basename(row.Name ?? row.ExecutablePath ?? ''))
            && !(row.CommandLine ?? '').trim())
          ? 'helper'
          : appPids.has(Number(row.ProcessId))
            ? 'app'
            : 'cli',
    }));
}

export function findCodexProcesses(): CodexProcessInfo[] {
  const rows = process.platform === 'win32' ? windowsProcesses() : unixProcesses();
  return classifyCodexProcesses(rows);
}

export function remainingTrackedProcessIds(initialPids: ReadonlySet<number>, current: CodexProcessInfo[]): number[] {
  return current.filter((process) => initialPids.has(process.pid)).map((process) => process.pid);
}

export function codexProcessRootIds(processes: CodexProcessInfo[]): number[] {
  const pids = new Set(processes.map((process) => process.pid));
  return processes.filter((process) => !pids.has(process.ppid)).map((process) => process.pid);
}

function assertNoProtectedCodexProcesses(processes: CodexProcessInfo[]): void {
  const protectedProcesses = processes.filter((candidate) => candidate.kind === 'helper' || candidate.kind === 'ancestor');
  if (!protectedProcesses.length) return;
  const ancestorPresent = protectedProcesses.some((candidate) => candidate.kind === 'ancestor');
  throw new Error(
    ancestorPresent
      ? 'Codex switching cannot run from inside a Codex process tree. Open the switcher from an independent terminal.'
      : `A Codex app-server helper is still running (${protectedProcesses.map((candidate) => candidate.pid).join(', ')}). Wait for it to finish; it will never be force-terminated.`,
  );
}

async function waitForTrackedProcessesToExit(initialPids: ReadonlySet<number>, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = remainingTrackedProcessIds(initialPids, findCodexProcesses());
  while (remaining.length && Date.now() < deadline) {
    await sleep(500);
    remaining = remainingTrackedProcessIds(initialPids, findCodexProcesses());
  }
  return remaining;
}

async function forceCloseCodexCliSessions(timeoutMs = FORCED_DESKTOP_CLOSE_WAIT_MS): Promise<number[]> {
  const observed = findCodexProcesses();
  assertNoProtectedCodexProcesses(observed);
  const initial = observed.filter((process) => process.kind === 'cli');
  if (initial.length) {
    const roots = codexProcessRootIds(initial);
    for (const pid of roots) {
      try {
        if (process.platform === 'win32') {
          // First request a normal tree termination. `/F` is reserved for the bounded
          // fallback below after the confirmed switch has waited for graceful exit.
          // Never terminate a CLI tree wholesale: a newly spawned app-server child may
          // own a rotating token. Any child left behind is detected and blocks the swap.
          execFileSync('taskkill.exe', ['/PID', String(pid)], { windowsHide: true, timeout: 10_000 });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch {
        /* it may already have exited */
      }
    }
    const remainingAfterGrace = await waitForTrackedProcessesToExit(new Set(initial.map((process) => process.pid)), 3_000);
    if (!remainingAfterGrace.length) {
      // Tracking only the original PIDs is insufficient: a CLI can spawn an app-server
      // while closing and then exit. Reinventory the whole provider before allowing any
      // credential read or write to follow.
      const current = findCodexProcesses();
      assertNoProtectedCodexProcesses(current);
      if (!current.some((candidate) => candidate.kind === 'cli')) return [];
    }
  }
  const deadline = Date.now() + timeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const current = findCodexProcesses();
    assertNoProtectedCodexProcesses(current);
    const cliProcesses = current.filter((process) => process.kind === 'cli');
    if (cliProcesses.length) {
      quietSince = 0;
      forceTerminateCodexProcessTrees(cliProcesses);
    } else {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 1_000) return [];
    }
    await sleep(250);
  }
  const final = findCodexProcesses();
  assertNoProtectedCodexProcesses(final);
  return final.filter((process) => process.kind === 'cli').map((process) => process.pid);
}

function forceTerminateCodexProcessTrees(processes: CodexProcessInfo[]): void {
  const roots = codexProcessRootIds(processes);
  if (process.platform === 'win32') {
    for (const pid of roots) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
        });
      } catch {
        // A process can exit between the observation and taskkill. The caller
        // verifies the complete original process set before changing auth.
      }
    }
    return;
  }
  if (process.platform === 'darwin') {
    for (const pid of roots) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* process already exited or cannot be terminated */
      }
    }
  }
}

export interface CodexAppCloseOptions {
  /** Test seam; production always performs a fresh OS process inventory. */
  processInventory?: () => CodexProcessInfo[];
  /** Test seam for the platform-specific normal close request. */
  requestClose?: () => void;
  /** Test seam for bounded process-exit observation. */
  waitForExit?: (initialPids: ReadonlySet<number>, timeoutMs: number) => Promise<number[]>;
  /** Test seam; production force-terminates only explicitly revalidated original app PIDs. */
  forceTerminate?: (processes: CodexProcessInfo[]) => void;
}

function requestCodexDesktopClose(): void {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -or ($_.Name -eq 'codex.exe' -and $_.ExecutablePath -match '[\\\\/]WindowsApps[\\\\/]OpenAI\\.Codex_') } | ForEach-Object { $process = Get-Process -Id $_.ProcessId; if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() } }",
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    execFileSync('osascript', ['-e', 'tell application "Codex" to quit'], { timeout: 10_000 });
  }
}

function forceTerminateOriginalCodexAppProcesses(processes: CodexProcessInfo[]): void {
  // Never terminate a Desktop process tree. An app-server may appear after the
  // inventory and before taskkill; targeting only revalidated PIDs prevents /T
  // from killing that credential owner. The post-force inventory remains the
  // authority before any auth file can be changed.
  if (process.platform === 'win32') {
    for (const candidate of processes) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(candidate.pid), '/F'], {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
        });
      } catch {
        /* A process may exit after the final inventory and before taskkill. */
      }
    }
    return;
  }
  if (process.platform === 'darwin') {
    for (const candidate of processes) {
      try {
        process.kill(candidate.pid, 'SIGTERM');
      } catch {
        /* process already exited or cannot be terminated */
      }
    }
  }
}

function assertOnlyOriginalCodexAppsRemain(
  initialApps: ReadonlyMap<number, CodexProcessInfo>,
  current: CodexProcessInfo[],
): CodexProcessInfo[] {
  assertNoProtectedCodexProcesses(current);
  const unexpected = current.filter((candidate) => {
    const original = initialApps.get(candidate.pid);
    return !original
      || candidate.kind !== 'app'
      || candidate.name.toLowerCase() !== original.name.toLowerCase();
  });
  if (unexpected.length) {
    throw new Error(
      `A new or changed Codex process appeared during Desktop shutdown (${unexpected.map((candidate) => `${candidate.kind} ${candidate.pid}`).join(', ')}). It was not terminated and no credentials were changed.`,
    );
  }
  return current.filter((candidate) => initialApps.has(candidate.pid));
}

export async function requestGracefulAppClose(
  appProcesses: CodexProcessInfo[],
  options: CodexAppCloseOptions = {},
): Promise<void> {
  const initialPids = new Set(appProcesses.map((process) => process.pid));
  if (!initialPids.size) return;
  const initialApps = new Map(appProcesses.map((candidate) => [candidate.pid, candidate]));
  const inventory = options.processInventory ?? findCodexProcesses;
  const waitForExit = options.waitForExit ?? waitForTrackedProcessesToExit;
  const requestClose = options.requestClose ?? requestCodexDesktopClose;
  const forceTerminate = options.forceTerminate ?? forceTerminateOriginalCodexAppProcesses;

  // Revalidate immediately before asking the app to close. A helper or a new app
  // that appeared after the caller's inventory aborts this switch without writes.
  assertOnlyOriginalCodexAppsRemain(initialApps, inventory());
  requestClose();
  await waitForExit(initialPids, GRACEFUL_DESKTOP_CLOSE_MS);

  // Even if every original PID exited, a helper may have appeared during the wait.
  // A fresh whole-provider inventory is therefore mandatory before returning.
  const remainingAfterGracefulClose = assertOnlyOriginalCodexAppsRemain(initialApps, inventory());
  if (!remainingAfterGracefulClose.length) return;

  // The Windows Codex Desktop app can turn a CloseMainWindow request into a
  // tray minimization. The user already confirmed this switch, so terminate
  // only the exact original app PIDs that survived the final revalidation.
  forceTerminate(remainingAfterGracefulClose);
  await waitForExit(initialPids, FORCED_DESKTOP_CLOSE_WAIT_MS);
  const remainingAfterForce = assertOnlyOriginalCodexAppsRemain(initialApps, inventory());
  if (!remainingAfterForce.length) return;
  throw new Error(`Codex Desktop could not be closed (process ${remainingAfterForce.map((candidate) => candidate.pid).join(', ')}). No credentials were changed.`);
}

function relaunchCodexApp(): void {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Codex'], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    logger.warn('codex relaunch failed', { error: String(e) });
  }
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function releaseBackupProtectionSafely(dir: string): void {
  try {
    releaseBackupRetentionProtection(dir);
  } catch (error) {
    logger.warn('Codex backup retention protection could not be released', { dir, error: String(error) });
  }
}

function backupLiveAuth(): { dir: string; hadAuth: boolean; authSha256: string | null } {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsDir(), 'codex-live', `${stamp}-${crypto.randomUUID().slice(0, 8)}`);
  ensurePrivateDir(dir);
  protectBackupFromRetention(dir, 'Codex live-auth transaction in progress.');
  const source = codexAuthPath();
  const hadAuth = fs.existsSync(source);
  if (hadAuth) atomicCopyFile(source, path.join(dir, 'auth.json'));
  const authSha256 = hadAuth ? sha256File(path.join(dir, 'auth.json')) : null;
  atomicWriteFile(path.join(dir, 'transaction.json'), `${JSON.stringify({
    kind: 'claude-codex-account-switch/codex-live-backup',
    version: 2,
    complete: true,
    createdAt: Date.now(),
    hadAuth,
    authSha256,
  }, null, 2)}\n`);
  pruneManagedBackupDirs(path.join(backupsDir(), 'codex-live'), 20);
  return { dir, hadAuth, authSha256 };
}

function readCodexBackupManifest(dir: string): CodexLiveBackupManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8')) as CodexLiveBackupManifest;
    if (manifest?.kind !== 'claude-codex-account-switch/codex-live-backup'
      || (manifest.version !== 1 && manifest.version !== 2)
      || manifest.complete !== true
      || typeof manifest.hadAuth !== 'boolean'
      || !Number.isFinite(manifest.createdAt)) return null;
    if (manifest.hadAuth) {
      const state = readCodexAuthState(dir);
      if (state.status !== 'valid') return null;
      if (manifest.version === 2
        && (!/^[a-f0-9]{64}$/i.test(manifest.authSha256 ?? '')
          || sha256File(codexAuthPath(dir)) !== manifest.authSha256)) return null;
    } else if (fs.existsSync(codexAuthPath(dir))) {
      return null;
    } else if (manifest.version === 2 && manifest.authSha256 !== null) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function listCodexLiveBackups(): string[] {
  const root = path.join(backupsDir(), 'codex-live');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => !!readCodexBackupManifest(dir))
      .sort((a, b) => {
        try {
          return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
        } catch {
          return a.localeCompare(b);
        }
      });
  } catch {
    return [];
  }
}

function restoreLiveAuth(backupDir: string, hadAuth: boolean, authSha256?: string | null): void {
  const target = codexAuthPath();
  const source = path.join(backupDir, 'auth.json');
  const leaseId = claimCodexAppServerHome(codexHome());
  try {
    if (hadAuth) {
      if (!fs.existsSync(source)) throw new Error('Codex rollback backup is missing auth.json.');
      if (authSha256 && sha256File(source) !== authSha256) {
        throw new Error('Codex rollback backup failed its original SHA-256 integrity check.');
      }
      atomicCopyFile(source, target);
      if (authSha256 ? sha256File(target) !== authSha256 : !fs.readFileSync(source).equals(fs.readFileSync(target))) {
        throw new Error('Codex rollback verification failed after restoring auth.json.');
      }
    } else {
      fs.rmSync(target, { force: true });
      if (fs.existsSync(target)) throw new Error('Codex rollback could not restore the original absence of auth.json.');
    }
  } finally {
    clearCodexLoginHelperMarker(codexHome(), leaseId);
  }
}

function assertLiveAuthMatchesCodexBackup(backupDir: string, manifest: CodexLiveBackupManifest): void {
  const target = codexAuthPath();
  const source = codexAuthPath(backupDir);
  if (!manifest.hadAuth) {
    if (fs.existsSync(target)) throw new Error('Codex restore verification failed to restore an absent auth.json.');
    return;
  }
  const state = readCodexAuthState(codexHome());
  if (state.status !== 'valid') throw new Error('Codex restore verification found an invalid live auth.json.');
  if (manifest.authSha256
    ? sha256File(source) !== manifest.authSha256 || sha256File(target) !== manifest.authSha256
    : !fs.readFileSync(source).equals(fs.readFileSync(target))) {
    throw new Error('Codex restore verification found different credential bytes.');
  }
}

function codexAuthEmail(home: string): string | null {
  const auth = readCodexAuth(home);
  if (!auth) return null;
  try {
    const payload = auth.tokens.id_token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function assertEffectiveCodexRestore(
  inspection: CodexInspection,
  backupDir: string,
  manifest: CodexLiveBackupManifest,
): void {
  if (inspection.credentialStore?.trim().toLowerCase() !== 'file') {
    throw new Error(
      `Codex restore requires cli_auth_credentials_store="file"; the effective store is ${inspection.credentialStore ?? 'unresolved'}.`,
    );
  }
  if (!manifest.hadAuth) {
    if (inspection.account?.type === 'chatgpt') {
      throw new Error('Codex still reports a ChatGPT login after restoring a backup with no auth.json.');
    }
    return;
  }
  if (inspection.account?.type !== 'chatgpt') {
    throw new Error('Codex did not load the restored ChatGPT auth.json.');
  }
  const expectedEmail = codexAuthEmail(backupDir);
  const effectiveEmail = inspection.account.email?.trim().toLowerCase();
  if (expectedEmail && effectiveEmail && effectiveEmail !== expectedEmail) {
    throw new Error('Codex loaded a different account after restoring auth.json.');
  }
}

/** Provider-scoped manual restore with a fresh rollback point and process guard. */
export async function restoreCodexLiveBackup(
  dir: string,
  options: {
    processInventory?: () => CodexProcessInfo[];
    inspectEffective?: () => Promise<CodexInspection>;
  } = {},
): Promise<void> {
  const selectedBeforePin = readCodexBackupManifest(dir);
  if (!selectedBeforePin) throw new Error('Selected directory is not a complete, reusable Codex live-auth backup.');
  if (selectedBeforePin.version !== 2) {
    throw new Error('This legacy Codex backup predates integrity manifests and cannot be restored automatically. Its files were preserved for manual recovery.');
  }
  const releaseSelectedBackup = acquireBackupRetentionLease(
    dir,
    'Codex backup selected for an in-progress restore.',
  );
  try {
    const selected = readCodexBackupManifest(dir);
    if (!selected || selected.version !== 2) {
      throw new Error('Selected Codex backup changed or disappeared before it could be pinned for restore.');
    }
  const processInventory = options.processInventory ?? findCodexProcesses;
  const beforeLock = processInventory();
  if (beforeLock.length) {
    throw new Error(`Close Codex before restoring authentication (process ${beforeLock.map((item) => item.pid).join(', ')}).`);
  }
  const inspectEffective = options.inspectEffective
    ?? (() => inspectCodexHome(codexHome(), false, { forceFileCredentials: false }));
  const beforeInspection = await inspectEffective();
  if (beforeInspection.credentialStore?.trim().toLowerCase() !== 'file') {
    throw new Error(
      `Codex restore requires cli_auth_credentials_store="file"; the effective store is ${beforeInspection.credentialStore ?? 'unresolved'}. Nothing changed.`,
    );
  }
  await withFileLock('codex-live-auth', async () => {
    const afterLock = processInventory();
    if (afterLock.length) {
      throw new Error(`A Codex process appeared before restore (process ${afterLock.map((item) => item.pid).join(', ')}). Nothing changed.`);
    }
    const rollback = backupLiveAuth();
    try {
      const afterBackup = processInventory();
      if (afterBackup.length) {
        throw new Error(
          `A Codex process appeared while the rollback backup was being created (process ${afterBackup.map((item) => item.pid).join(', ')}). Nothing changed.`,
        );
      }
    } catch (error) {
      releaseBackupProtectionSafely(rollback.dir);
      throw error;
    }
    try {
      restoreLiveAuth(dir, selected.hadAuth, selected.authSha256);
      assertLiveAuthMatchesCodexBackup(dir, selected);
      assertEffectiveCodexRestore(await inspectEffective(), dir, selected);
      releaseBackupProtectionSafely(rollback.dir);
    } catch (error) {
      if (error instanceof CodexAppServerShutdownError) {
        markManualRecovery(
          rollback.dir,
          'Codex restore validation left an app-server alive; rollback was deferred to avoid mutating credentials under that owner.',
        );
        throw new Error(
          `Codex restored the selected auth.json, but its validation helper did not exit. Automatic rollback was not attempted while that helper may still own the file. Manual recovery is available from ${rollback.dir}.`,
          { cause: error },
        );
      }
      try {
        restoreLiveAuth(rollback.dir, rollback.hadAuth, rollback.authSha256);
        const rollbackManifest = readCodexBackupManifest(rollback.dir);
        if (!rollbackManifest) throw new Error('The newly-created Codex rollback manifest became unreadable.');
        assertLiveAuthMatchesCodexBackup(rollback.dir, rollbackManifest);
        releaseBackupProtectionSafely(rollback.dir);
      } catch (rollbackError) {
        markManualRecovery(rollback.dir, 'Codex manual restore and rollback both failed.');
        throw new AggregateError(
          [error, rollbackError],
          `Codex restore failed and automatic rollback also failed. Manual recovery is required from ${rollback.dir}.`,
        );
      }
      throw new Error(`Codex restore failed; the previous live authentication was restored: ${String((error as Error).message ?? error)}`, {
        cause: error,
      });
    }
  }, { recoverAbandoned: true });
  } finally {
    try {
      releaseSelectedBackup();
    } catch (error) {
      logger.warn('Codex selected-backup retention lease could not be released', { dir, error: String(error) });
    }
  }
}

export async function restoreLatestCodexLiveBackup(): Promise<string | null> {
  const backups = listCodexLiveBackups();
  const latest = backups.at(-1) ?? null;
  if (!latest) return null;
  await restoreCodexLiveBackup(latest);
  return latest;
}

function writeLiveAuthFromProfile(profileId: string): void {
  const source = codexAuthPath(codexProfileHome(profileId));
  const auth = readCodexAuth(codexProfileHome(profileId));
  if (!auth || !fs.existsSync(source)) throw new Error('Target Codex profile has no reusable ChatGPT credentials.');
  const target = codexAuthPath();
  const leaseId = claimCodexAppServerHome(codexHome());
  try {
    atomicCopyFile(source, target);
  } finally {
    clearCodexLoginHelperMarker(codexHome(), leaseId);
  }
}

/** Replace only the live Codex auth file and restore it if validation fails. Caller owns the live-auth lock. */
async function applyCodexAuthTransactionUnlocked<T>(
  profileId: string,
  validate: () => Promise<T>,
  options: { processInventory?: () => CodexProcessInfo[] } = {},
): Promise<CodexAuthTransactionResult<T>> {
  const backup = backupLiveAuth();
  let authReplaced = false;
  try {
    const processes = (options.processInventory ?? findCodexProcesses)();
    if (processes.length) {
      throw new Error(
        `A Codex process appeared while the rollback backup was being created (process ${processes.map((item) => item.pid).join(', ')}). No credentials were changed.`,
      );
    }
    // Once the replacement function begins, any thrown durability error may have
    // happened after the atomic rename. Treat the live file as possibly changed and
    // take the rollback path conservatively.
    authReplaced = true;
    writeLiveAuthFromProfile(profileId);
    const value = await validate();
    releaseBackupProtectionSafely(backup.dir);
    return { ok: true, value, backupDir: backup.dir };
  } catch (error) {
    const validationError = error instanceof Error ? error : new Error(String(error));
    if (!authReplaced) {
      releaseBackupProtectionSafely(backup.dir);
      return { ok: false, error: validationError, backupDir: backup.dir, rollbackSucceeded: true };
    }
    if (validationError instanceof CodexAppServerShutdownError) {
      markManualRecovery(
        backup.dir,
        'Codex validation left an app-server alive; rollback was deferred to avoid mutating credentials under that owner.',
      );
      return {
        ok: false,
        error: validationError,
        backupDir: backup.dir,
        rollbackSucceeded: false,
        rollbackError: new Error('Rollback was deliberately deferred until the Codex app-server owner is proven stopped.'),
      };
    }
    try {
      restoreLiveAuth(backup.dir, backup.hadAuth, backup.authSha256);
      const manifest = readCodexBackupManifest(backup.dir);
      if (!manifest) throw new Error('The Codex rollback backup failed integrity verification after restore.');
      assertLiveAuthMatchesCodexBackup(backup.dir, manifest);
      releaseBackupProtectionSafely(backup.dir);
      return { ok: false, error: validationError, backupDir: backup.dir, rollbackSucceeded: true };
    } catch (rollbackError) {
      markManualRecovery(backup.dir, 'Codex live-auth rollback failed; transaction backup retained.');
      return {
        ok: false,
        error: validationError,
        backupDir: backup.dir,
        rollbackSucceeded: false,
        rollbackError: rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
      };
    }
  }
}

/** Serialize every direct live-auth replacement with switches and manual restores. */
export async function applyCodexAuthTransaction<T>(
  profileId: string,
  validate: () => Promise<T>,
  options: { processInventory?: () => CodexProcessInfo[] } = {},
): Promise<CodexAuthTransactionResult<T>> {
  return withFileLock(
    'codex-live-auth',
    () => applyCodexAuthTransactionUnlocked(profileId, validate, options),
    { recoverAbandoned: true },
  );
}

function inspectionMatchesTarget(
  target: { email: string },
  inspection: Awaited<ReturnType<typeof inspectCodexHome>>,
  fileAccountIdMatched: boolean,
): boolean {
  if (inspection.account?.type !== 'chatgpt') return false;
  // config/read exposes the storage policy, not the keyring account id. Replacing
  // auth.json cannot prove or change an `auto`/`keyring` effective login, even when two
  // workspaces happen to share the same email address.
  if (inspection.credentialStore?.trim().toLowerCase() !== 'file') return false;
  const expected = target.email.trim().toLowerCase();
  const actual = inspection.account.email?.trim().toLowerCase();
  if (!actual || !expected || expected.startsWith('(unknown')) {
    return fileAccountIdMatched;
  }
  return actual === expected;
}

function commitCodexActiveProfile(profileId: string): void {
  try {
    setActiveCodexProfile(profileId);
  } catch (error) {
    const committedPrimary = loadCodexStore();
    if (committedPrimary.activeProfileId === profileId) {
      logger.warn('Codex active profile committed but sidecar repair is pending', { profileId });
      return;
    }
    throw error;
  }
}

export async function switchCodexProfile(
  profileId: string,
  options: { mutationDeadlineAt?: number } = {},
): Promise<CodexSwitchResult> {
  const mutationDeadlineAt = configuredMutationDeadline(options.mutationDeadlineAt);
  return withFileLock('codex-live-auth', async () => {
    const observed = loadCodexStore().profiles.find((profile) => profile.id === profileId);
    if (!observed) return { ok: false, profileId, message: 'Codex profile not found.' };
    return withFileLock(codexCredentialLockName(observed.accountId), async () => {
    assertMutationDeadline(mutationDeadlineAt);
    const store = loadCodexStore();
    const target = store.profiles.find((profile) => profile.id === profileId);
    if (!target || target.accountId !== observed.accountId) {
      return { ok: false, profileId, message: 'Codex profile changed while waiting for its credential lock.' };
    }

    const outgoingState = readCodexAuthState(codexHome());
    if (outgoingState.status === 'corrupt') {
      return { ok: false, profileId, message: `${outgoingState.error.message} No credentials were changed.` };
    }
    const outgoingAuth = outgoingState.status === 'valid' ? outgoingState.auth : null;
    if (outgoingAuth?.tokens.account_id === target.accountId) {
      // Idempotency must be checked before refreshing the isolated copy: both copies can
      // belong to the same rotating chain, and refreshing the duplicate could invalidate
      // the still-live client for an operation that should have been a no-op.
      try {
        const effective = await inspectCodexHome(codexHome(), false, { forceFileCredentials: false });
        if (!inspectionMatchesTarget(target, effective, true)) {
          return {
            ok: false,
            profileId,
            message: `Codex's effective credential store does not match auth.json${effective.credentialStore ? ` (${effective.credentialStore})` : ''}. No credentials were changed.`,
          };
        }
        const reconciled = await reconcileLiveCodexUnlocked(false, {
          credentialLockHeldForAccountId: target.accountId,
        });
        if (reconciled.profile?.accountId !== target.accountId) throw new Error('The live Codex account could not be durably reconciled.');
        commitCodexActiveProfile(profileId);
        return { ok: true, profileId, message: `Codex is already authenticated as ${target.email}.` };
      } catch (error) {
        return { ok: false, profileId, message: String((error as Error).message ?? error) };
      }
    }

    try {
      assertNoProtectedCodexProcesses(findCodexProcesses());
    } catch (error) {
      return { ok: false, profileId, message: `${String((error as Error).message ?? error)} No credentials were changed.` };
    }

    try {
      assertMutationDeadline(mutationDeadlineAt);
      await inspectCodexHome(codexProfileHome(profileId), true);
      assertMutationDeadline(mutationDeadlineAt);
      const targetAuth = readCodexAuth(codexProfileHome(profileId));
      if (!targetAuth || targetAuth.tokens.account_id !== target.accountId) {
        throw new Error('Target Codex login could not be validated. Re-add the account.');
      }
    } catch (e) {
      return { ok: false, profileId, message: String((e as Error).message ?? e) };
    }

    let processes: CodexProcessInfo[];
    try {
      processes = findCodexProcesses();
    } catch (error) {
      return { ok: false, profileId, message: String((error as Error).message ?? error) };
    }
    try {
      assertNoProtectedCodexProcesses(processes);
    } catch (error) {
      return { ok: false, profileId, message: `${String((error as Error).message ?? error)} No credentials were changed.` };
    }
    const cliProcesses = processes.filter((proc) => proc.kind === 'cli');
    if (cliProcesses.length) {
      assertMutationDeadline(mutationDeadlineAt);
      let remainingCli: number[];
      try {
        remainingCli = await forceCloseCodexCliSessions();
      } catch (error) {
        return { ok: false, profileId, message: `${String((error as Error).message ?? error)} No credentials were changed.` };
      }
      if (remainingCli.length) {
        return {
          ok: false,
          profileId,
          message: `Codex CLI could not be closed (process ${remainingCli.join(', ')}). No credentials were changed.`,
        };
      }
    }
    const appProcesses = processes.filter((proc) => proc.kind === 'app');
    const appWasRunning = appProcesses.length > 0;
    if (appWasRunning) {
      try {
        assertMutationDeadline(mutationDeadlineAt);
        await requestGracefulAppClose(appProcesses);
      } catch (e) {
        return { ok: false, profileId, message: String((e as Error).message ?? e) };
      }
    }

    try {
      assertMutationDeadline(mutationDeadlineAt);
      const reconciled = await reconcileLiveCodexUnlocked(false, {
        credentialLockHeldForAccountId: target.accountId,
      });
      assertMutationDeadline(mutationDeadlineAt);
      if (outgoingAuth && reconciled.profile?.accountId !== outgoingAuth.tokens.account_id) {
        throw new Error('The outgoing Codex account could not be durably reconciled.');
      }
    } catch (e) {
      if (appWasRunning) relaunchCodexApp();
      logger.error('codex outgoing live auth could not be reconciled; switch aborted', e);
      return {
        ok: false,
        profileId,
        message: `Could not save the outgoing Codex account. No credentials were changed: ${String((e as Error).message ?? e)}`,
      };
    }

    assertMutationDeadline(mutationDeadlineAt);
    let respawnedCli: number[];
    try {
      respawnedCli = await forceCloseCodexCliSessions();
    } catch (error) {
      if (appWasRunning) relaunchCodexApp();
      return { ok: false, profileId, message: `${String((error as Error).message ?? error)} No credentials were changed.` };
    }
    if (respawnedCli.length) {
      if (appWasRunning) relaunchCodexApp();
      return {
        ok: false,
        profileId,
        message: `Codex CLI kept restarting (process ${respawnedCli.join(', ')}). No credentials were changed.`,
      };
    }

    const remaining = findCodexProcesses();
    if (remaining.length) {
      if (appWasRunning && !remaining.some((proc) => proc.kind === 'app')) relaunchCodexApp();
      return {
        ok: false,
        profileId,
        message: `A Codex process appeared during the switch (${remaining.map((proc) => proc.pid).join(', ')}). Nothing changed.`,
      };
    }

    assertMutationDeadline(mutationDeadlineAt);
    const applied = await applyCodexAuthTransactionUnlocked(profileId, async () => {
      // auth.json has already been replaced at this point. A forced refresh here would
      // rotate the new live token before it is synchronized or before rollback can use
      // the exact installed credential, so post-write validation is strictly read-only.
      const effective = await inspectCodexHome(codexHome(), false, { forceFileCredentials: false });
      assertMutationDeadline(mutationDeadlineAt);
      const liveState = readCodexAuthState(codexHome());
      if (liveState.status === 'corrupt') throw liveState.error;
      const live = liveState.status === 'valid' ? liveState.auth : null;
      if (!live || live.tokens.account_id !== target.accountId) {
        throw new Error('Codex loaded a different account after the switch.');
      }
      if (!inspectionMatchesTarget(target, effective, true)) {
        throw new Error(
          `Codex did not select the switched auth.json${effective.credentialStore ? ` (effective store: ${effective.credentialStore})` : ''}.`,
        );
      }
      assertMutationDeadline(mutationDeadlineAt);
      syncCodexProfileAuthFromHome(profileId, codexHome());
      commitCodexActiveProfile(profileId);
    }, { processInventory: findCodexProcesses });
    if (!applied.ok) {
      if (appWasRunning) relaunchCodexApp();
      logger.error(
        applied.rollbackSucceeded ? 'codex switch failed and rolled back' : 'codex switch and rollback both failed',
        applied.rollbackError ?? applied.error,
        { profileId, backupDir: applied.backupDir },
      );
      return {
        ok: false,
        profileId,
        backupDir: applied.backupDir,
        message: applied.rollbackSucceeded
          ? `${applied.error.message} Previous Codex auth was restored.`
          : `${applied.error.message} Rollback also failed: ${applied.rollbackError?.message ?? 'unknown rollback error'}. Manual recovery is required from ${applied.backupDir}.`,
      };
    }
    if (appWasRunning) relaunchCodexApp();
    logger.info('codex account switched', { email: target.email, backupDir: applied.backupDir });
    return { ok: true, profileId, backupDir: applied.backupDir, message: `Codex is now authenticated as ${target.email}.` };
    }, { timeoutMs: lockTimeoutBefore(mutationDeadlineAt) });
  }, { timeoutMs: lockTimeoutBefore(mutationDeadlineAt), recoverAbandoned: true });
}

function jobDir(): string {
  return path.join(dataDir(), 'jobs');
}

function cleanupCodexJobs(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    for (const file of fs.readdirSync(jobDir())) {
      if (!/^codex-switch-[a-f0-9-]+\.json$/i.test(file)) continue;
      const target = path.join(jobDir(), file);
      if (Date.now() - fs.statSync(target).mtimeMs > maxAgeMs) fs.rmSync(target, { force: true });
    }
  } catch {
    /* no jobs yet */
  }
}

export function startCodexSwitchWorker(profileId: string): { jobId: string; resultPath: string } {
  ensureDataDirs();
  cleanupCodexJobs();
  const jobId = crypto.randomUUID();
  const resultPath = path.join(jobDir(), `codex-switch-${jobId}.json`);
  ensurePrivateDir(jobDir());
  const now = Date.now();
  const child = spawn(process.execPath, [path.resolve(process.argv[1]), 'codex-switch-worker', profileId, resultPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT: String(now + CODEX_WORKER_MUTATION_WINDOW_MS),
      CLAUDE_SWITCH_CODEX_RESULT_DEADLINE_AT: String(now + CODEX_WORKER_RESULT_WINDOW_MS),
    },
  });
  child.unref();
  return { jobId, resultPath };
}

export async function runCodexSwitchWorker(profileId: string, resultPath: string): Promise<CodexSwitchResult> {
  const resolvedResult = path.resolve(resultPath);
  const allowedRoot = `${path.resolve(jobDir())}${path.sep}`;
  if (!resolvedResult.startsWith(allowedRoot) || !/^codex-switch-[a-f0-9-]+\.json$/i.test(path.basename(resolvedResult))) {
    throw new Error('Invalid Codex switch worker result path.');
  }
  const startedAt = Date.now();
  const mutationDeadlineAt = configuredMutationDeadline() ?? startedAt + CODEX_WORKER_MUTATION_WINDOW_MS;
  const inheritedResultDeadline = Number(process.env.CLAUDE_SWITCH_CODEX_RESULT_DEADLINE_AT);
  const resultDeadline = Number.isFinite(inheritedResultDeadline) && inheritedResultDeadline > 0
    ? inheritedResultDeadline
    : startedAt + CODEX_WORKER_RESULT_WINDOW_MS;
  // mutateCodexStore/writeProfileAuth enforce this independently, so even a delayed
  // continuation cannot commit after the worker's forward-mutation window.
  process.env.CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT = String(mutationDeadlineAt);
  let result: CodexSwitchResult;
  try {
    result = await switchCodexProfile(profileId, {
      mutationDeadlineAt,
    });
  } catch (e) {
    result = { ok: false, profileId, message: String((e as Error).message ?? e) };
  }
  if (Date.now() < resultDeadline) {
    ensurePrivateDir(path.dirname(resolvedResult));
    atomicWriteFile(resolvedResult, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

export async function waitForCodexSwitchResult(resultPath: string, timeoutMs = 180_000): Promise<CodexSwitchResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as CodexSwitchResult;
      fs.rmSync(resultPath, { force: true });
      return result;
    } catch {
      await sleep(300);
    }
  }
  throw new Error('Timed out waiting for the Codex switch worker. Check the switcher log.');
}
