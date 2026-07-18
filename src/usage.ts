// Per-account usage/quota via the undocumented oauth/usage endpoint.
// Aggressively rate-limited: cache hard, degrade gracefully.
import { logger, redactText } from './logger';
import { withFileLock } from './locks';
import { refreshToken, type TokenSet } from './oauth';
import { getLiveAccount } from './claudeStore';
import {
  assertNoAmbiguousClaudeCredentialOwners,
  findByAccountUuid,
  loadStore,
  mutateStore,
  persistProfileCredentials,
} from './profiles';
import {
  DEFAULT_QUOTA_FRESHNESS_MS,
  selectBestNow,
  type BestNowDecision,
} from './scheduling';
import {
  hasCliAuth,
  type ClaudeModelLimitsState,
  type LiveAccount,
  type ModelLimit,
  type Profile,
  type UsageInfo,
} from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 10 * 60 * 1000; // usage only changes every few hours
const MIN_INTERVAL_MS = 30 * 1000; // hard floor: never hit the endpoint more than once / 30s per account
const CLAUDE_CORE_LIMIT_KINDS = new Set(['session', 'weekly_all']);

// The OAuth refresh token ROTATES: every successful refresh invalidates the token we
// sent and returns a new one. Two refreshes racing on the same account would both send
// the same token — the first rotates it away, the second gets invalid_grant and would
// (wrongly) flag a perfectly healthy account as dead. So we single-flight refreshes per
// account: a second caller awaits the first's result instead of POSTing a now-stale token.
const inFlightRefresh = new Map<string, Promise<TokenSet | null>>();
// Usage reads can be triggered simultaneously by startup, cursor preview and a manual
// `u`. Coalesce the complete read as well as token rotation so one account produces at
// most one quota request at a time.
const inFlightUsage = new Map<string, Promise<UsageInfo>>();
// Last time we ATTEMPTED a refresh for an account (success or failure), used as a hard
// floor for concurrent/stale UI paths. Known-dead accounts are not retried at all.
const lastRefreshAttempt = new Map<string, number>();

function parseUsageWindow(value: unknown, field: string): UsageInfo['five_hour'] {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Claude usage response contained an invalid ${field} window.`);
  }
  const record = value as Record<string, unknown>;
  const rawUtilization = record.utilization;
  if (rawUtilization !== undefined && rawUtilization !== null
    && (typeof rawUtilization !== 'number' || !Number.isFinite(rawUtilization))) {
    throw new Error(`Claude usage response contained an invalid ${field} utilization.`);
  }
  const rawReset = record.resets_at;
  if (rawReset !== undefined && rawReset !== null
    && (typeof rawReset !== 'string' || !Number.isFinite(Date.parse(rawReset)))) {
    throw new Error(`Claude usage response contained an invalid ${field} reset time.`);
  }
  return {
    utilization: typeof rawUtilization === 'number'
      ? Math.max(0, Math.min(100, rawUtilization))
      : null,
    resets_at: typeof rawReset === 'string' ? rawReset : null,
  };
}

/** Validate the provider response before quota data is allowed to influence Best Now. */
export function parseClaudeUsagePayload(value: unknown, fetchedAt = Date.now()): UsageInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Claude usage endpoint returned a non-object response.');
  }
  const data = value as Record<string, unknown>;
  const limitsWereProvided = Object.prototype.hasOwnProperty.call(data, 'limits');
  const rawLimits = data.limits;
  const models: ModelLimit[] = [];
  let modelLimitsState: ClaudeModelLimitsState = limitsWereProvided ? 'malformed' : 'absent';
  if (Array.isArray(rawLimits)) {
    let sawMalformedLimit = false;
    let sawUnsupportedLimit = false;
    let sawScopedLimit = false;
    for (const rawLimit of rawLimits) {
      if (!rawLimit || typeof rawLimit !== 'object' || Array.isArray(rawLimit)) {
        sawMalformedLimit = true;
        continue;
      }
      const limit = rawLimit as Record<string, unknown>;
      if (typeof limit.kind !== 'string' || !limit.kind.trim()) {
        sawMalformedLimit = true;
        continue;
      }
      const resetsAt = limit.resets_at;
      const hasValidPercentAndReset = typeof limit.percent === 'number'
        && Number.isFinite(limit.percent)
        && (resetsAt === undefined || resetsAt === null
          || (typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt))));
      // Anthropic currently mirrors the top-level five-hour and seven-day windows in
      // `limits` as session/weekly_all entries. They are schema evidence, not extra
      // model constraints; accepting them keeps the scoped-limit projection honest
      // without double-counting the same quota in Best Now.
      if (CLAUDE_CORE_LIMIT_KINDS.has(limit.kind)) {
        if (!hasValidPercentAndReset) sawMalformedLimit = true;
        continue;
      }
      if (limit.kind !== 'weekly_scoped') {
        sawUnsupportedLimit = true;
        continue;
      }
      const scope = limit.scope;
      const model = scope && typeof scope === 'object' && !Array.isArray(scope)
        ? (scope as Record<string, unknown>).model
        : undefined;
      const name = model && typeof model === 'object' && !Array.isArray(model)
        ? (model as Record<string, unknown>).display_name
        : undefined;
      if (typeof name !== 'string' || !name.trim() || !hasValidPercentAndReset) {
        sawMalformedLimit = true;
        continue;
      }
      sawScopedLimit = true;
      models.push({
        name: name.trim(),
        utilization: Math.max(0, Math.min(100, limit.percent as number)),
        resets_at: typeof resetsAt === 'string' ? resetsAt : null,
      });
    }
    modelLimitsState = sawMalformedLimit
      ? 'malformed'
      : sawUnsupportedLimit
        ? 'unsupported'
        : sawScopedLimit
          ? 'complete'
          : 'empty';
  }
  return {
    fetchedAt,
    status: 'ok',
    ...(Object.prototype.hasOwnProperty.call(data, 'five_hour')
      ? { five_hour: parseUsageWindow(data.five_hour, 'five_hour') }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(data, 'seven_day')
      ? { seven_day: parseUsageWindow(data.seven_day, 'seven_day') }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(data, 'seven_day_opus')
      ? { seven_day_opus: parseUsageWindow(data.seven_day_opus, 'seven_day_opus') }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(data, 'seven_day_sonnet')
      ? { seven_day_sonnet: parseUsageWindow(data.seven_day_sonnet, 'seven_day_sonnet') }
      : {}),
    models: models.length ? models : undefined,
    modelLimitsState,
  };
}

function hasCompleteModelLimitsProjection(usage: UsageInfo): boolean {
  if (usage.modelLimitsState === 'empty') {
    return usage.models === undefined || (Array.isArray(usage.models) && usage.models.length === 0);
  }
  if (usage.modelLimitsState !== 'complete'
    || !Array.isArray(usage.models)
    || usage.models.length === 0) return false;
  return usage.models.every((model) =>
    !!model
    && typeof model.name === 'string'
    && model.name.trim().length > 0
    && typeof model.utilization === 'number'
    && Number.isFinite(model.utilization)
    && (model.resets_at === undefined
      || model.resets_at === null
      || (typeof model.resets_at === 'string' && Number.isFinite(Date.parse(model.resets_at)))));
}

/** Freshness gate for Best Now: a provider reset invalidates even a young cache entry. */
export function hasFreshCompleteClaudeUsage(profile: Profile, now = Date.now()): boolean {
  const usage = profile.usage;
  if (!usage || usage.status !== 'ok') return false;
  const age = now - usage.fetchedAt;
  if (age < -60_000 || age > DEFAULT_QUOTA_FRESHNESS_MS) return false;
  if (!Object.prototype.hasOwnProperty.call(usage, 'five_hour')
    || !Object.prototype.hasOwnProperty.call(usage, 'seven_day')) return false;
  if (!hasCompleteModelLimitsProjection(usage)) return false;
  const windows = [
    usage.five_hour,
    usage.seven_day,
    usage.seven_day_opus,
    usage.seven_day_sonnet,
    ...(usage.models ?? []).map((model) => ({
      utilization: model.utilization,
      resets_at: model.resets_at ?? null,
    })),
  ];
  return !windows.some((window) => {
    if (!window || typeof window.utilization !== 'number' || window.utilization <= 0 || !window.resets_at) return false;
    const reset = Date.parse(window.resets_at);
    return Number.isFinite(reset) && reset <= now;
  });
}

/** Human-readable refresh result that does not collapse safe active caching into failure. */
export function describeClaudeRefreshResult(
  profiles: Profile[],
  activeProfileId: string | null,
  now = Date.now(),
): string {
  const tracked = profiles.filter((profile) => hasCliAuth(profile) || profile.needsReauth);
  if (!tracked.length) return 'Claude refresh: no saved Claude CLI accounts.';

  const fresh = tracked.filter((profile) => !profile.needsReauth
    && hasFreshCompleteClaudeUsage(profile, now)).length;
  const needsReauth = tracked.filter((profile) => profile.needsReauth).length;
  const activeCached = tracked.filter((profile) => !profile.needsReauth
    && profile.id === activeProfileId
    && profile.usage?.status === 'stale').length;
  const unavailable = Math.max(0, tracked.length - fresh - needsReauth - activeCached);
  const details: string[] = [];
  if (activeCached) {
    details.push(`${activeCached} active cached (live token left to official Claude)`);
  }
  if (needsReauth) {
    details.push(`${needsReauth} ${needsReauth === 1 ? 'needs' : 'need'} re-add`);
  }
  if (unavailable) {
    details.push(`${unavailable} unavailable or incomplete`);
  }
  return `Claude refresh: ${fresh}/${tracked.length} fresh and complete${details.length ? `; ${details.join('; ')}` : ''}.`;
}

/** Marks an error carried out of the single-flight refresh as a dead-token (invalid_grant). */
class InvalidGrantError extends Error {}
class CredentialPersistenceError extends Error {}

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
  return disk.profiles.find((p) => p.id === profile.id) ?? findByAccountUuid(disk, profile.accountUuid);
}

function refreshLockName(profile: Profile): string {
  return `oauth-refresh-${profile.accountUuid || profile.id}`;
}

function liveAccountMatchesProfile(live: LiveAccount, profile: Profile): boolean {
  const liveAccountUuid = live.oauthAccount?.accountUuid?.trim();
  const profileAccountUuids = [profile.accountUuid, profile.oauthAccount?.accountUuid]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  if (liveAccountUuid && profileAccountUuids.includes(liveAccountUuid)) return true;

  const liveRefreshToken = live.claudeAiOauth?.refreshToken;
  return typeof liveRefreshToken === 'string'
    && liveRefreshToken.length > 0
    && liveRefreshToken === profile.claudeAiOauth?.refreshToken;
}

/**
 * Rehydrate the caller's potentially stale React/scheduler object while the provider
 * switch lock is held, then prove that this credential chain is still parked. Both the
 * active marker and the live two-file identity are authoritative stop conditions: the
 * official Claude client exclusively owns rotation after either one identifies a profile
 * as live.
 */
function revalidateParkedProfile(profile: Profile): Profile | null {
  // Read the coherent two-file live snapshot before the store. A switcher-controlled
  // writer cannot change either while `claude-provider-switch` is held, and the live
  // reader itself excludes transaction midpoints with `claude-live-auth`.
  const live = getLiveAccount();
  const liveMatchesOriginal = liveAccountMatchesProfile(live, profile);
  const disk = loadStore();
  assertNoAmbiguousClaudeCredentialOwners(disk);
  const persisted = disk.profiles.find((candidate) => candidate.id === profile.id)
    ?? findByAccountUuid(disk, profile.accountUuid);
  if (!persisted) {
    logger.warn('usage: parked credential disappeared before refresh', { profileId: profile.id });
    return null;
  }
  copyAuthState(persisted, profile);
  const isActive = disk.activeProfileId === persisted.id || disk.activeProfileId === profile.id;
  if (isActive || liveMatchesOriginal || liveAccountMatchesProfile(live, persisted)) {
    logger.info('usage: skipped refresh because credential is active/live', { profileId: persisted.id });
    return null;
  }
  return persisted;
}

/**
 * Ensure profile has a non-expired access token, refreshing (and persisting rotation) if
 * needed. `refreshLeadMs` is how far before expiry we proactively refresh (default 60s;
 * the keep-alive passes a larger lead so parked access tokens are refreshed on time).
 */
async function ensureAccessToken(
  profile: Profile,
  onRotate?: (p: Profile) => void,
  refreshLeadMs = 60_000,
  allowRefresh = true,
  providerLockHeld = false,
): Promise<string | null> {
  const now = Date.now();
  if (!hasCliAuth(profile)) return null;
  const oauth = profile.claudeAiOauth;
  // A still-live access token says nothing about whether its rotating refresh-token
  // chain is healthy. Preserve the explicit re-auth state and show cached quotas stale.
  if (profile.needsReauth) return null;
  if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > now + refreshLeadMs) {
    return oauth.accessToken;
  }
  // The live account is owned by Claude Code. Its refresh token rotates, and the
  // official client may still hold the previous value in memory. A switcher-side
  // refresh would invalidate that value and can make Claude clear its live auth on
  // the next refresh attempt. Callers pass allowRefresh=false for the active account;
  // stale quota data is preferable to logging the user out.
  if (!allowRefresh) return null;
  if (!oauth.refreshToken) return oauth.accessToken ?? null;

  const rotateWhileProviderLocked = async (): Promise<TokenSet | null> => {
    const parked = revalidateParkedProfile(profile);
    if (!parked || !hasCliAuth(profile) || profile.needsReauth) return null;
    const flightKey = parked.id;

    // Single-flight is deliberately established only after the provider lock is held.
    // Registering a promise that was still waiting for that lock would deadlock a switch
    // which already owns it and then joins the promise. The account file lock remains the
    // cross-process authority and makes queued callers observe the durable new generation.
    let pending = inFlightRefresh.get(flightKey);
    if (!pending) {
      // A known-dead account must be re-added. Retrying the same rejected refresh token only
      // hammers the endpoint. Back off repeated attempts from stale UI paths.
      const last = lastRefreshAttempt.get(flightKey) ?? 0;
      if (Date.now() - last < MIN_INTERVAL_MS) return null;
      const refreshPromise = withFileLock(refreshLockName(parked), async () => {
        // The account lock may itself have queued behind another process. Re-read live and
        // persisted state immediately before the irreversible rotating-token POST.
        const latestParked = revalidateParkedProfile(profile);
        if (!latestParked || !hasCliAuth(profile) || profile.needsReauth) return null;

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
        lastRefreshAttempt.set(flightKey, Date.now());
        try {
          const refreshed = await refreshToken(tokenAtStart);
          lockedOauth.accessToken = refreshed.accessToken;
          lockedOauth.refreshToken = refreshed.refreshToken;
          lockedOauth.expiresAt = refreshed.expiresAt;
          profile.needsReauth = false;

          // Persist the rotated refresh token before releasing the cross-process lock and
          // before touching metadata. The OAuth server has already invalidated tokenAtStart;
          // the per-account envelope is therefore the recovery journal of record.
          try {
            persistProfileCredentials(profile, { expectedPreviousRefreshToken: tokenAtStart });
          } catch (error) {
            throw new CredentialPersistenceError(
              `OAuth rotation succeeded but the new credential could not be saved: ${String((error as Error).message ?? error)}`,
            );
          }
          try {
            mutateStore((disk) => {
              const latest = disk.profiles.find((p) => p.id === profile.id)
                ?? findByAccountUuid(disk, profile.accountUuid);
              if (latest) copyAuthState(profile, latest);
            });
          } catch (error) {
            // The credential envelope above is already durable. A later load hydrates the
            // older metadata row from it, so this failure must not discard a valid rotation.
            logger.error('usage: rotated credential saved but metadata update failed', error, { profileId: profile.id });
          }
          return refreshed;
        } catch (e) {
          const msg = String(e);
          if (/invalid_grant/i.test(msg)) {
            profile.needsReauth = true;
            try {
              mutateStore((disk) => {
                const latest = disk.profiles.find((p) => p.id === profile.id)
                  ?? findByAccountUuid(disk, profile.accountUuid);
                if (latest) latest.needsReauth = true;
              });
            } catch {
              /* the caller persists the in-memory flag as a second line of defense */
            }
            logger.warn('usage: refresh token rejected (needs re-login)', { email: profile.email });
            throw new InvalidGrantError(msg);
          }
          logger.warn('usage: token refresh failed', { email: profile.email, error: msg });
          throw e;
        }
      });
      pending = refreshPromise.finally(() => {
        if (inFlightRefresh.get(flightKey) === pending) inFlightRefresh.delete(flightKey);
      });
      inFlightRefresh.set(flightKey, pending);
    }

    // Checking the flight before the cooldown means callers already inside this provider
    // transaction share the same result rather than mistaking its attempt timestamp for a
    // failed refresh.
    return pending;
  };

  let refreshed: TokenSet | null;
  try {
    refreshed = await (providerLockHeld
      ? rotateWhileProviderLocked()
      : withFileLock('claude-provider-switch', rotateWhileProviderLocked));
  } catch (e) {
    if (e instanceof CredentialPersistenceError) throw e;
    if (e instanceof InvalidGrantError) {
      profile.needsReauth = true; // dead refresh token — the account must be re-added
      onRotate?.(profile); // persist the flag
    }
    // A non-invalid_grant failure (network/5xx) is transient — leave needsReauth untouched.
    return null;
  }

  if (!refreshed) return null;
  if (!hasCliAuth(profile)) return null;
  const currentOauth = profile.claudeAiOauth;
  // All coalesced callers write the same rotated token — idempotent.
  currentOauth.accessToken = refreshed.accessToken;
  currentOauth.refreshToken = refreshed.refreshToken; // rotates
  currentOauth.expiresAt = refreshed.expiresAt;
  profile.needsReauth = false;
  onRotate?.(profile); // metadata/UI acknowledgement after the durable journal write
  logger.info('usage: refreshed token', { email: profile.email });
  return refreshed.accessToken;
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
  options: { providerLockHeld?: boolean } = {},
): Promise<boolean> {
  const token = await ensureAccessToken(profile, onRotate, 60_000, true, options.providerLockHeld === true);
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
  } catch (error) {
    if (error instanceof CredentialPersistenceError) throw error;
    /* transient best-effort keep-alive failure */
  }
}

export async function fetchUsage(
  profile: Profile,
  claudeVersion: string,
  opts: { force?: boolean; onRotate?: (p: Profile) => void; allowRefresh?: boolean } = {},
): Promise<UsageInfo> {
  const now = Date.now();
  // React effects can still hold an older profile object after another path persisted a
  // fresh quota result. Rehydrate only the newer quota snapshot before applying caches.
  const diskProfile = findDiskProfile(profile);
  if ((diskProfile?.usage?.fetchedAt ?? 0) > (profile.usage?.fetchedAt ?? 0)) {
    profile.usage = diskProfile?.usage;
  }
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

  const pending = inFlightUsage.get(profile.id);
  if (pending) return pending;

  const request = fetchUsageUncached(profile, claudeVersion, opts, now);
  inFlightUsage.set(profile.id, request);
  try {
    return await request;
  } finally {
    if (inFlightUsage.get(profile.id) === request) inFlightUsage.delete(profile.id);
  }
}

async function fetchUsageUncached(
  profile: Profile,
  claudeVersion: string,
  opts: { onRotate?: (p: Profile) => void; allowRefresh?: boolean },
  now: number,
): Promise<UsageInfo> {
  const access = await ensureAccessToken(profile, opts.onRotate, 60_000, opts.allowRefresh !== false);
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
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      logger.warn('usage: rate-limited (429)', { email: profile.email });
      return { ...(profile.usage ?? { fetchedAt: now }), fetchedAt: profile.usage?.fetchedAt ?? now, status: 'rate_limited' };
    }
    if (!res.ok) {
      logger.warn('usage: http error', { email: profile.email, status: res.status });
      if (profile.usage && (profile.usage.status === 'ok' || profile.usage.status === 'stale')) {
        return { ...profile.usage, status: 'stale', error: `HTTP ${res.status}` };
      }
      return { fetchedAt: now, status: 'error', error: `HTTP ${res.status}` };
    }
    const info = parseClaudeUsagePayload(await res.json(), now);
    logger.info('usage: ok', {
      email: profile.email,
      five_hour: info.five_hour?.utilization,
      seven_day: info.seven_day?.utilization,
    });
    return info;
  } catch (e) {
    logger.error('usage: fetch error', e, { email: profile.email });
    if (profile.usage && (profile.usage.status === 'ok' || profile.usage.status === 'stale')) {
      return { ...profile.usage, status: 'stale', error: redactText(e) };
    }
    return { fetchedAt: now, status: 'error', error: redactText(e) };
  }
}

/** Worst-case utilization across every provider-confirmed applicable quota bucket. */
export function utilizationOf(u?: UsageInfo): number | null {
  if (!u || u.status === 'never') return null;
  const values = [
    u.five_hour?.utilization,
    u.seven_day?.utilization,
    u.seven_day_opus?.utilization,
    u.seven_day_sonnet?.utilization,
    ...(Array.isArray(u.models) ? u.models : []).map((model) => model.utilization),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
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

function resetTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/** Smart current-capacity selection while keeping Claude-specific parsing in its adapter. */
export function bestNow(
  profiles: Profile[],
  activeProfileId: string | null,
  now = Date.now(),
): BestNowDecision<Profile> {
  return selectBestNow(profiles.map((profile) => {
    const refreshExpiry = typeof profile.claudeAiOauth?.refreshTokenExpiresAt === 'number'
      ? profile.claudeAiOauth.refreshTokenExpiresAt
      : null;
    const authorizationExpired = profile.needsReauth || (refreshExpiry !== null && refreshExpiry <= now);
    return {
    id: profile.id,
    account: profile,
    eligible: hasCliAuth(profile) && !authorizationExpired,
    authorizationStatus: authorizationExpired ? 'reauth-required' as const : 'valid' as const,
    isActive: profile.id === activeProfileId,
    primary: profile.usage?.five_hour && typeof profile.usage.five_hour.utilization === 'number'
      ? {
          usedPercent: profile.usage.five_hour.utilization,
          resetsAt: resetTime(profile.usage.five_hour.resets_at),
        }
      : null,
    secondary: profile.usage?.seven_day && typeof profile.usage.seven_day.utilization === 'number'
      ? {
          usedPercent: profile.usage.seven_day.utilization,
          resetsAt: resetTime(profile.usage.seven_day.resets_at),
        }
      : null,
    additional: [
      ...(profile.usage?.seven_day_opus && typeof profile.usage.seven_day_opus.utilization === 'number'
        ? [{
            name: 'Opus 7d',
            usedPercent: profile.usage.seven_day_opus.utilization,
            resetsAt: resetTime(profile.usage.seven_day_opus.resets_at),
          }]
        : []),
      ...(profile.usage?.seven_day_sonnet && typeof profile.usage.seven_day_sonnet.utilization === 'number'
        ? [{
            name: 'Sonnet 7d',
            usedPercent: profile.usage.seven_day_sonnet.utilization,
            resetsAt: resetTime(profile.usage.seven_day_sonnet.resets_at),
          }]
        : []),
      ...(Array.isArray(profile.usage?.models) ? profile.usage.models : []).flatMap((model) =>
        typeof model.utilization === 'number' && Number.isFinite(model.utilization)
          ? [{
              name: model.name,
              usedPercent: model.utilization,
              resetsAt: resetTime(model.resets_at),
            }]
          : []),
    ],
    metadata: {
      status: profile.usage?.status ?? 'never',
      fetchedAt: profile.usage?.fetchedAt,
      primaryComplete: !!profile.usage
        && Object.prototype.hasOwnProperty.call(profile.usage, 'five_hour')
        && hasCompleteModelLimitsProjection(profile.usage),
      secondaryComplete: !!profile.usage && Object.prototype.hasOwnProperty.call(profile.usage, 'seven_day'),
    },
  };
  }), now);
}
