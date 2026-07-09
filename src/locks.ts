import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDataDirs } from './paths';
import { logger } from './logger';

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const POLL_MS = 100;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 120);
}

function lockPath(name: string): string {
  return path.join(dataDir(), 'locks', `${safeName(name)}.lock`);
}

function tryAcquire(name: string, staleMs: number): string | null {
  ensureDataDirs();
  const p = lockPath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now(), name }) + '\n', 'utf8');
    return p;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      const age = Date.now() - fs.statSync(p).mtimeMs;
      if (age > staleMs) {
        fs.rmSync(p, { recursive: true, force: true });
        logger.warn('removed stale lock', { name, ageMs: Math.round(age) });
      }
    } catch {
      /* retry below */
    }
    return null;
  }
}

function release(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function withFileLockSync<T>(
  name: string,
  fn: () => T,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): T {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let held: string | null = null;
  while (!held) {
    held = tryAcquire(name, staleMs);
    if (held) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${name}`);
    sleepSync(POLL_MS);
  }
  try {
    return fn();
  } finally {
    release(held);
  }
}

export async function withFileLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let held: string | null = null;
  while (!held) {
    held = tryAcquire(name, staleMs);
    if (held) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${name}`);
    await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    release(held);
  }
}
