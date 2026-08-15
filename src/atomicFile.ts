import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

/** Create a private directory and tighten an existing directory where supported. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch (error) {
    // Windows ACLs are not represented faithfully by POSIX mode bits. Creation still
    // uses the restrictive mode, but chmod remains best-effort on that platform.
    if (process.platform !== 'win32') throw error;
  }
}

/** Ensure a parent exists without changing permissions on an existing generic directory. */
function ensureParentDir(dir: string): void {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) throw new Error(`Atomic-write parent is not a directory: ${dir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
}

function uniqueTempPath(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  return path.join(dir, `.${base}.tmp-${process.pid}-${crypto.randomUUID()}`);
}

function setPrivateFileMode(fd: number, mode: number): void {
  try {
    fs.fchmodSync(fd, mode);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

/**
 * Durably replace a file without ever falling back to a direct target write.
 *
 * The temporary file is exclusive, lives beside the target, is flushed before the
 * rename, and is removed on every pre-rename failure. If the platform cannot replace
 * the target atomically, the operation fails and leaves the existing target untouched.
 */
export function atomicWriteFile(
  target: string,
  content: string | Buffer,
  mode = DEFAULT_FILE_MODE,
): void {
  // A target may live directly under HOME (for example ~/.claude.json). Tightening
  // that already-existing parent to 0700 would be an unexpected, system-wide side
  // effect, so only newly-created parents receive our private creation mode here.
  ensureParentDir(path.dirname(target));
  const temp = uniqueTempPath(target);
  let fd: number | null = null;
  let renamed = false;

  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, content);
    setPrivateFileMode(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // Deliberately fail closed. A copy/direct-write fallback could truncate a valid
    // credential file if the process, disk, or antivirus interrupts replacement.
    fs.renameSync(temp, target);
    renamed = true;
    if (process.platform !== 'win32') {
      let dirFd: number | null = null;
      try {
        dirFd = fs.openSync(path.dirname(target), 'r');
        fs.fsyncSync(dirFd);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Some virtual/network filesystems do not support directory fsync. The file
        // itself was already flushed and atomically renamed; unsupported directory
        // durability is the only best-effort exception.
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
      } finally {
        if (dirFd !== null) fs.closeSync(dirFd);
      }
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* preserve the original failure */
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* preserve the original failure */
      }
    }
  }
}

/** Stream one bounded source range into a flushed sibling, then atomically replace the target. */
export function atomicCopyFileRange(
  source: string,
  sourceOffset: number,
  length: number,
  target: string,
  mode = DEFAULT_FILE_MODE,
): void {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0
    || !Number.isSafeInteger(length) || length < 0
    || !Number.isSafeInteger(sourceOffset + length)) {
    throw new Error('Atomic copy range must use non-negative safe integers.');
  }
  const sourceStat = fs.statSync(source);
  if (!sourceStat.isFile() || sourceOffset + length > sourceStat.size) {
    throw new Error(`Atomic copy range exceeds its regular source file: ${source}`);
  }
  ensureParentDir(path.dirname(target));
  const temp = uniqueTempPath(target);
  let sourceFd: number | null = null;
  let targetFd: number | null = null;
  let renamed = false;
  try {
    sourceFd = fs.openSync(source, 'r');
    targetFd = fs.openSync(temp, 'wx', mode);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0;
    while (copied < length) {
      const wanted = Math.min(buffer.length, length - copied);
      const read = fs.readSync(sourceFd, buffer, 0, wanted, sourceOffset + copied);
      if (!read) throw new Error(`Atomic copy source ended early: ${source}`);
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(targetFd, buffer, written, read - written);
        if (!count) throw new Error(`Atomic copy target stopped accepting data: ${target}`);
        written += count;
      }
      copied += read;
    }
    setPrivateFileMode(targetFd, mode);
    fs.fsyncSync(targetFd);
    fs.closeSync(targetFd);
    targetFd = null;
    fs.closeSync(sourceFd);
    sourceFd = null;
    fs.renameSync(temp, target);
    renamed = true;
    if (process.platform !== 'win32') {
      let dirFd: number | null = null;
      try {
        dirFd = fs.openSync(path.dirname(target), 'r');
        fs.fsyncSync(dirFd);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
      } finally {
        if (dirFd !== null) fs.closeSync(dirFd);
      }
    }
  } finally {
    if (targetFd !== null) {
      try { fs.closeSync(targetFd); } catch { /* preserve the original failure */ }
    }
    if (sourceFd !== null) {
      try { fs.closeSync(sourceFd); } catch { /* preserve the original failure */ }
    }
    if (!renamed) {
      try { fs.rmSync(temp, { force: true }); } catch { /* preserve the original failure */ }
    }
  }
}

/** Stream a complete source file with bounded memory, then atomically replace the target. */
export function atomicCopyFile(source: string, target: string, mode = DEFAULT_FILE_MODE): void {
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error(`Atomic copy source is not a regular file: ${source}`);
  atomicCopyFileRange(source, 0, stat.size, target, mode);
}
