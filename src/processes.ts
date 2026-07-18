// Detect running `claude` processes so a switch can fail closed until the user has
// ended them normally. Claude is never force-killed: an in-memory client could still
// own a rotating refresh token or unsaved work.
import { execFileSync } from 'node:child_process';
import { logger } from './logger';
import { findClaudeExe } from './paths';

export interface ProcInfo {
  pid: number;
  name: string;
}

interface RawProc {
  pid: number;
  ppid: number;
  name: string;
}

function snapshotWindows(): RawProc[] {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '$ErrorActionPreference = "Stop"; $items = Get-CimInstance Win32_Process -ErrorAction Stop; "__SWITCHER_CIM_OK__"; $items | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000, windowsHide: true },
  );
  const lines = out.split(/\r?\n/);
  if (lines[0]?.trim() !== '__SWITCHER_CIM_OK__') throw new Error('Windows process inventory did not return its success marker.');
  const res: RawProc[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const name = parts.slice(2).join('|').trim();
    if (pid) res.push({ pid, ppid: ppid || 0, name });
  }
  return res;
}

export function findClaudeProcesses(): ProcInfo[] {
  if (process.platform !== 'win32') return findClaudeUnix(/claude/i);
  try {
    const procs = snapshotWindows();
    // Do not hide a Claude ancestor. Running this switcher from inside Claude is
    // exactly the unsafe case: that ancestor can still own the outgoing refresh chain.
    return procs
      .filter((p) => /^claude\.exe$/i.test(p.name))
      .map((p) => ({ pid: p.pid, name: p.name }));
  } catch (e) {
    logger.error('findClaudeProcesses failed', e);
    throw new Error(`Could not safely inspect running Claude processes: ${String((e as Error).message ?? e)}`);
  }
}

function findClaudeUnix(namePattern: RegExp): ProcInfo[] {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8', timeout: 15_000 });
    const res: ProcInfo[] = [];
    for (const line of out.split(/\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) {
        const pid = parseInt(m[1], 10);
        const name = m[2];
        if (pid && pid !== process.pid && namePattern.test(name)) res.push({ pid, name });
      }
    }
    return res;
  } catch (e) {
    logger.error('findClaudeProcesses failed', e);
    throw new Error(`Could not safely inspect running Claude processes: ${String((e as Error).message ?? e)}`);
  }
}

export function detectClaudeVersion(): string {
  try {
    const out = execFileSync(findClaudeExe(), ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : '2.1.201';
  } catch {
    return '2.1.201';
  }
}
