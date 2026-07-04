// Per-account usage/quota via the undocumented oauth/usage endpoint.
// Aggressively rate-limited: cache hard, degrade gracefully.
import { logger } from './logger';
import { refreshToken } from './oauth';
import type { Profile, UsageInfo } from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 10 * 60 * 1000; // usage only changes every few hours

/** Ensure profile has a non-expired access token, refreshing (and persisting rotation) if needed. */
async function ensureAccessToken(
  profile: Profile,
  onRotate?: (p: Profile) => void,
): Promise<string | null> {
  const now = Date.now();
  const oauth = profile.claudeAiOauth;
  if (oauth.expiresAt && oauth.expiresAt > now + 60_000) return oauth.accessToken;
  if (!oauth.refreshToken) return oauth.accessToken ?? null;
  try {
    const refreshed = await refreshToken(oauth.refreshToken);
    oauth.accessToken = refreshed.accessToken;
    oauth.refreshToken = refreshed.refreshToken; // rotates
    oauth.expiresAt = refreshed.expiresAt;
    onRotate?.(profile);
    logger.info('usage: refreshed token', { email: profile.email });
    return refreshed.accessToken;
  } catch (e) {
    logger.warn('usage: token refresh failed', { email: profile.email, error: String(e) });
    return null;
  }
}

export async function fetchUsage(
  profile: Profile,
  claudeVersion: string,
  opts: { force?: boolean; onRotate?: (p: Profile) => void } = {},
): Promise<UsageInfo> {
  const now = Date.now();
  if (!opts.force && profile.usage && profile.usage.status === 'ok' && now - profile.usage.fetchedAt < CACHE_MS) {
    return profile.usage;
  }

  const access = await ensureAccessToken(profile, opts.onRotate);
  if (!access) {
    return { fetchedAt: now, status: 'error', error: 'no valid access token' };
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
