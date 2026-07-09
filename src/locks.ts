import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

interface HeldLock {
  path: string;
  ownerId: string;
}

interface LockOwner {
  pid: number;
  ownerId: string;
  at: number;
  name: string;
}

function readOwner(p: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(p, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquire(name: string, staleMs: number): HeldLock | null {
  ensureDataDirs();
  const p = lockPath(name);
  const ownerId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify({ pid: process.pid, ownerId, at: Date.now(), name }) + '\n', 'utf8');
    return { path: p, ownerId };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      const age = Date.now() - fs.statSync(p).mtimeMs;
      const owner = readOwner(p);
      if (age > staleMs && (!owner || !processAlive(owner.pid))) {
        fs.rmSync(p, { recursive: true, force: true });
        logger.warn('removed stale lock', { name, ageMs: Math.round(age) });
      }
    } catch {
      /* retry below */
    }
    return null;
  }
}

function release(held: HeldLock): void {
  try {
    const owner = readOwner(held.path);
    if (owner?.ownerId === held.ownerId) {
      fs.rmSync(held.path, { recursive: true, force: true });
    }
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
  let held: HeldLock | null = null;
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
  let held: HeldLock | null = null;
  while (!held) {
    held = tryAcquire(name, staleMs);
    if (held) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${name}`);
    await sleep(POLL_MS);
  }
  const heartbeat = setInterval(() => {
    try {
      const owner = readOwner(held!.path);
      if (owner?.ownerId === held!.ownerId) {
        const now = new Date();
        fs.utimesSync(held!.path, now, now);
      }
    } catch {
      /* ownership verification in release remains authoritative */
    }
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    release(held);
  }
}
