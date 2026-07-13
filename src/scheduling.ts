/** Provider-neutral quota scheduling used by both Claude and Codex adapters. */

export interface QuotaSnapshot {
  usedPercent: number | null;
  resetsAt: number | null;
}

export interface BestNowCandidate<T> {
  id: string;
  account: T;
  eligible: boolean;
  isActive?: boolean;
  primary?: QuotaSnapshot | null;
  secondary?: QuotaSnapshot | null;
}

export type BestNowReason =
  | 'primary-reset-soon'
  | 'secondary-reset-soon'
  | 'most-headroom'
  | 'all-exhausted'
  | 'no-usage'
  | 'no-eligible-account';

export interface BestNowDecision<T> {
  target: T | null;
  targetId: string | null;
  reason: BestNowReason;
  primaryUsedPercent?: number;
  primaryResetsAt?: number | null;
  secondaryUsedPercent?: number;
  secondaryResetsAt?: number | null;
  nextAvailableId?: string;
  nextAvailableAt?: number;
}

interface EffectiveWindow {
  usedPercent: number;
  resetsAt: number | null;
}

interface RankedCandidate<T> {
  source: BestNowCandidate<T>;
  primary: EffectiveWindow;
  secondary: EffectiveWindow | null;
  primaryDeadline: number;
  secondaryDeadline: number;
  bottleneckUsed: number;
}

function finiteReset(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function effectiveWindow(window: QuotaSnapshot | null | undefined, now: number): EffectiveWindow | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  const resetsAt = finiteReset(window.resetsAt);
  // A cached 100% value stops being a blocker once its provider-supplied reset
  // timestamp has elapsed. This also makes Best Now useful during a brief API outage.
  if (resetsAt !== null && resetsAt <= now) return { usedPercent: 0, resetsAt: null };
  return {
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    resetsAt,
  };
}

function deadline(window: EffectiveWindow | null, now: number): number {
  return window?.resetsAt !== null && window?.resetsAt !== undefined && window.resetsAt > now
    ? window.resetsAt
    : Number.POSITIVE_INFINITY;
}

function availabilityAt(candidate: RankedCandidate<unknown>, now: number): number {
  const blockers = [candidate.primary, candidate.secondary]
    .filter((window): window is EffectiveWindow => !!window && window.usedPercent >= 100);
  if (!blockers.length) return now;
  let availableAt = now;
  for (const blocker of blockers) {
    if (blocker.resetsAt === null || blocker.resetsAt <= now) return Number.POSITIVE_INFINITY;
    availableAt = Math.max(availableAt, blocker.resetsAt);
  }
  return availableAt;
}

/**
 * Choose the account that best preserves continuous usage.
 *
 * This is an earliest-deadline-first scheduler, not merely "lowest percentage":
 * consume an already-open 5-hour bucket before its remaining capacity expires,
 * then consider the weekly deadline, and finally raw headroom. Equivalent choices
 * prefer the active account to avoid a needless process/session switch.
 */
export function selectBestNow<T>(
  candidates: BestNowCandidate<T>[],
  now = Date.now(),
): BestNowDecision<T> {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (!eligible.length) {
    return { target: null, targetId: null, reason: 'no-eligible-account' };
  }

  const ranked: RankedCandidate<T>[] = eligible.flatMap((source) => {
    const primary = effectiveWindow(source.primary, now);
    if (!primary) return [];
    const secondary = effectiveWindow(source.secondary, now);
    return [{
      source,
      primary,
      secondary,
      primaryDeadline: deadline(primary, now),
      secondaryDeadline: deadline(secondary, now),
      bottleneckUsed: Math.max(primary.usedPercent, secondary?.usedPercent ?? 0),
    }];
  });

  if (!ranked.length) return { target: null, targetId: null, reason: 'no-usage' };

  const available = ranked.filter((candidate) =>
    candidate.primary.usedPercent < 100 && (candidate.secondary?.usedPercent ?? 0) < 100);

  available.sort((a, b) =>
    a.primaryDeadline - b.primaryDeadline
    || a.secondaryDeadline - b.secondaryDeadline
    || a.bottleneckUsed - b.bottleneckUsed
    || a.primary.usedPercent - b.primary.usedPercent
    || Number(!!b.source.isActive) - Number(!!a.source.isActive)
    || a.source.id.localeCompare(b.source.id));

  const chosen = available[0];
  if (chosen) {
    const reason: BestNowReason = Number.isFinite(chosen.primaryDeadline)
      ? 'primary-reset-soon'
      : Number.isFinite(chosen.secondaryDeadline)
        ? 'secondary-reset-soon'
        : 'most-headroom';
    return {
      target: chosen.source.account,
      targetId: chosen.source.id,
      reason,
      primaryUsedPercent: chosen.primary.usedPercent,
      primaryResetsAt: chosen.primary.resetsAt,
      secondaryUsedPercent: chosen.secondary?.usedPercent,
      secondaryResetsAt: chosen.secondary?.resetsAt,
    };
  }

  const recoveries = ranked
    .map((candidate) => ({ candidate, at: availabilityAt(candidate as RankedCandidate<unknown>, now) }))
    .filter((recovery) => Number.isFinite(recovery.at))
    .sort((a, b) => a.at - b.at || a.candidate.source.id.localeCompare(b.candidate.source.id));
  const next = recoveries[0];
  return {
    target: null,
    targetId: null,
    reason: 'all-exhausted',
    nextAvailableId: next?.candidate.source.id,
    nextAvailableAt: next?.at,
  };
}
