// Detect and close running `claude` processes so a fresh launch picks up the new
// account. Never touches our own process or its ancestor chain (the terminal).
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
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const res: RawProc[] = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const name = parts.slice(2).join('|').trim();
    if (pid) res.push({ pid, ppid: ppid || 0, name });
  }
  return res;
}

/** Ancestor PIDs of the current process (so we never kill our own terminal). */
function selfAncestry(procs: RawProc[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const anc = new Set<number>();
  let cur: number | undefined = process.pid;
  while (cur && byPid.has(cur) && !anc.has(cur)) {
    anc.add(cur);
    cur = byPid.get(cur)!.ppid;
  }
  anc.add(process.pid);
  if (process.ppid) anc.add(process.ppid);
  return anc;
}

export function findClaudeProcesses(): ProcInfo[] {
  if (process.platform !== 'win32') return findClaudeUnix();
  try {
    const procs = snapshotWindows();
    const anc = selfAncestry(procs);
    return procs
      .filter((p) => /^claude\.exe$/i.test(p.name) && !anc.has(p.pid))
      .map((p) => ({ pid: p.pid, name: p.name }));
  } catch (e) {
    logger.error('findClaudeProcesses failed', e);
    return [];
  }
}

function findClaudeUnix(): ProcInfo[] {
  try {
    const out = execFileSync('bash', ['-c', "ps -eo pid=,comm= | grep -i claude || true"], { encoding: 'utf8' });
    const res: ProcInfo[] = [];
    for (const line of out.split(/\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) {
        const pid = parseInt(m[1], 10);
        if (pid && pid !== process.pid && pid !== process.ppid) res.push({ pid, name: m[2] });
      }
    }
    return res;
  } catch {
    return [];
  }
}

export function closeProcesses(pids: number[]): { closed: number[]; failed: number[] } {
  const closed: number[] = [];
  const failed: number[] = [];
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      closed.push(pid);
    } catch {
      failed.push(pid);
    }
  }
  logger.info('closed claude processes', { closed, failed });
  return { closed, failed };
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
