import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, ensureDataDirs } from './paths';

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

interface FileLockOptions {
  staleMs?: number;
  timeoutMs?: number;
  recoverAbandoned?: boolean;
}

function validOwner(owner: LockOwner | null, expectedName: string): owner is LockOwner {
  return !!owner
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.ownerId === 'string'
    && owner.ownerId.length > 0
    && Number.isFinite(owner.at)
    && owner.name === expectedName;
}

export class AbandonedFileLockError extends Error {
  constructor(readonly lockName: string, readonly lockDirectory: string) {
    super(
      `Lock "${lockName}" appears abandoned. It was retained to avoid deleting a concurrently reacquired lock; verify no owner is running, then remove ${lockDirectory} manually.`,
    );
    this.name = 'AbandonedFileLockError';
  }
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
        // Never unlink a stale-looking lock here. Another waiter may already have
        // removed/reacquired it after this process observed the old owner, and an
        // unfenced rmSync would then delete the fresh owner's lock directory.
        throw new AbandonedFileLockError(name, p);
      }
    } catch (error) {
      if (error instanceof AbandonedFileLockError) throw error;
      /* A transient stat/read race is retried without deleting anything. */
    }
    return null;
  }
}

/**
 * Reclaim one lock whose recorded owner is provably dead.
 *
 * This is deliberately unavailable to ordinary waiters. A secondary, independently
 * owned takeover lock serializes the only removers, and the primary ownerId is reread
 * immediately before deletion. Normal acquirers cannot take the primary until after
 * its directory has been removed, at which point this function performs no more
 * deletions. A stale/corrupt takeover lock itself remains fail-closed.
 */
function reclaimAbandonedLock(name: string, staleMs: number): boolean {
  const takeoverName = `${name}.abandoned-takeover`;
  const takeover = tryAcquire(takeoverName, staleMs);
  // Recovery is already fenced by another process. Let this waiter retry the
  // primary lock instead of turning a safe, transient takeover into a failure.
  if (!takeover) return false;
  try {
    const selected = lockPath(name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(selected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    const owner = readOwner(selected);
    const ownerIsValid = validOwner(owner, name);
    if (ownerIsValid) {
      if (processAlive(owner.pid)) return false;
    } else if (Date.now() - stat.mtimeMs <= staleMs) {
      // Missing/corrupt ownership metadata cannot prove an immediate crash. Require
      // the normal stale interval and preserve it for manual inspection until then.
      return false;
    }

    const rechecked = readOwner(selected);
    if (ownerIsValid) {
      if (!validOwner(rechecked, name)
        || rechecked.ownerId !== owner.ownerId
        || rechecked.pid !== owner.pid
        || processAlive(rechecked.pid)) return false;
    } else {
      let currentStat: fs.Stats;
      try {
        currentStat = fs.statSync(selected);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      }
      if (validOwner(rechecked, name)
        || currentStat.mtimeMs !== stat.mtimeMs
        || currentStat.ctimeMs !== stat.ctimeMs) return false;
    }

    fs.rmSync(selected, { recursive: true, force: false });
    return true;
  } finally {
    release(takeover);
  }
}

function tryAcquireWithRecovery(
  name: string,
  staleMs: number,
  recoverAbandoned: boolean,
): HeldLock | null {
  let held: HeldLock | null;
  try {
    held = tryAcquire(name, staleMs);
  } catch (error) {
    if (!(error instanceof AbandonedFileLockError) || !recoverAbandoned) throw error;
    reclaimAbandonedLock(name, staleMs);
    return null;
  }
  if (held || !recoverAbandoned) return held;

  const owner = readOwner(lockPath(name));
  // A valid dead owner is conclusive even before the generic stale interval. This
  // makes recovery immediate after a crash or reboot while corrupt owner metadata
  // remains subject to the stale interval and the generation fence above.
  if (validOwner(owner, name) && !processAlive(owner.pid)) {
    reclaimAbandonedLock(name, staleMs);
  }
  return null;
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
  opts: FileLockOptions = {},
): T {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let held: HeldLock | null = null;
  while (!held) {
    held = tryAcquireWithRecovery(name, staleMs, opts.recoverAbandoned === true);
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
  opts: FileLockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let held: HeldLock | null = null;
  while (!held) {
    held = tryAcquireWithRecovery(name, staleMs, opts.recoverAbandoned === true);
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
