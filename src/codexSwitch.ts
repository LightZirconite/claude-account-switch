import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { codexAuthPath, codexHome, codexProfileHome, backupsDir, dataDir, ensureDataDirs } from './paths';
import { inspectCodexHome } from './codexAppServer';
import {
  loadCodexStore,
  readCodexAuth,
  reconcileLiveCodex,
  setActiveCodexProfile,
  syncCodexProfileAuthFromHome,
} from './codexProfiles';
import { withFileLock } from './locks';
import { logger } from './logger';

export interface CodexProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  kind: 'app' | 'cli';
}

export interface CodexSwitchResult {
  ok: boolean;
  profileId: string;
  message: string;
  backupDir?: string;
}

interface RawProcess {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string;
  CommandLine?: string;
  ExecutablePath?: string;
}

export type CodexAuthTransactionResult<T> =
  | { ok: true; value: T; backupDir: string }
  | { ok: false; error: Error; backupDir: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GRACEFUL_DESKTOP_CLOSE_MS = 8_000;
const FORCED_DESKTOP_CLOSE_WAIT_MS = 10_000;

function windowsProcesses(): RawProcess[] {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'codex.exe' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress",
  ].join('; ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    if (!out) return [];
    const value = JSON.parse(out) as RawProcess | RawProcess[];
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

function unixProcesses(): RawProcess[] {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 10_000 });
    return out.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match || !/(?:^|\/)(?:codex|ChatGPT)(?:\.exe)?$/i.test(match[3])) return [];
      return [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Name: match[3], CommandLine: match[4], ExecutablePath: match[3] }];
    });
  } catch {
    return [];
  }
}

export function findCodexProcesses(): CodexProcessInfo[] {
  const rows = process.platform === 'win32' ? windowsProcesses() : unixProcesses();
  const appPids = new Set(rows.filter((row) => {
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
    for (const row of rows) {
      if (appPids.has(Number(row.ParentProcessId)) && !appPids.has(Number(row.ProcessId))) {
        appPids.add(Number(row.ProcessId));
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => Number(row.ProcessId) > 0 && Number(row.ProcessId) !== process.pid)
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: row.Name ?? 'codex',
      commandLine: row.CommandLine ?? '',
      kind: appPids.has(Number(row.ProcessId)) ? 'app' : 'cli',
    }));
}

export function remainingTrackedProcessIds(initialPids: ReadonlySet<number>, current: CodexProcessInfo[]): number[] {
  return current.filter((process) => initialPids.has(process.pid)).map((process) => process.pid);
}

export function codexProcessRootIds(processes: CodexProcessInfo[]): number[] {
  const pids = new Set(processes.map((process) => process.pid));
  return processes.filter((process) => !pids.has(process.ppid)).map((process) => process.pid);
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
  const deadline = Date.now() + timeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const cliProcesses = findCodexProcesses().filter((process) => process.kind === 'cli');
    if (cliProcesses.length) {
      quietSince = 0;
      forceTerminateCodexProcessTrees(cliProcesses);
    } else {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 1_000) return [];
    }
    await sleep(250);
  }
  return findCodexProcesses().filter((process) => process.kind === 'cli').map((process) => process.pid);
}

function forceTerminateCodexProcessTrees(processes: CodexProcessInfo[]): void {
  const roots = codexProcessRootIds(processes);
  if (process.platform === 'win32') {
    for (const pid of roots) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
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

async function requestGracefulAppClose(appProcesses: CodexProcessInfo[]): Promise<void> {
  const initialPids = new Set(appProcesses.map((process) => process.pid));
  if (!initialPids.size) return;
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
  const remainingAfterGracefulClose = await waitForTrackedProcessesToExit(initialPids, GRACEFUL_DESKTOP_CLOSE_MS);
  if (!remainingAfterGracefulClose.length) return;

  // The Windows Codex Desktop app can turn a CloseMainWindow request into a
  // tray minimization. The user already confirmed this switch, so terminate
  // only the observed Desktop process tree.
  forceTerminateCodexProcessTrees(appProcesses);
  const remainingAfterForce = await waitForTrackedProcessesToExit(initialPids, FORCED_DESKTOP_CLOSE_WAIT_MS);
  if (!remainingAfterForce.length) return;
  throw new Error(`Codex Desktop could not be closed (process ${remainingAfterForce.join(', ')}). No credentials were changed.`);
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

function backupLiveAuth(): { dir: string; hadAuth: boolean } {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsDir(), 'codex-live', stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = codexAuthPath();
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, 'auth.json'));
  return { dir, hadAuth: fs.existsSync(source) };
}

function restoreLiveAuth(backupDir: string, hadAuth: boolean): void {
  const target = codexAuthPath();
  const source = path.join(backupDir, 'auth.json');
  if (hadAuth && fs.existsSync(source)) fs.copyFileSync(source, target);
  else fs.rmSync(target, { force: true });
}

function writeLiveAuthFromProfile(profileId: string): void {
  const source = codexAuthPath(codexProfileHome(profileId));
  const auth = readCodexAuth(codexProfileHome(profileId));
  if (!auth || !fs.existsSync(source)) throw new Error('Target Codex profile has no reusable ChatGPT credentials.');
  const target = codexAuthPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.switch-${process.pid}`;
  fs.copyFileSync(source, temp);
  if (process.platform !== 'win32') fs.chmodSync(temp, 0o600);
  try {
    fs.renameSync(temp, target);
  } catch {
    fs.copyFileSync(temp, target);
    fs.rmSync(temp, { force: true });
  }
}

/** Replace only the live Codex auth file and restore it if validation fails. */
export async function applyCodexAuthTransaction<T>(
  profileId: string,
  validate: () => Promise<T>,
): Promise<CodexAuthTransactionResult<T>> {
  const backup = backupLiveAuth();
  try {
    writeLiveAuthFromProfile(profileId);
    return { ok: true, value: await validate(), backupDir: backup.dir };
  } catch (error) {
    restoreLiveAuth(backup.dir, backup.hadAuth);
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      backupDir: backup.dir,
    };
  }
}

export async function switchCodexProfile(profileId: string): Promise<CodexSwitchResult> {
  return withFileLock('codex-live-switch', async () => {
    return withFileLock(`codex-account-${profileId}`, async () => {
    const store = loadCodexStore();
    const target = store.profiles.find((profile) => profile.id === profileId);
    if (!target) return { ok: false, profileId, message: 'Codex profile not found.' };

    try {
      await inspectCodexHome(codexProfileHome(profileId), true);
      const targetAuth = readCodexAuth(codexProfileHome(profileId));
      if (!targetAuth || targetAuth.tokens.account_id !== target.accountId) {
        throw new Error('Target Codex login could not be validated. Re-add the account.');
      }
    } catch (e) {
      return { ok: false, profileId, message: String((e as Error).message ?? e) };
    }

    const processes = findCodexProcesses();
    const cliProcesses = processes.filter((proc) => proc.kind === 'cli');
    if (cliProcesses.length) {
      const remainingCli = await forceCloseCodexCliSessions();
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
        await requestGracefulAppClose(appProcesses);
      } catch (e) {
        return { ok: false, profileId, message: String((e as Error).message ?? e) };
      }
    }

    try {
      await reconcileLiveCodex();
    } catch (e) {
      logger.warn('codex outgoing live auth could not be reconciled', { error: String(e) });
    }

    const respawnedCli = await forceCloseCodexCliSessions();
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

    const applied = await applyCodexAuthTransaction(profileId, async () => {
      await inspectCodexHome(codexHome(), true);
      const live = readCodexAuth(codexHome());
      if (!live || live.tokens.account_id !== target.accountId) {
        throw new Error('Codex loaded a different account after the switch.');
      }
      syncCodexProfileAuthFromHome(profileId, codexHome());
      setActiveCodexProfile(profileId);
    });
    if (!applied.ok) {
      if (appWasRunning) relaunchCodexApp();
      logger.error('codex switch failed and rolled back', applied.error, { profileId, backupDir: applied.backupDir });
      return {
        ok: false,
        profileId,
        backupDir: applied.backupDir,
        message: `${applied.error.message} Previous Codex auth was restored.`,
      };
    }
    if (appWasRunning) relaunchCodexApp();
    logger.info('codex account switched', { email: target.email, backupDir: applied.backupDir });
    return { ok: true, profileId, backupDir: applied.backupDir, message: `Codex is now authenticated as ${target.email}.` };
    });
  });
}

function jobDir(): string {
  return path.join(dataDir(), 'jobs');
}

export function startCodexSwitchWorker(profileId: string): { jobId: string; resultPath: string } {
  ensureDataDirs();
  const jobId = crypto.randomUUID();
  const resultPath = path.join(jobDir(), `codex-switch-${jobId}.json`);
  fs.mkdirSync(jobDir(), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [path.resolve(process.argv[1]), 'codex-switch-worker', profileId, resultPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { jobId, resultPath };
}

export async function runCodexSwitchWorker(profileId: string, resultPath: string): Promise<CodexSwitchResult> {
  let result: CodexSwitchResult;
  try {
    result = await switchCodexProfile(profileId);
  } catch (e) {
    result = { ok: false, profileId, message: String((e as Error).message ?? e) };
  }
  fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
