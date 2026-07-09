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
}

export type CodexAuthTransactionResult<T> =
  | { ok: true; value: T; backupDir: string }
  | { ok: false; error: Error; backupDir: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function windowsProcesses(): RawProcess[] {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'codex.exe' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
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
      return [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Name: match[3], CommandLine: match[4] }];
    });
  } catch {
    return [];
  }
}

export function findCodexProcesses(): CodexProcessInfo[] {
  const rows = process.platform === 'win32' ? windowsProcesses() : unixProcesses();
  const appPids = new Set(rows.filter((row) => /chatgpt/i.test(row.Name ?? '')).map((row) => Number(row.ProcessId)));
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

async function requestGracefulAppClose(): Promise<void> {
  if (process.platform === 'win32') {
    const script = "Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }";
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    execFileSync('osascript', ['-e', 'tell application "Codex" to quit'], { timeout: 10_000 });
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!findCodexProcesses().some((proc) => proc.kind === 'app')) return;
    await sleep(500);
  }
  throw new Error('Codex did not close cleanly. No credentials were changed.');
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
      const inspection = await inspectCodexHome(codexProfileHome(profileId), true);
      const targetAuth = readCodexAuth(codexProfileHome(profileId));
      if (inspection.account?.type !== 'chatgpt' || targetAuth?.tokens.account_id !== target.accountId) {
        throw new Error('Target Codex login could not be validated. Re-add the account.');
      }
    } catch (e) {
      return { ok: false, profileId, message: String((e as Error).message ?? e) };
    }

    const processes = findCodexProcesses();
    const cli = processes.filter((proc) => proc.kind === 'cli');
    if (cli.length) {
      return {
        ok: false,
        profileId,
        message: `Close the running Codex CLI session(s) first: ${cli.map((proc) => proc.pid).join(', ')}. Nothing changed.`,
      };
    }
    const appWasRunning = processes.some((proc) => proc.kind === 'app');
    if (appWasRunning) {
      try {
        await requestGracefulAppClose();
      } catch (e) {
        return { ok: false, profileId, message: String((e as Error).message ?? e) };
      }
    }

    try {
      await reconcileLiveCodex();
    } catch (e) {
      logger.warn('codex outgoing live auth could not be reconciled', { error: String(e) });
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
      const validation = await inspectCodexHome(codexHome(), true);
      const live = readCodexAuth(codexHome());
      if (validation.account?.type !== 'chatgpt' || live?.tokens.account_id !== target.accountId) {
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
