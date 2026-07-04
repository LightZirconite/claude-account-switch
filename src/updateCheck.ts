// Lightweight update check: compare local package version to the one published on
// GitHub. Best-effort, silent on any failure (offline, rate-limited, etc).
import { logger } from './logger';

const REMOTE_PKG_URL =
  'https://raw.githubusercontent.com/LightZirconite/claude-account-switch/refs/heads/main/package.json';

function parseSemver(v: string): number[] {
  return v
    .trim()
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote: string, local: string): boolean {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

export interface UpdateInfo {
  available: boolean;
  remoteVersion?: string;
}

export async function checkForUpdate(localVersion: string): Promise<UpdateInfo> {
  try {
    const res = await fetch(REMOTE_PKG_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { available: false };
    const data = (await res.json()) as { version?: string };
    if (!data.version) return { available: false };
    const available = isNewer(data.version, localVersion);
    if (available) logger.info('update available', { local: localVersion, remote: data.version });
    return { available, remoteVersion: data.version };
  } catch (e) {
    logger.warn('update check failed (ignored)', { error: String(e) });
    return { available: false };
  }
}
