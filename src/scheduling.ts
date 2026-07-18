/** Provider-neutral quota scheduling used by both Claude and Codex adapters. */

export const DEFAULT_QUOTA_FRESHNESS_MS = 10 * 60 * 1000;
export const MIN_USABLE_HEADROOM_PERCENT = 5;
export const ACTIVE_USAGE_HYSTERESIS_PERCENT = 5;
export const ACTIVE_DEADLINE_HYSTERESIS_MS = 15 * 60 * 1000;

const MAX_FUTURE_CLOCK_SKEW_MS = 60 * 1000;
const MAX_SELECTABLE_USED_PERCENT = 100 - MIN_USABLE_HEADROOM_PERCENT;

export interface QuotaSnapshot {
  usedPercent: number | null;
  resetsAt: number | null;
}

/** A provider-specific quota bucket which constrains the same account capacity. */
export interface NamedQuotaSnapshot extends QuotaSnapshot {
  name: string;
}

export type QuotaDataStatus =
  | 'fresh'
  | 'ok'
  | 'stale'
  | 'rate_limited'
  | 'error'
  | 'never'
  | 'unknown';

/**
 * Optional evidence used to decide whether a candidate can be trusted.
 *
 * Metadata is opt-in so older adapters retain their historical behaviour. Once an
 * adapter supplies metadata, it must provide a fresh successful observation and a
 * complete primary- and secondary-window projections to receive a high-confidence
 * decision. A complete projection may explicitly contain `null` when the provider
 * confirms that a window does not apply; omission must remain distinguishable from
 * that provider-confirmed absence.
 */
export interface BestNowMetadata {
  status?: QuotaDataStatus;
  fetchedAt?: number;
  maxAgeMs?: number;
  /** `true` confirms that the provider's primary-window projection is complete. */
  primaryComplete?: boolean;
  /** `true` also permits an explicit `secondary: null` (no secondary limit applies). */
  secondaryComplete?: boolean;
}

/**
 * Account-level authorization state after the provider adapter has attempted any
 * supported refresh. `expired` must not be used for a routinely rotating access
 * token while a usable refresh credential still exists.
 */
export type BestNowAuthorizationStatus =
  | 'valid'
  | 'unknown'
  | 'expired'
  | 'reauth-required';

export interface BestNowCandidate<T> {
  id: string;
  account: T;
  eligible: boolean;
  /** Defense-in-depth guard against selecting an account known to need a new login. */
  authorizationStatus?: BestNowAuthorizationStatus;
  isActive?: boolean;
  primary?: QuotaSnapshot | null;
  secondary?: QuotaSnapshot | null;
  /** Additional applicable buckets, such as model-scoped weekly limits. */
  additional?: NamedQuotaSnapshot[];
  metadata?: BestNowMetadata;
}

export type BestNowReason =
  | 'primary-reset-soon'
  | 'secondary-reset-soon'
  | 'additional-reset-soon'
  | 'most-headroom'
  | 'reserve-protected'
  | 'all-exhausted'
  | 'no-usage'
  | 'no-eligible-account';

export type BestNowConfidence = 'high' | 'low';

export interface BestNowDecision<T> {
  target: T | null;
  targetId: string | null;
  reason: BestNowReason;
  confidence: BestNowConfidence;
  /** True when switching was avoided because the active account was materially equivalent. */
  keptActive?: boolean;
  primaryUsedPercent?: number;
  primaryResetsAt?: number | null;
  secondaryUsedPercent?: number;
  secondaryResetsAt?: number | null;
  limitingWindowName?: string;
  limitingUsedPercent?: number;
  limitingResetsAt?: number | null;
  nextAvailableId?: string;
  nextAvailableAt?: number;
}

interface EffectiveWindow {
  usedPercent: number;
  resetsAt: number | null;
}

interface NamedEffectiveWindow extends EffectiveWindow {
  name: string;
}

interface RankedCandidate<T> {
  source: BestNowCandidate<T>;
  confidence: BestNowConfidence;
  primary: EffectiveWindow | null;
  secondary: EffectiveWindow | null;
  additional: NamedEffectiveWindow[];
  allWindows: EffectiveWindow[];
  earliestDeadline: number;
  primaryDeadline: number;
  secondaryDeadline: number;
  bottleneckUsed: number;
}

function finiteReset(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function effectiveWindow(
  window: QuotaSnapshot | null | undefined,
  now: number,
  inferElapsedLegacyReset: boolean,
): EffectiveWindow | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  const resetsAt = finiteReset(window.resetsAt);
  // Preserve the old reset inference only for adapters that have not adopted metadata.
  // Once freshness is explicit, an elapsed reset invalidates the observation; it does not
  // prove that the account remained unused after the reset.
  if (inferElapsedLegacyReset && resetsAt !== null && resetsAt <= now) {
    return { usedPercent: 0, resetsAt: null };
  }
  return {
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null,
  };
}

function deadline(window: EffectiveWindow | null, now: number): number {
  return window?.resetsAt !== null && window?.resetsAt !== undefined && window.resetsAt > now
    ? window.resetsAt
    : Number.POSITIVE_INFINITY;
}

function metadataConfidence<T>(candidate: BestNowCandidate<T>, now: number): BestNowConfidence {
  const metadata = candidate.metadata;
  if (!metadata) return 'high';

  const statusIsFresh = metadata.status === 'ok' || metadata.status === 'fresh';
  const fetchedAt = metadata.fetchedAt;
  const maxAgeMs = typeof metadata.maxAgeMs === 'number'
    && Number.isFinite(metadata.maxAgeMs)
    && metadata.maxAgeMs >= 0
    ? metadata.maxAgeMs
    : DEFAULT_QUOTA_FRESHNESS_MS;
  const age = typeof fetchedAt === 'number' && Number.isFinite(fetchedAt)
    ? now - fetchedAt
    : Number.POSITIVE_INFINITY;
  const isFresh = age >= -MAX_FUTURE_CLOCK_SKEW_MS && age <= maxAgeMs;
  const primaryWasProvided = Object.prototype.hasOwnProperty.call(candidate, 'primary')
    && candidate.primary !== undefined;
  const secondaryWasProvided = Object.prototype.hasOwnProperty.call(candidate, 'secondary')
    && candidate.secondary !== undefined;
  const primaryIsComplete = metadata.primaryComplete ?? primaryWasProvided;
  const secondaryIsComplete = metadata.secondaryComplete ?? secondaryWasProvided;

  return statusIsFresh && isFresh && primaryIsComplete && secondaryIsComplete ? 'high' : 'low';
}

function isEligible<T>(candidate: BestNowCandidate<T>): boolean {
  return candidate.eligible
    && candidate.authorizationStatus !== 'expired'
    && candidate.authorizationStatus !== 'reauth-required';
}

function isUsable<T>(candidate: RankedCandidate<T>): boolean {
  return candidate.allWindows.every((window) => window.usedPercent < MAX_SELECTABLE_USED_PERCENT);
}

function availabilityAt<T>(candidate: RankedCandidate<T>, now: number): number {
  const blockers = candidate.allWindows
    .filter((window) => window.usedPercent >= MAX_SELECTABLE_USED_PERCENT);
  if (!blockers.length) return now;
  let availableAt = now;
  for (const blocker of blockers) {
    if (blocker.resetsAt === null || blocker.resetsAt <= now) return Number.POSITIVE_INFINITY;
    availableAt = Math.max(availableAt, blocker.resetsAt);
  }
  return availableAt;
}

function hasExhaustedWindow<T>(candidate: RankedCandidate<T>): boolean {
  return candidate.allWindows.some((window) => window.usedPercent >= 100);
}

function compareNumber(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareRanked<T>(a: RankedCandidate<T>, b: RankedCandidate<T>): number {
  return compareNumber(a.earliestDeadline, b.earliestDeadline)
    || compareNumber(a.primaryDeadline, b.primaryDeadline)
    || compareNumber(a.secondaryDeadline, b.secondaryDeadline)
    || compareNumber(a.bottleneckUsed, b.bottleneckUsed)
    || compareNumber(a.primary?.usedPercent ?? 0, b.primary?.usedPercent ?? 0)
    || Number(!!b.source.isActive) - Number(!!a.source.isActive)
    || a.source.id.localeCompare(b.source.id);
}

function deadlinesAreClose(a: number, b: number): boolean {
  if (a === b) return true;
  return Number.isFinite(a)
    && Number.isFinite(b)
    && Math.abs(a - b) <= ACTIVE_DEADLINE_HYSTERESIS_MS;
}

function activeIsEquivalent<T>(active: RankedCandidate<T>, best: RankedCandidate<T>): boolean {
  return deadlinesAreClose(active.earliestDeadline, best.earliestDeadline)
    && deadlinesAreClose(active.primaryDeadline, best.primaryDeadline)
    && deadlinesAreClose(active.secondaryDeadline, best.secondaryDeadline)
    && active.bottleneckUsed <= best.bottleneckUsed + ACTIVE_USAGE_HYSTERESIS_PERCENT
    && (active.primary?.usedPercent ?? 0) <= (best.primary?.usedPercent ?? 0) + ACTIVE_USAGE_HYSTERESIS_PERCENT;
}

function chooseAvailable<T>(candidates: RankedCandidate<T>[]): {
  chosen: RankedCandidate<T> | undefined;
  keptActive: boolean;
} {
  const ordered = [...candidates].sort(compareRanked);
  const best = ordered[0];
  if (!best) return { chosen: undefined, keptActive: false };
  const active = ordered.find((candidate) => candidate.source.isActive);
  if (active && active !== best && activeIsEquivalent(active, best)) {
    return { chosen: active, keptActive: true };
  }
  return { chosen: best, keptActive: false };
}

function reasonFor<T>(candidate: RankedCandidate<T>): BestNowReason {
  if (Number.isFinite(candidate.primaryDeadline)
    && candidate.primaryDeadline === candidate.earliestDeadline) {
    return 'primary-reset-soon';
  }
  if (Number.isFinite(candidate.secondaryDeadline)
    && candidate.secondaryDeadline === candidate.earliestDeadline) {
    return 'secondary-reset-soon';
  }
  if (candidate.additional.some((window) => deadline(window, 0) === candidate.earliestDeadline)) {
    return 'additional-reset-soon';
  }
  return Number.isFinite(candidate.primaryDeadline)
    ? 'primary-reset-soon'
    : Number.isFinite(candidate.secondaryDeadline)
      ? 'secondary-reset-soon'
      : 'most-headroom';
}

/**
 * Choose the account that best preserves continuous usage.
 *
 * Reliable candidates are considered before stale or incomplete candidates. Within a
 * confidence tier, the scheduler keeps at least 5% headroom in every applicable window,
 * consumes useful capacity with the nearest reset first, and keeps an already-active
 * account when its deadlines and utilization are materially equivalent.
 */
export function selectBestNow<T>(
  candidates: BestNowCandidate<T>[],
  now = Date.now(),
): BestNowDecision<T> {
  const eligible = candidates.filter(isEligible);
  if (!eligible.length) {
    return { target: null, targetId: null, reason: 'no-eligible-account', confidence: 'high' };
  }

  const ranked: RankedCandidate<T>[] = eligible.flatMap((source) => {
    const legacyMetadata = source.metadata === undefined;
    const primary = effectiveWindow(source.primary, now, legacyMetadata);
    const secondary = effectiveWindow(source.secondary, now, legacyMetadata);
    const additional = (source.additional ?? []).flatMap((window) => {
      const effective = effectiveWindow(window, now, legacyMetadata);
      return effective ? [{ ...effective, name: window.name }] : [];
    });
    const allWindows = [primary, secondary, ...additional]
      .filter((window): window is EffectiveWindow => window !== null);
    if (!allWindows.length) return [];
    const primaryDeadline = deadline(primary, now);
    const secondaryDeadline = deadline(secondary, now);
    const earliestDeadline = Math.min(
      primaryDeadline,
      secondaryDeadline,
      ...additional.map((window) => deadline(window, now)),
    );
    return [{
      source,
      confidence: metadataConfidence(source, now),
      primary,
      secondary,
      additional,
      allWindows,
      earliestDeadline,
      primaryDeadline,
      secondaryDeadline,
      bottleneckUsed: Math.max(...allWindows.map((window) => window.usedPercent)),
    }];
  });

  if (!ranked.length) {
    return { target: null, targetId: null, reason: 'no-usage', confidence: 'low' };
  }

  const usable = ranked.filter(isUsable);
  const highConfidence = usable.filter((candidate) => candidate.confidence === 'high');
  const selection = chooseAvailable(highConfidence.length
    ? highConfidence
    : usable.filter((candidate) => candidate.confidence === 'low'));
  const chosen = selection.chosen;

  if (chosen) {
    const limitingAdditional = chosen.additional.find(
      (window) => deadline(window, now) === chosen.earliestDeadline,
    );
    return {
      target: chosen.source.account,
      targetId: chosen.source.id,
      reason: reasonFor(chosen),
      confidence: chosen.confidence,
      keptActive: selection.keptActive || undefined,
      primaryUsedPercent: chosen.primary?.usedPercent,
      primaryResetsAt: chosen.primary?.resetsAt,
      secondaryUsedPercent: chosen.secondary?.usedPercent,
      secondaryResetsAt: chosen.secondary?.resetsAt,
      limitingWindowName: limitingAdditional?.name,
      limitingUsedPercent: limitingAdditional?.usedPercent,
      limitingResetsAt: limitingAdditional?.resetsAt,
    };
  }

  const recoveries = ranked
    .map((candidate) => ({ candidate, at: availabilityAt(candidate, now) }))
    .filter((recovery) => Number.isFinite(recovery.at));
  const reliableRecoveries = recoveries.filter((recovery) => recovery.candidate.confidence === 'high');
  const orderedRecoveries = (reliableRecoveries.length ? reliableRecoveries : recoveries)
    .sort((a, b) => compareNumber(a.at, b.at) || a.candidate.source.id.localeCompare(b.candidate.source.id));
  const next = orderedRecoveries[0];
  const confidence = next?.candidate.confidence
    ?? (ranked.every((candidate) => candidate.confidence === 'high') ? 'high' : 'low');
  return {
    target: null,
    targetId: null,
    reason: ranked.every(hasExhaustedWindow) ? 'all-exhausted' : 'reserve-protected',
    confidence,
    nextAvailableId: next?.candidate.source.id,
    nextAvailableAt: next?.at,
  };
}
