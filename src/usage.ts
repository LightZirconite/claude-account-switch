// Per-account usage/quota via the undocumented oauth/usage endpoint.
// Aggressively rate-limited: cache hard, degrade gracefully.
import { logger } from './logger';
import { withFileLock } from './locks';
import { refreshToken, type TokenSet } from './oauth';
import { findByAccountUuid, findByEmail, loadStore, saveStore } from './profiles';
import { hasCliAuth, type Profile, type UsageInfo } from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 10 * 60 * 1000; // usage only changes every few hours
const MIN_INTERVAL_MS = 30 * 1000; // hard floor: never hit the endpoint more than once / 30s per account

// The OAuth refresh token ROTATES: every successful refresh invalidates the token we
// sent and returns a new one. Two refreshes racing on the same account would both send
// the same token — the first rotates it away, the second gets invalid_grant and would
// (wrongly) flag a perfectly healthy account as dead. So we single-flight refreshes per
// account: a second caller awaits the first's result instead of POSTing a now-stale token.
const inFlightRefresh = new Map<string, Promise<TokenSet | null>>();
// Last time we ATTEMPTED a refresh for an account (success or failure), used as a hard
// floor for concurrent/stale UI paths. Known-dead accounts are not retried at all.
const lastRefreshAttempt = new Map<string, number>();

/** Marks an error carried out of the single-flight refresh as a dead-token (invalid_grant). */
class InvalidGrantError extends Error {}

function copyAuthState(from: Profile, to: Profile): void {
  to.claudeAiOauth = from.claudeAiOauth;
  to.oauthAccount = from.oauthAccount;
  to.accountUuid = from.accountUuid;
  to.organizationUuid = from.organizationUuid;
  to.organizationUuidRoot = from.organizationUuidRoot;
  to.organizationType = from.organizationType;
  to.subscriptionType = from.subscriptionType;
  to.userID = from.userID;
  to.needsReauth = from.needsReauth;
}

function findDiskProfile(profile: Profile): Profile | undefined {
  const disk = loadStore();
  return disk.profiles.find((p) => p.id === profile.id) ?? findByAccountUuid(disk, profile.accountUuid) ?? findByEmail(disk, profile.email);
}

function refreshLockName(profile: Profile): string {
  return `oauth-refresh-${profile.accountUuid || profile.email || profile.id}`;
}

/**
 * Ensure profile has a non-expired access token, refreshing (and persisting rotation) if
 * needed. `refreshLeadMs` is how far before expiry we proactively refresh (default 60s;
 * the keep-alive passes a larger lead so parked accounts never actually reach expiry).
 */
async function ensureAccessToken(
  profile: Profile,
  onRotate?: (p: Profile) => void,
  refreshLeadMs = 60_000,
): Promise<string | null> {
  const now = Date.now();
  if (!hasCliAuth(profile)) return null;
  const oauth = profile.claudeAiOauth;
  if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > now + refreshLeadMs) {
    // Token is still valid — if it was previously flagged needsReauth (e.g. a
    // transient invalid_grant during a refresh race), a valid token proves the
    // account is fine again, so clear the flag instead of leaving it stuck.
    if (profile.needsReauth) {
      profile.needsReauth = false;
      onRotate?.(profile);
    }
    return oauth.accessToken;
  }
  if (!oauth.refreshToken) return oauth.accessToken ?? null;

  // A known-dead account must be re-added. Retrying the same rejected refresh token only
  // hammers the endpoint and can overwrite live state via unrelated persistence paths.
  if (profile.needsReauth) return null;

  // Back off repeated attempts from stale UI paths. A healthy account whose access token
  // merely expired is still allowed to refresh after the hard floor.
  const last = lastRefreshAttempt.get(profile.id) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    return null;
  }

  // Single-flight coalesces callers within this process; the file lock below coalesces
  // separate switcher/keep-alive processes so only one refresh token POST can happen.
  let pending = inFlightRefresh.get(profile.id);
  if (!pending) {
    pending = withFileLock(refreshLockName(profile), async () => {
      const diskProfile = findDiskProfile(profile);
      if (diskProfile && diskProfile !== profile) copyAuthState(diskProfile, profile);
      if (!hasCliAuth(profile) || profile.needsReauth) return null;

      const lockedOauth = profile.claudeAiOauth;
      const lockedNow = Date.now();
      if (lockedOauth.accessToken && lockedOauth.expiresAt && lockedOauth.expiresAt > lockedNow + refreshLeadMs) {
        return {
          accessToken: lockedOauth.accessToken,
          refreshToken: lockedOauth.refreshToken,
          expiresAt: lockedOauth.expiresAt,
          scopes: Array.isArray(lockedOauth.scopes) ? lockedOauth.scopes : String(lockedOauth.scopes ?? '').split(' ').filter(Boolean),
        };
      }

      const tokenAtStart = lockedOauth.refreshToken;
      lastRefreshAttempt.set(profile.id, Date.now());
      try {
        return await refreshToken(tokenAtStart);
      } catch (e) {
        const msg = String(e);
        if (/invalid_grant/i.test(msg)) {
          logger.warn('usage: refresh token rejected (needs re-login)', { email: profile.email });
          throw new InvalidGrantError(msg);
        }
        logger.warn('usage: token refresh failed', { email: profile.email, error: msg });
        throw e;
      } finally {
        inFlightRefresh.delete(profile.id);
      }
    });
    inFlightRefresh.set(profile.id, pending);
  }

  try {
    const refreshed = await pending;
    if (!refreshed) return null;
    if (!hasCliAuth(profile)) return null;
    const currentOauth = profile.claudeAiOauth;
    // All coalesced callers write the same rotated token — idempotent.
    currentOauth.accessToken = refreshed.accessToken;
    currentOauth.refreshToken = refreshed.refreshToken; // rotates
    currentOauth.expiresAt = refreshed.expiresAt;
    profile.needsReauth = false;
    try {
      const disk = loadStore();
      const diskProfile = disk.profiles.find((p) => p.id === profile.id) ?? findByAccountUuid(disk, profile.accountUuid) ?? findByEmail(disk, profile.email);
      if (diskProfile && hasCliAuth(diskProfile)) {
        copyAuthState(profile, diskProfile);
        saveStore(disk);
      }
    } catch (e) {
      logger.warn('usage: failed to persist refreshed token from locked path', { email: profile.email, error: String(e) });
    }
    onRotate?.(profile); // persist the rotation immediately so it's never lost
    logger.info('usage: refreshed token', { email: profile.email });
    return refreshed.accessToken;
  } catch (e) {
    if (e instanceof InvalidGrantError) {
      profile.needsReauth = true; // dead refresh token — the account must be re-added
      onRotate?.(profile); // persist the flag
    }
    // A non-invalid_grant failure (network/5xx) is transient — leave needsReauth untouched.
    return null;
  }
}

/**
 * Guarantee `profile` has a usable (non-expired) access token, rotating + persisting if
 * needed. Goes through the SAME single-flight path as usage refreshes, so calling it right
 * before a switch can't race a background refresh of the same account (which would burn the
 * token). Returns false only when the refresh token is dead (invalid_grant) or absent.
 */
export async function ensureFreshToken(
  profile: Profile,
  onRotate?: (p: Profile) => void,
): Promise<boolean> {
  const token = await ensureAccessToken(profile, onRotate);
  return !!token;
}

/**
 * Proactively refresh an account's OAuth token if it expires within `leadMs`, WITHOUT
 * touching the rate-limited usage endpoint. This is the keep-alive that lets PARKED
 * accounts usable until Anthropic requires a real login renewal: as long as we rotate +
 * persist their access token before it expires, the saved credential stays warm.
 * Safe to call often: it no-ops when the token is still fresh, single-flights concurrent
 * calls, and backs off accounts already known to be dead (needsReauth).
 */
export async function keepTokenAlive(
  profile: Profile,
  leadMs: number,
  onRotate?: (p: Profile) => void,
): Promise<void> {
  if (!hasCliAuth(profile)) return;
  if (profile.needsReauth) return; // dead token — nothing to keep alive
  const oauth = profile.claudeAiOauth;
  const now = Date.now();
  if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > now + leadMs) return; // still fresh
  try {
    await ensureAccessToken(profile, onRotate, leadMs);
  } catch {
    /* best-effort keep-alive */
  }
}

export async function fetchUsage(
  profile: Profile,
  claudeVersion: string,
  opts: { force?: boolean; onRotate?: (p: Profile) => void } = {},
): Promise<UsageInfo> {
  const now = Date.now();
  if (!hasCliAuth(profile)) {
    if (profile.needsReauth && profile.usage && (profile.usage.status === 'ok' || profile.usage.status === 'stale')) {
      return { ...profile.usage, status: 'stale' };
    }
    return {
      fetchedAt: now,
      status: profile.needsReauth ? 'error' : 'never',
      error: profile.needsReauth ? 'login expired — re-add with "a"' : undefined,
    };
  }
  const cacheWindow = opts.force ? MIN_INTERVAL_MS : CACHE_MS;
  if (profile.usage && profile.usage.status === 'ok' && now - profile.usage.fetchedAt < cacheWindow) {
    return profile.usage;
  }

  const access = await ensureAccessToken(profile, opts.onRotate);
  if (!access) {
    // Keep showing the last known usage (dimmed as 'stale') so a needs-reauth account
    // still displays its last rate-limit numbers instead of a blank error.
    if (profile.usage && (profile.usage.status === 'ok' || profile.usage.status === 'stale')) {
      return { ...profile.usage, status: 'stale' };
    }
    return {
      fetchedAt: now,
      status: 'error',
      error: profile.needsReauth ? 'login expired — re-add with "a"' : 'no valid access token',
    };
  }

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${access}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${claudeVersion}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.status === 429) {
      logger.warn('usage: rate-limited (429)', { email: profile.email });
      return { ...(profile.usage ?? { fetchedAt: now }), fetchedAt: profile.usage?.fetchedAt ?? now, status: 'rate_limited' };
    }
    if (!res.ok) {
      logger.warn('usage: http error', { email: profile.email, status: res.status });
      return { fetchedAt: now, status: 'error', error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as Record<string, unknown>;
    // Per-model scoped weekly limits live in the `limits` array as weekly_scoped entries.
    type RawLimit = { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } } };
    const rawLimits = Array.isArray(data.limits) ? (data.limits as RawLimit[]) : [];
    const models = rawLimits
      .filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
      .map((l) => ({ name: l.scope!.model!.display_name as string, utilization: l.percent ?? 0, resets_at: l.resets_at ?? null }));
    const info: UsageInfo = {
      fetchedAt: now,
      status: 'ok',
      five_hour: (data.five_hour as UsageInfo['five_hour']) ?? null,
      seven_day: (data.seven_day as UsageInfo['seven_day']) ?? null,
      seven_day_opus: (data.seven_day_opus as UsageInfo['seven_day_opus']) ?? null,
      seven_day_sonnet: (data.seven_day_sonnet as UsageInfo['seven_day_sonnet']) ?? null,
      models: models.length ? models : undefined,
    };
    logger.info('usage: ok', {
      email: profile.email,
      five_hour: info.five_hour?.utilization,
      seven_day: info.seven_day?.utilization,
    });
    return info;
  } catch (e) {
    logger.error('usage: fetch error', e, { email: profile.email });
    return { fetchedAt: now, status: 'error', error: (e as Error).message };
  }
}

/** Worst-case utilization for ranking (max of 5h / 7d). */
export function utilizationOf(u?: UsageInfo): number | null {
  if (!u || u.status === 'never') return null;
  const a = u.five_hour?.utilization ?? null;
  const b = u.seven_day?.utilization ?? null;
  if (a == null && b == null) return null;
  return Math.max(a ?? 0, b ?? 0);
}

/**
 * Least-loaded account. Quota is shared per organizationUuid, so group by org and
 * pick the profile in the least-utilized org.
 */
export function leastLoaded(profiles: Profile[]): Profile | null {
  const scored = profiles
    .map((p) => ({ p, u: utilizationOf(p.usage) }))
    .filter((x): x is { p: Profile; u: number } => x.u != null);
  if (!scored.length) return null;

  // aggregate max utilization per org
  const orgMax = new Map<string, number>();
  for (const { p, u } of scored) {
    const org = p.organizationUuid || p.id;
    orgMax.set(org, Math.max(orgMax.get(org) ?? 0, u));
  }
  scored.sort((a, b) => {
    const oa = orgMax.get(a.p.organizationUuid || a.p.id) ?? a.u;
    const ob = orgMax.get(b.p.organizationUuid || b.p.id) ?? b.u;
    return oa - ob || a.u - b.u;
  });
  return scored[0].p;
}
