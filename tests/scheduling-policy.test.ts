import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVE_DEADLINE_HYSTERESIS_MS,
  DEFAULT_QUOTA_FRESHNESS_MS,
  MIN_USABLE_HEADROOM_PERCENT,
  selectBestNow,
  type BestNowCandidate,
  type BestNowMetadata,
} from '../src/scheduling';
import { bestNow, describeClaudeRefreshResult, hasFreshCompleteClaudeUsage } from '../src/usage';
import type { Profile, UsageInfo } from '../src/types';

const now = Date.parse('2026-07-15T10:00:00.000Z');
const hour = 60 * 60 * 1000;
const day = 24 * hour;

function claudeProfile(id: string, usage: UsageInfo): Profile {
  return {
    id,
    provider: 'claude',
    label: id,
    email: `${id}@example.test`,
    accountUuid: `account-${id}`,
    organizationUuid: `org-${id}`,
    oauthAccount: { accountUuid: `account-${id}`, emailAddress: `${id}@example.test` },
    claudeAiOauth: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: now + day,
      scopes: ['user:inference'],
    },
    usage,
    createdAt: now,
  };
}

test('Claude Best Now refreshes a young cache after an applicable window reset elapsed', () => {
  const account = claudeProfile('elapsed-cache', {
    fetchedAt: now - 60_000,
    status: 'ok',
    modelLimitsState: 'empty',
    five_hour: { utilization: 100, resets_at: new Date(now - 1).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(now + day).toISOString() },
  });
  assert.equal(hasFreshCompleteClaudeUsage(account, now), false);
  account.usage!.five_hour!.resets_at = new Date(now + hour).toISOString();
  assert.equal(hasFreshCompleteClaudeUsage(account, now), true);
});

test('Claude refresh summary distinguishes protected active cache from real failures', () => {
  const freshOne = claudeProfile('fresh-one', {
    fetchedAt: now,
    status: 'ok',
    modelLimitsState: 'empty',
    five_hour: { utilization: 4, resets_at: new Date(now + hour).toISOString() },
    seven_day: { utilization: 26, resets_at: new Date(now + day).toISOString() },
  });
  const freshTwo = claudeProfile('fresh-two', {
    fetchedAt: now,
    status: 'ok',
    modelLimitsState: 'complete',
    models: [{ name: 'Fable', utilization: 22, resets_at: new Date(now + day).toISOString() }],
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 28, resets_at: new Date(now + day).toISOString() },
  });
  const protectedActive = claudeProfile('active', {
    fetchedAt: now - day,
    status: 'stale',
    modelLimitsState: 'unsupported',
    five_hour: { utilization: 18, resets_at: new Date(now + hour).toISOString() },
    seven_day: { utilization: 77, resets_at: new Date(now + day).toISOString() },
  });

  assert.equal(
    describeClaudeRefreshResult([freshOne, protectedActive, freshTwo], protectedActive.id, now),
    'Claude refresh: 2/3 fresh and complete; 1 active cached (live token protected).',
  );

  protectedActive.usage = { ...protectedActive.usage!, error: 'HTTP 503' };
  assert.equal(
    describeClaudeRefreshResult([freshOne, protectedActive, freshTwo], protectedActive.id, now),
    'Claude refresh: 2/3 fresh and complete; 1 unavailable or incomplete.',
  );

  protectedActive.usage = { ...protectedActive.usage!, status: 'ok' };
  assert.equal(
    describeClaudeRefreshResult([freshOne, protectedActive, freshTwo], protectedActive.id, now),
    'Claude refresh: 2/3 fresh and complete; 1 unavailable or incomplete.',
  );
});

function fresh(overrides: Partial<BestNowMetadata> = {}): BestNowMetadata {
  return {
    status: 'ok',
    fetchedAt: now,
    primaryComplete: true,
    secondaryComplete: true,
    ...overrides,
  };
}

function candidate(
  id: string,
  primaryUsed: number,
  primaryResetsAt: number | null,
  options: {
    active?: boolean;
    secondaryUsed?: number;
    secondaryResetsAt?: number | null;
    metadata?: BestNowMetadata;
    omitSecondary?: boolean;
    authorizationStatus?: BestNowCandidate<string>['authorizationStatus'];
    eligible?: boolean;
  } = {},
): BestNowCandidate<string> {
  const value: BestNowCandidate<string> = {
    id,
    account: id,
    eligible: options.eligible ?? true,
    authorizationStatus: options.authorizationStatus,
    isActive: options.active,
    primary: { usedPercent: primaryUsed, resetsAt: primaryResetsAt },
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
  if (!options.omitSecondary) {
    value.secondary = {
      usedPercent: options.secondaryUsed ?? 20,
      resetsAt: options.secondaryResetsAt === undefined ? now + 4 * day : options.secondaryResetsAt,
    };
  }
  return value;
}

test('legacy candidates remain high-confidence and retain elapsed-reset compatibility', () => {
  const decision = selectBestNow([
    candidate('legacy', 100, now - 1, { omitSecondary: true }),
  ], now);

  assert.equal(decision.target, 'legacy');
  assert.equal(decision.confidence, 'high');
  assert.equal(decision.primaryUsedPercent, 0);
});

test('fresh complete data wins over stale or unknown earlier deadlines', () => {
  const decision = selectBestNow([
    candidate('stale', 5, now + 5 * 60_000, {
      metadata: { status: 'stale', fetchedAt: now - hour, secondaryComplete: true },
    }),
    candidate('unknown', 1, now + 10 * 60_000, {
      metadata: { status: 'unknown', fetchedAt: now, secondaryComplete: true },
    }),
    candidate('reliable', 30, now + hour, { metadata: fresh() }),
  ], now);

  assert.equal(decision.target, 'reliable');
  assert.equal(decision.confidence, 'high');
});

test('an expired freshness timestamp is low-confidence even with status ok', () => {
  const decision = selectBestNow([
    candidate('expired-cache', 5, now + 5 * 60_000, {
      metadata: {
        status: 'ok',
        fetchedAt: now - DEFAULT_QUOTA_FRESHNESS_MS - 1,
        primaryComplete: true,
        secondaryComplete: true,
      },
    }),
    candidate('fresh-cache', 25, now + hour, { metadata: fresh() }),
  ], now);

  assert.equal(decision.target, 'fresh-cache');
  assert.equal(decision.confidence, 'high');
});

test('metadata-aware candidates require a complete secondary projection', () => {
  const decision = selectBestNow([
    candidate('secondary-unknown', 5, now + 5 * 60_000, {
      metadata: fresh({ secondaryComplete: false }),
      omitSecondary: true,
    }),
    candidate('secondary-complete', 30, now + hour, {
      metadata: fresh(),
      secondaryUsed: 0,
      secondaryResetsAt: null,
    }),
  ], now);

  assert.equal(decision.target, 'secondary-complete');
  assert.equal(decision.confidence, 'high');
});

test('omitted secondary data is not synthesized into a zero-usage seven-day window', () => {
  const decision = selectBestNow([
    candidate('secondary-omitted', 5, now + 5 * 60_000, {
      metadata: fresh({ secondaryComplete: false }),
      omitSecondary: true,
    }),
  ], now);

  assert.equal(decision.target, 'secondary-omitted');
  assert.equal(decision.confidence, 'low');
  assert.equal(decision.secondaryUsedPercent, undefined);
  assert.equal(decision.secondaryResetsAt, undefined);

  const confirmedNoSecondaryLimit = selectBestNow([{
    id: 'secondary-not-applicable',
    account: 'secondary-not-applicable',
    eligible: true,
    primary: { usedPercent: 10, resetsAt: now + hour },
    secondary: null,
    metadata: fresh(),
  }], now);
  assert.equal(confirmedNoSecondaryLimit.target, 'secondary-not-applicable');
  assert.equal(confirmedNoSecondaryLimit.confidence, 'high');
  assert.equal(confirmedNoSecondaryLimit.secondaryUsedPercent, undefined);
});

test('an explicitly non-applicable primary window can use a fresh complete secondary window', () => {
  const decision = selectBestNow([{
    id: 'weekly-only',
    account: 'weekly-only',
    eligible: true,
    primary: null,
    secondary: { usedPercent: 25, resetsAt: now + 2 * hour },
    metadata: fresh(),
  }], now);

  assert.equal(decision.target, 'weekly-only');
  assert.equal(decision.confidence, 'high');
  assert.equal(decision.reason, 'secondary-reset-soon');
  assert.equal(decision.primaryUsedPercent, undefined);
  assert.equal(decision.secondaryUsedPercent, 25);
});

test('metadata-aware candidates require a complete primary projection too', () => {
  const decision = selectBestNow([
    candidate('primary-incomplete', 5, now + 5 * 60_000, {
      metadata: fresh({ primaryComplete: false }),
    }),
    candidate('both-complete', 30, now + hour, { metadata: fresh() }),
  ], now);

  assert.equal(decision.target, 'both-complete');
  assert.equal(decision.confidence, 'high');
});

test('the scheduler preserves a five-percent reserve instead of selecting quota fragments', () => {
  const reserveBoundary = 100 - MIN_USABLE_HEADROOM_PERCENT;
  const decision = selectBestNow([
    candidate('fragment', reserveBoundary, now + 5 * 60_000),
    candidate('sustained', 20, now + hour),
  ], now);

  assert.equal(decision.target, 'sustained');
  assert.equal(decision.confidence, 'high');

  const protectedReserve = selectBestNow([
    candidate('fragment-only', reserveBoundary, now + 5 * 60_000),
  ], now);
  assert.equal(protectedReserve.target, null);
  assert.equal(protectedReserve.reason, 'reserve-protected');
  assert.equal(protectedReserve.nextAvailableAt, now + 5 * 60_000);

  const exhausted = selectBestNow([
    candidate('exhausted', 100, now + 10 * 60_000),
  ], now);
  assert.equal(exhausted.target, null);
  assert.equal(exhausted.reason, 'all-exhausted');
  assert.equal(exhausted.nextAvailableAt, now + 10 * 60_000);
});

test('expired and re-auth-required accounts are never selected', () => {
  const decision = selectBestNow([
    candidate('expired', 1, now + 60_000, { authorizationStatus: 'expired' }),
    candidate('reauth', 2, now + 2 * 60_000, { authorizationStatus: 'reauth-required' }),
    candidate('healthy', 30, now + hour, { authorizationStatus: 'valid' }),
  ], now);

  assert.equal(decision.target, 'healthy');

  const none = selectBestNow([
    candidate('expired-only', 1, now + 60_000, { authorizationStatus: 'expired' }),
    candidate('adapter-ineligible', 1, now + 60_000, { eligible: false }),
  ], now);
  assert.equal(none.target, null);
  assert.equal(none.reason, 'no-eligible-account');
});

test('low-confidence data remains an explicit fallback when no reliable candidate exists', () => {
  const decision = selectBestNow([
    candidate('cached-only', 25, now + hour, {
      metadata: { status: 'stale', fetchedAt: now - hour, primaryComplete: true, secondaryComplete: true },
    }),
  ], now);

  assert.equal(decision.target, 'cached-only');
  assert.equal(decision.confidence, 'low');
});

test('reasonable hysteresis keeps a materially equivalent active account', () => {
  const decision = selectBestNow([
    candidate('nominal-best', 20, now + hour, { metadata: fresh() }),
    candidate('active', 24, now + hour + ACTIVE_DEADLINE_HYSTERESIS_MS, {
      active: true,
      metadata: fresh(),
    }),
  ], now);

  assert.equal(decision.target, 'active');
  assert.equal(decision.confidence, 'high');
  assert.equal(decision.keptActive, true);
});

test('hysteresis never hides a meaningful deadline difference or a confidence downgrade', () => {
  const deadlineWinner = selectBestNow([
    candidate('deadline-best', 20, now + hour, { metadata: fresh() }),
    candidate('active-too-late', 20, now + hour + ACTIVE_DEADLINE_HYSTERESIS_MS + 1, {
      active: true,
      metadata: fresh(),
    }),
  ], now);
  assert.equal(deadlineWinner.target, 'deadline-best');
  assert.equal(deadlineWinner.keptActive, undefined);

  const confidenceWinner = selectBestNow([
    candidate('reliable', 30, now + 2 * hour, { metadata: fresh() }),
    candidate('active-stale', 5, now + 5 * 60_000, {
      active: true,
      metadata: { status: 'stale', fetchedAt: now - hour, primaryComplete: true, secondaryComplete: true },
    }),
  ], now);
  assert.equal(confidenceWinner.target, 'reliable');
  assert.equal(confidenceWinner.confidence, 'high');
});

test('stale elapsed resets are not promoted to fresh quota', () => {
  const decision = selectBestNow([
    candidate('stale-exhausted', 100, now - 1, {
      metadata: { status: 'stale', fetchedAt: now - day, primaryComplete: true, secondaryComplete: true },
    }),
    candidate('fresh', 40, now + hour, { metadata: fresh() }),
  ], now);

  assert.equal(decision.target, 'fresh');
  assert.equal(decision.primaryUsedPercent, 40);
  assert.equal(decision.confidence, 'high');
});

test('the earliest useful reset wins across primary and secondary windows', () => {
  const now = Date.parse('2026-07-15T10:00:00.000Z');
  const decision = selectBestNow([
    candidate('weekly-first', 20, null, {
      secondaryUsed: 40,
      secondaryResetsAt: now + 60 * 60_000,
    }),
    candidate('primary-later', 30, now + 5 * 60 * 60_000, {
      secondaryUsed: 20,
      secondaryResetsAt: null,
    }),
  ], now);
  assert.equal(decision.targetId, 'weekly-first');
  assert.equal(decision.reason, 'secondary-reset-soon');
});

test('additional scoped windows protect reserve and determine real recovery time', () => {
  const decision = selectBestNow([{
    id: 'model-limited',
    account: 'model-limited',
    eligible: true,
    primary: { usedPercent: 20, resetsAt: now + hour },
    secondary: { usedPercent: 30, resetsAt: now + day },
    additional: [{ name: 'Opus', usedPercent: 96, resetsAt: now + 3 * hour }],
  }], now);

  assert.equal(decision.target, null);
  assert.equal(decision.reason, 'reserve-protected');
  assert.equal(decision.nextAvailableAt, now + 3 * hour);

  const earliestScoped = selectBestNow([{
    id: 'scoped-first',
    account: 'scoped-first',
    eligible: true,
    primary: { usedPercent: 20, resetsAt: now + 4 * hour },
    secondary: { usedPercent: 30, resetsAt: now + day },
    additional: [{ name: 'Sonnet', usedPercent: 40, resetsAt: now + 30 * 60_000 }],
  }, candidate('regular', 10, now + hour)], now);

  assert.equal(earliestScoped.target, 'scoped-first');
  assert.equal(earliestScoped.reason, 'additional-reset-soon');
  assert.equal(earliestScoped.limitingWindowName, 'Sonnet');
  assert.equal(earliestScoped.limitingUsedPercent, 40);
});

test('Claude Best Now applies Opus, Sonnet and dynamic model limits', () => {
  const baseUsage = (): UsageInfo => ({
    fetchedAt: now,
    status: 'ok',
    modelLimitsState: 'empty',
    five_hour: { utilization: 10, resets_at: new Date(now + hour).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(now + day).toISOString() },
  });
  const opus = baseUsage();
  opus.seven_day_opus = { utilization: 95, resets_at: new Date(now + 2 * hour).toISOString() };
  const sonnet = baseUsage();
  sonnet.seven_day_sonnet = { utilization: 96, resets_at: new Date(now + 2 * hour).toISOString() };
  const model = baseUsage();
  model.models = [{ name: 'Future Model', utilization: 99, resets_at: new Date(now + 2 * hour).toISOString() }];
  model.modelLimitsState = 'complete';
  const healthy = baseUsage();
  healthy.five_hour = { utilization: 30, resets_at: new Date(now + 3 * hour).toISOString() };

  const decision = bestNow([
    claudeProfile('opus-limited', opus),
    claudeProfile('sonnet-limited', sonnet),
    claudeProfile('model-limited', model),
    claudeProfile('healthy', healthy),
  ], null, now);

  assert.equal(decision.targetId, 'healthy');
  assert.equal(decision.confidence, 'high');
});

test('Claude Best Now requires explicit completeness for dynamic model limits', () => {
  const usage = (modelLimitsState: UsageInfo['modelLimitsState']): UsageInfo => ({
    fetchedAt: now,
    status: 'ok',
    modelLimitsState,
    five_hour: { utilization: 10, resets_at: new Date(now + hour).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(now + day).toISOString() },
  });

  const absent = claudeProfile('limits-absent', usage('absent'));
  const malformed = claudeProfile('limits-malformed', usage('malformed'));
  const explicitEmpty = claudeProfile('limits-empty', usage('empty'));

  assert.equal(hasFreshCompleteClaudeUsage(absent, now), false);
  assert.equal(hasFreshCompleteClaudeUsage(malformed, now), false);
  assert.equal(hasFreshCompleteClaudeUsage(explicitEmpty, now), true);
  assert.equal(bestNow([absent], null, now).confidence, 'low');
  assert.equal(bestNow([malformed], null, now).confidence, 'low');
  assert.equal(bestNow([explicitEmpty], null, now).confidence, 'high');

  const forgedComplete = claudeProfile('limits-forged-complete', usage('complete'));
  assert.equal(hasFreshCompleteClaudeUsage(forgedComplete, now), false);
  assert.equal(bestNow([forgedComplete], null, now).confidence, 'low');

  const validCompleteUsage = usage('complete');
  validCompleteUsage.models = [{ name: 'Scoped', utilization: 30, resets_at: new Date(now + hour).toISOString() }];
  const validComplete = claudeProfile('limits-valid-complete', validCompleteUsage);
  assert.equal(hasFreshCompleteClaudeUsage(validComplete, now), true);
  assert.equal(bestNow([validComplete], null, now).confidence, 'high');
});
