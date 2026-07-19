import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claudeJsonPath,
  claudeProfileCredentialsPath,
  codexAuthPath,
  codexProfileHome,
  codexProfilesPath,
  profilesPath,
  credentialsPath,
} from '../src/paths';
import {
  archiveClaudeProfile,
  loadStore,
  mutateStore,
  reconcileStoreWithLive,
  restoreLatestDeletedProfile,
  saveStore,
} from '../src/profiles';
import {
  archiveCodexProfile,
  importCodexFromPath,
  bestNowCodex,
  codexUsageNeedsRefresh,
  effectiveCodexQuota,
  loadCodexStore,
  readCodexAuth,
  recoverAbandonedCodexHomes,
  restoreLatestDeletedCodexProfile,
  renameCodexProfile,
  saveCodexStore,
} from '../src/codexProfiles';
import { codexRedirectUriFromAuthUrl, validateCodexCallbackUrl } from '../src/codexAppServer';
import {
  applyCodexAuthTransaction,
  classifyCodexProcesses,
  codexProcessRootIds,
  remainingTrackedProcessIds,
  requestGracefulAppClose,
} from '../src/codexSwitch';
import { applyProfile, getLiveAccount, updateLiveCredentials } from '../src/claudeStore';
import { withFileLock } from '../src/locks';
import { moveProviderCursor, switchProviderTab } from '../src/navigation';
import { buildManualAuth } from '../src/oauth';
import { bestNow, fetchUsage, parseClaudeUsagePayload } from '../src/usage';
import { parseClaudeAuthStatusPayload } from '../src/claudeStatus';
import { selectBestNow } from '../src/scheduling';
import type { CodexAuthFile, CodexProfile, Profile, ProfilesStore } from '../src/types';

let root = '';

function resetRoot(): void {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-switch-test-'));
  process.env.CLAUDE_SWITCH_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'live-claude');
  process.env.CODEX_HOME = path.join(root, 'live-codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
}

function claudeProfile(id: string, email: string, needsReauth = false): Profile {
  return {
    id,
    provider: 'claude',
    label: email.split('@')[0],
    email,
    accountUuid: `account-${id}`,
    organizationUuid: `org-${id}`,
    oauthAccount: { accountUuid: `account-${id}`, emailAddress: email },
    claudeAiOauth: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
    needsReauth,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function store(profiles: Profile[], version = 1): ProfilesStore {
  return {
    version,
    activeProfileId: profiles[0]?.id ?? null,
    profiles,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codexAuth(accountId: string, email: string): CodexAuthFile {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: accountId,
      id_token: jwt({ email }),
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'team' } }),
      refresh_token: `refresh-${accountId}`,
    },
  };
}

test.afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

test('Claude quota payloads are validated before they can influence scheduling', () => {
  const fetchedAt = 1_234;
  const parsed = parseClaudeUsagePayload({
    five_hour: { utilization: 125, resets_at: '2026-07-15T12:00:00.000Z' },
    seven_day: null,
    limits: [
      {
        kind: 'weekly_scoped',
        percent: -3,
        resets_at: '2026-07-16T12:00:00.000Z',
        scope: { model: { display_name: 'Opus' } },
      },
      { kind: 'weekly_scoped', percent: 'secretly-not-a-number', scope: { model: { display_name: 'ignored' } } },
    ],
  }, fetchedAt);

  assert.equal(parsed.fetchedAt, fetchedAt);
  assert.equal(parsed.five_hour?.utilization, 100);
  assert.equal(parsed.seven_day, null);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'seven_day_opus'), false);
  assert.deepEqual(parsed.models, [{ name: 'Opus', utilization: 0, resets_at: '2026-07-16T12:00:00.000Z' }]);
  assert.equal(parsed.modelLimitsState, 'malformed');

  const absent = parseClaudeUsagePayload({ five_hour: null, seven_day: null }, fetchedAt);
  const empty = parseClaudeUsagePayload({ five_hour: null, seven_day: null, limits: [] }, fetchedAt);
  const complete = parseClaudeUsagePayload({
    five_hour: null,
    seven_day: null,
    limits: [{
      kind: 'weekly_scoped',
      percent: 42,
      scope: { model: { display_name: 'Sonnet' } },
    }],
  }, fetchedAt);
  const malformed = parseClaudeUsagePayload({ five_hour: null, seven_day: null, limits: {} }, fetchedAt);
  const unsupported = parseClaudeUsagePayload({
    five_hour: null,
    seven_day: null,
    limits: [{ kind: 'future_provider_bucket', percent: 10 }],
  }, fetchedAt);
  const currentProviderShape = parseClaudeUsagePayload({
    five_hour: { utilization: 4, resets_at: '2026-07-18T12:00:00.000Z' },
    seven_day: { utilization: 26, resets_at: '2026-07-22T12:00:00.000Z' },
    limits: [
      { kind: 'session', percent: 4, resets_at: null },
      { kind: 'weekly_all', percent: 26, resets_at: '2026-07-22T12:00:00.000Z' },
      {
        kind: 'weekly_scoped',
        percent: 22,
        resets_at: '2026-07-22T12:00:00.000Z',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  }, fetchedAt);
  const currentProviderShapeWithoutScopedLimits = parseClaudeUsagePayload({
    five_hour: null,
    seven_day: null,
    limits: [
      { kind: 'session', percent: 0, resets_at: null },
      { kind: 'weekly_all', percent: 28, resets_at: '2026-07-22T12:00:00.000Z' },
    ],
  }, fetchedAt);
  assert.equal(absent.modelLimitsState, 'absent');
  assert.equal(empty.modelLimitsState, 'empty');
  assert.equal(complete.modelLimitsState, 'complete');
  assert.deepEqual(complete.models, [{ name: 'Sonnet', utilization: 42, resets_at: null }]);
  assert.equal(malformed.modelLimitsState, 'malformed');
  assert.equal(unsupported.modelLimitsState, 'unsupported');
  assert.equal(currentProviderShape.modelLimitsState, 'complete');
  assert.deepEqual(currentProviderShape.models, [{
    name: 'Fable',
    utilization: 22,
    resets_at: '2026-07-22T12:00:00.000Z',
  }]);
  assert.equal(currentProviderShapeWithoutScopedLimits.modelLimitsState, 'empty');
  assert.equal(currentProviderShapeWithoutScopedLimits.models, undefined);
  assert.throws(
    () => parseClaudeUsagePayload({ five_hour: { utilization: '100', resets_at: null } }),
    /invalid five_hour utilization/,
  );
  assert.throws(
    () => parseClaudeUsagePayload({ five_hour: { utilization: 25, resets_at: 'not-a-date' } }),
    /invalid five_hour reset time/,
  );
  assert.throws(() => parseClaudeUsagePayload([]), /non-object response/);
});

test('official Claude auth status keeps the account and organization proof fields', () => {
  const observedAt = 1_234;
  assert.deepEqual(parseClaudeAuthStatusPayload({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'owner@example.test',
    orgId: 'provider-org-id',
    subscriptionType: 'Pro',
  }, observedAt), {
    loggedIn: true,
    email: 'owner@example.test',
    organizationId: 'provider-org-id',
    subscriptionType: 'pro',
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    observedAt,
  });
  assert.throws(() => parseClaudeAuthStatusPayload([]), /non-object response/i);
});

test('v1 migration restores the three-account backup and extracts Claude secrets', () => {
  resetRoot();
  const mike = claudeProfile('mike', 'mike@example.test', true);
  mike.claudeAiOauth = {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    scopes: [],
  };
  const ben = claudeProfile('ben', 'ben@example.test', true);
  const kireo = claudeProfile('kireo', 'kireo@example.test', true);
  writeJson(profilesPath(), store([mike]));
  writeJson(path.join(root, 'backups', 'profiles', 'profiles-three.json'), store([ben, kireo, mike]));

  const migrated = loadStore();
  assert.deepEqual(new Set(migrated.profiles.map((profile) => profile.id)), new Set(['ben', 'kireo', 'mike']));
  assert.equal(migrated.version, 3);
  assert.ok(migrated.profiles.every((profile) => profile.needsReauth));
  assert.doesNotMatch(fs.readFileSync(profilesPath(), 'utf8'), /claudeAiOauth/);
  for (const profile of migrated.profiles) {
    assert.ok(fs.existsSync(claudeProfileCredentialsPath(profile.id)));
    assert.ok(profile.claudeAiOauth);
  }
});

test('a tombstone prevents a stale Claude save from resurrecting a deletion', () => {
  resetRoot();
  const one = claudeProfile('one', 'one@example.test');
  const two = claudeProfile('two', 'two@example.test');
  two.desktopSnapshotDir = path.join(root, 'desktop', 'two');
  writeJson(path.join(two.desktopSnapshotDir, 'session.json'), { retained: true });
  saveStore(store([one, two], 3));
  const stale = loadStore();
  archiveClaudeProfile('two');
  saveStore(stale);
  const finalStore = loadStore();
  assert.deepEqual(finalStore.profiles.map((profile) => profile.id), ['one']);
  assert.ok(finalStore.tombstones?.some((entry) => entry.id === 'two'));
  assert.equal(fs.existsSync(path.join(two.desktopSnapshotDir, 'session.json')), true);
  assert.doesNotMatch(fs.readFileSync(profilesPath(), 'utf8'), /refresh-two/);

  const restored = mutateStore((fresh) => { restoreLatestDeletedProfile(fresh); });
  assert.deepEqual(new Set(restored.profiles.map((profile) => profile.id)), new Set(['one', 'two']));
  assert.ok(restored.tombstones?.some((entry) => entry.id === 'two' && entry.restoredAt));
  assert.ok(fs.existsSync(claudeProfileCredentialsPath('two')));
  assert.equal(restored.profiles.find((profile) => profile.id === 'two')?.desktopSnapshotDir, two.desktopSnapshotDir);

  // A process holding the pre-delete snapshot cannot replay the old deletion or
  // erase the explicitly restored account.
  saveStore(stale);
  assert.deepEqual(new Set(loadStore().profiles.map((profile) => profile.id)), new Set(['one', 'two']));
});

test('an interrupted Claude archive restore remains visible or retryable across the sidecar boundary', () => {
  resetRoot();
  const active = claudeProfile('restore-active', 'restore-active@example.test');
  const archived = claudeProfile('restore-interrupted', 'restore-interrupted@example.test');
  saveStore(store([active, archived], 3));
  archiveClaudeProfile(archived.id);

  const pendingMarker = path.join(
    path.dirname(claudeProfileCredentialsPath(archived.id)),
    '.archive-restore-pending.json',
  );
  const originalRename = fs.renameSync;
  let failedSidecar = false;
  fs.renameSync = ((source, destination) => {
    if (!failedSidecar && path.resolve(String(destination)) === path.resolve(`${profilesPath()}.bak`)) {
      failedSidecar = true;
      throw new Error('simulated restored-store sidecar failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => mutateStore((fresh) => { restoreLatestDeletedProfile(fresh); }),
      /simulated restored-store sidecar failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  // profiles.json atomically committed the restored row and restoredAt together. A
  // pending phase left by the failed sidecar write must not hide that committed row.
  const recovered = loadStore();
  assert.equal(recovered.profiles.some((profile) => profile.id === archived.id), true);
  assert.ok(recovered.tombstones?.find((entry) => entry.id === archived.id)?.restoredAt);
  assert.equal(fs.existsSync(pendingMarker), true);

  mutateStore((fresh) => {
    const restored = fresh.profiles.find((profile) => profile.id === archived.id);
    assert.ok(restored);
    restored.label = 'restored-after-sidecar-failure';
  });
  assert.equal(fs.existsSync(pendingMarker), false);
  assert.equal(loadStore().profiles.find((profile) => profile.id === archived.id)?.label, 'restored-after-sidecar-failure');
});

test('a Claude archive restore interrupted before its primary commit can be retried', () => {
  resetRoot();
  const active = claudeProfile('restore-retry-active', 'restore-retry-active@example.test');
  const archived = claudeProfile('restore-retry-target', 'restore-retry-target@example.test');
  saveStore(store([active, archived], 3));
  archiveClaudeProfile(archived.id);

  const originalRename = fs.renameSync;
  let failedPrimary = false;
  fs.renameSync = ((source, destination) => {
    if (!failedPrimary && path.resolve(String(destination)) === path.resolve(profilesPath())) {
      failedPrimary = true;
      throw new Error('simulated restored-store primary failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => mutateStore((fresh) => { restoreLatestDeletedProfile(fresh); }),
      /simulated restored-store primary failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  const stillArchived = loadStore();
  assert.equal(stillArchived.profiles.some((profile) => profile.id === archived.id), false);
  assert.equal(stillArchived.tombstones?.find((entry) => entry.id === archived.id)?.restoredAt, undefined);
  const retried = mutateStore((fresh) => { restoreLatestDeletedProfile(fresh); });
  assert.equal(retried.profiles.some((profile) => profile.id === archived.id), true);
});

test('targeted Claude mutations and the cross-process lock serialize concurrent work', async () => {
  resetRoot();
  saveStore(store([claudeProfile('one', 'one@example.test')], 3));
  await Promise.all([
    new Promise<void>((resolve) => setImmediate(() => {
      mutateStore((fresh) => { fresh.profiles[0].label = 'renamed'; });
      resolve();
    })),
    new Promise<void>((resolve) => setImmediate(() => {
      mutateStore((fresh) => { fresh.profiles[0].usage = { fetchedAt: 123, status: 'ok' }; });
      resolve();
    })),
  ]);
  const fresh = loadStore().profiles[0];
  assert.equal(fresh.label, 'renamed');
  assert.equal(fresh.usage?.fetchedAt, 123);

  const sequence: string[] = [];
  await Promise.all([
    withFileLock('ordering', async () => {
      sequence.push('first-enter');
      await new Promise((resolve) => setTimeout(resolve, 80));
      sequence.push('first-exit');
    }),
    new Promise<void>((resolve, reject) => setTimeout(() => {
      withFileLock('ordering', async () => { sequence.push('second-enter'); }).then(() => resolve(), reject);
    }, 10)),
  ]);
  assert.deepEqual(sequence, ['first-enter', 'first-exit', 'second-enter']);
});

test('Codex rollback restores live auth and never changes Claude credentials', async () => {
  resetRoot();
  saveStore(store([claudeProfile('claude-one', 'claude@example.test')], 3));
  const claudeBefore = fs.readFileSync(claudeProfileCredentialsPath('claude-one'), 'utf8');
  const oldAuth = codexAuth('workspace-old', 'old@example.test');
  writeJson(codexAuthPath(), oldAuth);
  const importFile = path.join(root, 'new-auth.json');
  writeJson(importFile, codexAuth('workspace-new', 'new@example.test'));
  const [profile] = await importCodexFromPath(importFile);
  const codexStoreBefore = fs.readFileSync(codexProfilesPath(), 'utf8');
  const codexCredentialBefore = fs.readFileSync(codexAuthPath(codexProfileHome(profile.id)), 'utf8');

  const claudeApplied = applyProfile(loadStore().profiles[0], { processInventory: () => [] });
  assert.equal(claudeApplied.ok, true);
  assert.equal(fs.readFileSync(codexProfilesPath(), 'utf8'), codexStoreBefore);
  assert.equal(fs.readFileSync(codexAuthPath(codexProfileHome(profile.id)), 'utf8'), codexCredentialBefore);

  const rolledBack = await applyCodexAuthTransaction(profile.id, async () => {
    throw new Error('forced validation failure');
  }, { processInventory: () => [] });
  assert.equal(rolledBack.ok, false);
  assert.equal(readCodexAuth(process.env.CODEX_HOME!)?.tokens.account_id, 'workspace-old');
  renameCodexProfile(profile.id, 'renamed Codex');
  assert.equal(fs.readFileSync(claudeProfileCredentialsPath('claude-one'), 'utf8'), claudeBefore);
});

test('a Codex tombstone blocks stale resurrection and provider cursors stay independent', async () => {
  resetRoot();
  const importFile = path.join(root, 'auth.json');
  writeJson(importFile, codexAuth('workspace-one', 'one@example.test'));
  const [profile] = await importCodexFromPath(importFile);
  const stale = loadCodexStore();
  await archiveCodexProfile(profile.id, {
    inspect: async () => ({ credentialStore: 'file', account: null }),
  });
  saveCodexStore(stale);
  assert.equal(loadCodexStore().profiles.length, 0);
  assert.equal(fs.existsSync(codexAuthPath(codexProfileHome(profile.id))), true);
  const restoredCodex = restoreLatestDeletedCodexProfile();
  assert.equal(restoredCodex.profiles.length, 1);
  assert.ok(restoredCodex.tombstones.some((entry) => entry.id === profile.id && entry.restoredAt));
  saveCodexStore(stale);
  assert.equal(loadCodexStore().profiles.length, 1);

  const initial = { provider: 'claude' as const, cursors: { claude: 2, codex: 5 } };
  const codexTab = switchProviderTab(initial, 'right');
  const moved = moveProviderCursor(codexTab, 'codex', 7, 1);
  const claudeTab = switchProviderTab(moved, 'left');
  assert.equal(claudeTab.provider, 'claude');
  assert.deepEqual(claudeTab.cursors, { claude: 2, codex: 6 });
});

test('portable login URLs support remote Claude authorization and a validated Codex callback', () => {
  const claude = new URL(buildManualAuth().url);
  assert.equal(claude.hostname, 'claude.ai');
  assert.equal(claude.searchParams.get('code'), 'true');
  assert.equal(claude.searchParams.get('redirect_uri'), 'https://console.anthropic.com/oauth/code/callback');

  const expected = 'http://localhost:1455/auth/callback';
  const authUrl = `https://auth.openai.com/authorize?redirect_uri=${encodeURIComponent(expected)}`;
  assert.equal(codexRedirectUriFromAuthUrl(authUrl), expected);
  assert.equal(
    validateCodexCallbackUrl(`${expected}?code=remote-code&state=state`, expected),
    `${expected}?code=remote-code&state=state`,
  );
  assert.throws(
    () => validateCodexCallbackUrl('http://localhost:9999/auth/callback?code=wrong', expected),
    /does not match/,
  );
});

test('live-auth drift clears only the Claude active marker and abandoned Codex sandboxes are preserved', () => {
  resetRoot();
  saveStore(store([claudeProfile('saved', 'saved@example.test')], 3));
  const reconciled = reconcileStoreWithLive();
  assert.equal(reconciled.activeProfileId, null);
  assert.equal(reconciled.profiles.length, 1);

  const pending = codexProfileHome('pending-abandoned');
  writeJson(path.join(pending, 'partial.json'), { incomplete: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(pending, old, old);
  const recovered = recoverAbandonedCodexHomes(0);
  assert.equal(recovered.length, 1);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.existsSync(path.join(recovered[0], 'partial.json')), true);
});

test('active Claude usage never rotates an expired live refresh token', async () => {
  resetRoot();
  const active = claudeProfile('active', 'active@example.test');
  active.claudeAiOauth!.expiresAt = Date.now() - 1;
  saveStore(store([active], 3));
  const originalRefresh = active.claudeAiOauth!.refreshToken;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('network must not be used when active refresh is denied');
  }) as typeof fetch;

  try {
    const result = await fetchUsage(active, 'test', { force: true, allowRefresh: false });
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'no valid access token');
    assert.equal(networkCalls, 0);
    assert.equal(active.claudeAiOauth!.refreshToken, originalRefresh);
    assert.equal(active.needsReauth, false);
    const persisted = loadStore().profiles[0];
    assert.equal(persisted.claudeAiOauth!.refreshToken, originalRefresh);
    assert.equal(persisted.needsReauth, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an expired active Claude token is safely renewed after reboot when no client is running', async () => {
  resetRoot();
  const active = claudeProfile('active-reboot', 'active-reboot@example.test');
  active.claudeAiOauth!.expiresAt = Date.now() - 15 * 60 * 60 * 1000;
  active.usage = {
    fetchedAt: Date.now() - 18 * 60 * 60 * 1000,
    status: 'stale',
    modelLimitsState: 'empty',
    five_hour: { utilization: 42, resets_at: new Date(Date.now() + 60_000).toISOString() },
    seven_day: { utilization: 30, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  };
  saveStore(store([active], 3));
  writeJson(credentialsPath(), {
    claudeAiOauth: active.claudeAiOauth,
    organizationUuid: active.organizationUuid,
  });
  writeJson(claudeJsonPath(), {
    oauthAccount: { ...active.oauthAccount, organizationUuid: active.organizationUuid },
  });

  const previousRefresh = active.claudeAiOauth!.refreshToken;
  const rotatedRefresh = `${previousRefresh}-rotated`;
  const rotatedAccess = 'access-active-reboot-rotated';
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let quotaCalls = 0;
  let processChecks = 0;
  globalThis.fetch = (async () => {
    quotaCalls++;
    return {
      status: 200,
      ok: true,
      json: async () => ({
        five_hour: { utilization: 7, resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
        seven_day: { utilization: 31, resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString() },
        limits: [],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const result = await fetchUsage(active, 'test', {
      force: true,
      allowRefresh: false,
      activeRefresh: {
        processInventory: () => {
          processChecks++;
          return [];
        },
        tokenRefresh: async (refresh) => {
          tokenCalls++;
          assert.equal(refresh, previousRefresh);
          return {
            accessToken: rotatedAccess,
            refreshToken: rotatedRefresh,
            expiresAt: Date.now() + 8 * 60 * 60 * 1000,
            scopes: ['user:inference'],
          };
        },
      },
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.five_hour?.utilization, 7);
    assert.equal(tokenCalls, 1);
    assert.equal(quotaCalls, 1);
    assert.equal(processChecks, 3);
    assert.equal(active.claudeAiOauth!.refreshToken, rotatedRefresh);
    assert.equal(getLiveAccount().claudeAiOauth?.refreshToken, rotatedRefresh);
    const persisted = loadStore().profiles.find((profile) => profile.id === active.id);
    assert.equal(persisted?.claudeAiOauth?.refreshToken, rotatedRefresh);
    assert.equal(persisted?.needsReauth, false);
    const envelope = JSON.parse(fs.readFileSync(claudeProfileCredentialsPath(active.id), 'utf8')) as {
      claudeAiOauth: { refreshToken: string };
    };
    assert.equal(envelope.claudeAiOauth.refreshToken, rotatedRefresh);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an expired active Claude token remains untouched while an official client is running', async () => {
  resetRoot();
  const active = claudeProfile('active-running', 'active-running@example.test');
  active.claudeAiOauth!.expiresAt = Date.now() - 1;
  active.usage = {
    fetchedAt: Date.now() - 60 * 60 * 1000,
    status: 'ok',
    modelLimitsState: 'empty',
    five_hour: { utilization: 18, resets_at: new Date(Date.now() + 60_000).toISOString() },
    seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  };
  saveStore(store([active], 3));
  writeJson(credentialsPath(), {
    claudeAiOauth: active.claudeAiOauth,
    organizationUuid: active.organizationUuid,
  });
  writeJson(claudeJsonPath(), {
    oauthAccount: { ...active.oauthAccount, organizationUuid: active.organizationUuid },
  });
  const previousRefresh = active.claudeAiOauth!.refreshToken;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let tokenCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('quota endpoint must not run without a valid active access token');
  }) as typeof fetch;

  try {
    const result = await fetchUsage(active, 'test', {
      force: true,
      allowRefresh: false,
      activeRefresh: {
        processInventory: () => [{ pid: 4242, name: 'claude.exe' }],
        tokenRefresh: async () => {
          tokenCalls++;
          throw new Error('active refresh must not start while Claude is running');
        },
      },
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.staleReason, 'active-client-running');
    assert.match(result.error ?? '', /Claude is running/);
    assert.equal(tokenCalls, 0);
    assert.equal(networkCalls, 0);
    assert.equal(active.claudeAiOauth!.refreshToken, previousRefresh);
    assert.equal(getLiveAccount().claudeAiOauth?.refreshToken, previousRefresh);
    assert.equal(loadStore().profiles[0].claudeAiOauth?.refreshToken, previousRefresh);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a live Claude rotation appearing during active refresh is never overwritten', async () => {
  resetRoot();
  const active = claudeProfile('active-race', 'active-race@example.test');
  active.claudeAiOauth!.expiresAt = Date.now() - 1;
  active.usage = {
    fetchedAt: Date.now() - 60 * 60 * 1000,
    status: 'stale',
    modelLimitsState: 'empty',
    five_hour: { utilization: 12, resets_at: new Date(Date.now() + 60_000).toISOString() },
    seven_day: { utilization: 23, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  };
  saveStore(store([active], 3));
  writeJson(credentialsPath(), {
    claudeAiOauth: active.claudeAiOauth,
    organizationUuid: active.organizationUuid,
  });
  writeJson(claudeJsonPath(), {
    oauthAccount: { ...active.oauthAccount, organizationUuid: active.organizationUuid },
  });
  const predecessor = active.claudeAiOauth!.refreshToken;
  const externalRefresh = `${predecessor}-official`;
  const candidateRefresh = `${predecessor}-switcher`;
  const originalFetch = globalThis.fetch;
  let quotaCalls = 0;
  globalThis.fetch = (async () => {
    quotaCalls++;
    throw new Error('quota endpoint must not run after a live-generation race');
  }) as typeof fetch;

  try {
    const result = await fetchUsage(active, 'test', {
      force: true,
      allowRefresh: false,
      activeRefresh: {
        processInventory: () => [],
        tokenRefresh: async () => {
          updateLiveCredentials({
            ...active.claudeAiOauth!,
            accessToken: 'access-active-race-official',
            refreshToken: externalRefresh,
            expiresAt: Date.now() + 8 * 60 * 60 * 1000,
          }, active.organizationUuid);
          return {
            accessToken: 'access-active-race-switcher',
            refreshToken: candidateRefresh,
            expiresAt: Date.now() + 8 * 60 * 60 * 1000,
          };
        },
      },
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.staleReason, 'active-token-protected');
    assert.equal(quotaCalls, 0);
    assert.equal(getLiveAccount().claudeAiOauth?.refreshToken, externalRefresh);
    assert.notEqual(getLiveAccount().claudeAiOauth?.refreshToken, candidateRefresh);
    assert.equal(loadStore().profiles[0].claudeAiOauth?.refreshToken, predecessor);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent Claude quota refreshes share one network request', async () => {
  resetRoot();
  const profile = claudeProfile('shared-refresh', 'shared@example.test');
  profile.claudeAiOauth!.expiresAt = Date.now() + 60 * 60 * 1000;
  saveStore(store([profile], 3));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => {
    networkCalls++;
    await gate;
    return {
      status: 200,
      ok: true,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: '2026-07-13T18:00:00.000Z' },
        seven_day: { utilization: 12, resets_at: '2026-07-19T18:00:00.000Z' },
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const first = fetchUsage(profile, 'test', { force: true });
    const second = fetchUsage(profile, 'test', { force: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(networkCalls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.five_hour?.utilization, 42);
    assert.deepEqual(b, a);
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
});

test('a stale cursor snapshot reuses quota data just persisted by startup refresh', async () => {
  resetRoot();
  const profile = claudeProfile('stale-cursor', 'cursor@example.test');
  profile.claudeAiOauth!.expiresAt = Date.now() + 60 * 60 * 1000;
  saveStore(store([profile], 3));
  const staleCursorProfile = { ...profile, usage: undefined };
  mutateStore((fresh) => {
    fresh.profiles[0].usage = {
      fetchedAt: Date.now(),
      status: 'ok',
      five_hour: { utilization: 18, resets_at: '2026-07-13T18:00:00.000Z' },
      seven_day: { utilization: 9, resets_at: '2026-07-19T18:00:00.000Z' },
    };
  });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('fresh persisted usage must satisfy the stale cursor request');
  }) as typeof fetch;

  try {
    const result = await fetchUsage(staleCursorProfile, 'test', { force: true });
    assert.equal(networkCalls, 0);
    assert.equal(result.five_hour?.utilization, 18);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('best-now spends quota that resets soon before untouched capacity', () => {
  const now = Date.parse('2026-07-13T08:00:00.000Z');
  const decision = selectBestNow([
    {
      id: 'fresh',
      account: 'fresh',
      eligible: true,
      primary: { usedPercent: 0, resetsAt: null },
      secondary: { usedPercent: 10, resetsAt: now + 5 * 24 * 60 * 60 * 1000 },
    },
    {
      id: 'expiring',
      account: 'expiring',
      eligible: true,
      primary: { usedPercent: 20, resetsAt: now + 60 * 60 * 1000 },
      secondary: { usedPercent: 40, resetsAt: now + 4 * 24 * 60 * 60 * 1000 },
    },
  ], now);

  assert.equal(decision.target, 'expiring');
  assert.equal(decision.reason, 'primary-reset-soon');
});

test('best-now skips exhausted accounts and reports the first real recovery', () => {
  const now = Date.parse('2026-07-13T08:00:00.000Z');
  const firstReset = now + 45 * 60 * 1000;
  const decision = selectBestNow([
    {
      id: 'five-hour-blocked',
      account: 'five-hour-blocked',
      eligible: true,
      primary: { usedPercent: 100, resetsAt: firstReset },
      secondary: { usedPercent: 20, resetsAt: now + 5 * 24 * 60 * 60 * 1000 },
    },
    {
      id: 'weekly-blocked',
      account: 'weekly-blocked',
      eligible: true,
      primary: { usedPercent: 30, resetsAt: now + 2 * 60 * 60 * 1000 },
      secondary: { usedPercent: 100, resetsAt: now + 3 * 60 * 60 * 1000 },
    },
  ], now);

  assert.equal(decision.target, null);
  assert.equal(decision.reason, 'all-exhausted');
  assert.equal(decision.nextAvailableId, 'five-hour-blocked');
  assert.equal(decision.nextAvailableAt, firstReset);
});

test('best-now treats an elapsed reset as fresh and Claude adapter rejects reauth profiles', () => {
  const now = Date.parse('2026-07-13T08:00:00.000Z');
  const elapsed = selectBestNow([
    {
      id: 'elapsed',
      account: 'elapsed',
      eligible: true,
      primary: { usedPercent: 100, resetsAt: now - 1 },
      secondary: { usedPercent: 25, resetsAt: now + 4 * 24 * 60 * 60 * 1000 },
    },
  ], now);
  assert.equal(elapsed.target, 'elapsed');

  const blocked = claudeProfile('blocked', 'blocked@example.test', true);
  blocked.usage = {
    fetchedAt: now,
    status: 'ok',
    five_hour: { utilization: 5, resets_at: new Date(now + 60_000).toISOString() },
    seven_day: { utilization: 5, resets_at: new Date(now + 120_000).toISOString() },
  };
  const usable = claudeProfile('usable', 'usable@example.test');
  usable.usage = {
    fetchedAt: now,
    status: 'ok',
    five_hour: { utilization: 30, resets_at: new Date(now + 2 * 60_000).toISOString() },
    seven_day: { utilization: 30, resets_at: new Date(now + 3 * 60_000).toISOString() },
  };
  assert.equal(bestNow([blocked, usable], null, now).target?.id, 'usable');
});

test('Codex best-now uses the same reset-aware scheduling policy', () => {
  const now = Date.parse('2026-07-13T08:00:00.000Z');
  const codex = (id: string, primary: number, primaryReset: number | null): CodexProfile => ({
    id,
    provider: 'codex',
    accountId: `account-${id}`,
    label: id,
    email: `${id}@example.test`,
    createdAt: now,
    usage: {
      fetchedAt: now,
      status: 'ok',
      bucket: {
        limitId: 'codex',
        primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: primaryReset ?? 0 },
        secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: Math.floor((now + 4 * 86_400_000) / 1000) },
      },
    },
  });
  const fresh = codex('fresh', 0, null);
  const expiring = codex('expiring', 35, Math.floor((now + 60 * 60 * 1000) / 1000));
  assert.equal(bestNowCodex([fresh, expiring], null, now).target?.id, 'expiring');
});

test('Codex quota aggregation uses every limit id consistently', () => {
  const account: CodexProfile = {
    id: 'multi-bucket',
    provider: 'codex',
    accountId: 'multi-bucket-account',
    email: 'multi@example.test',
    label: 'multi',
    createdAt: Date.now(),
    usage: {
      fetchedAt: Date.now(),
      status: 'ok',
      bucket: {
        limitId: 'default',
        primary: { usedPercent: 10, resetsAt: 100, windowDurationMins: 300 },
        secondary: { usedPercent: 20, resetsAt: 200, windowDurationMins: 10_080 },
      },
      buckets: {
        default: {
          limitId: 'default',
          primary: { usedPercent: 10, resetsAt: 100, windowDurationMins: 300 },
          secondary: { usedPercent: 20, resetsAt: 200, windowDurationMins: 10_080 },
        },
        constrained: {
          limitId: 'constrained',
          primary: { usedPercent: 80, resetsAt: 300, windowDurationMins: 300 },
          secondary: { usedPercent: 70, resetsAt: 400, windowDurationMins: 10_080 },
        },
      },
    },
  };
  const quota = effectiveCodexQuota(account);
  assert.equal(quota.primary?.usedPercent, 80);
  assert.equal(quota.secondary?.usedPercent, 70);
  assert.equal(quota.primaryComplete, true);
  assert.equal(quota.secondaryComplete, true);
});

test('Codex quota aggregation waits for every reserve-blocking bucket to reset', () => {
  const now = Date.now();
  const soon = Math.floor((now + 60_000) / 1000);
  const late = Math.floor((now + 7 * 86_400_000) / 1000);
  const account: CodexProfile = {
    id: 'blocking-buckets',
    provider: 'codex',
    accountId: 'blocking-buckets-account',
    email: 'blocking@example.test',
    label: 'blocking',
    createdAt: now,
    usage: {
      fetchedAt: now,
      status: 'ok',
      buckets: {
        exhausted: {
          limitId: 'exhausted',
          primary: { usedPercent: 100, resetsAt: soon, windowDurationMins: 300 },
          secondary: { usedPercent: 10, resetsAt: late, windowDurationMins: 10_080 },
        },
        reserved: {
          limitId: 'reserved',
          primary: { usedPercent: 99, resetsAt: late, windowDurationMins: 10_080 },
          secondary: { usedPercent: 10, resetsAt: late, windowDurationMins: 10_080 },
        },
      },
    },
  };
  const quota = effectiveCodexQuota(account);
  assert.equal(quota.primary?.usedPercent, 100);
  assert.equal(quota.primary?.resetsAt, late);
  const decision = bestNowCodex([account], null, now);
  assert.equal(decision.target, null);
  assert.equal(decision.nextAvailableAt, late * 1000);
});

test('Codex reached-state and elapsed-reset evidence force a conservative refresh', () => {
  const now = Date.now();
  const elapsed = Math.floor((now - 60_000) / 1000);
  const account: CodexProfile = {
    id: 'backend-reached',
    provider: 'codex',
    accountId: 'backend-reached-account',
    email: 'reached@example.test',
    label: 'reached',
    createdAt: now,
    usage: {
      fetchedAt: now,
      status: 'ok',
      bucket: {
        limitId: 'default',
        rateLimitReachedType: 'backend-classified',
        individualLimit: null,
        primary: { usedPercent: 10, resetsAt: elapsed, windowDurationMins: 300 },
        secondary: { usedPercent: 20, resetsAt: elapsed, windowDurationMins: 10_080 },
      },
    },
  };
  const quota = effectiveCodexQuota(account);
  assert.equal(quota.primary?.usedPercent, 100);
  assert.equal(quota.secondary?.usedPercent, 100);
  assert.equal(bestNowCodex([account], null, now).target, null);
  assert.equal(codexUsageNeedsRefresh(account, now), true);

  account.usage!.bucket!.rateLimitReachedType = null;
  account.usage!.bucket!.primary!.resetsAt = Math.floor((now + 60_000) / 1000);
  account.usage!.bucket!.secondary!.resetsAt = Math.floor((now + 120_000) / 1000);
  assert.equal(codexUsageNeedsRefresh(account, now), false);
});

test('Codex Best Now includes monthly and workspace spend-control constraints', () => {
  const now = Date.now();
  const monthlyReset = Math.floor((now + 30 * 86_400_000) / 1000);
  const account: CodexProfile = {
    id: 'monthly-limit',
    provider: 'codex',
    accountId: 'monthly-limit-account',
    email: 'monthly@example.test',
    label: 'monthly',
    createdAt: now,
    usage: {
      fetchedAt: now,
      status: 'ok',
      spendControlReached: false,
      bucket: {
        limitId: 'default',
        primary: { usedPercent: 10, resetsAt: Math.floor((now + 60_000) / 1000), windowDurationMins: 300 },
        secondary: { usedPercent: 20, resetsAt: Math.floor((now + 120_000) / 1000), windowDurationMins: 10_080 },
        individualLimit: {
          limit: '100',
          used: '99',
          remainingPercent: 1,
          resetsAt: monthlyReset,
        },
      },
    },
  };
  const quota = effectiveCodexQuota(account);
  assert.equal(quota.additional[0]?.usedPercent, 99);
  assert.equal(quota.additional[0]?.resetsAt, monthlyReset);
  assert.equal(bestNowCodex([account], null, now).nextAvailableAt, monthlyReset * 1000);

  account.usage!.bucket!.individualLimit = null;
  account.usage!.spendControlReached = true;
  const spendBlocked = effectiveCodexQuota(account);
  assert.equal(spendBlocked.additional[0]?.name, 'Workspace spend control');
  assert.equal(spendBlocked.additional[0]?.usedPercent, 100);
  assert.equal(bestNowCodex([account], null, now).target, null);
});

test('Codex tracks Desktop children and targets a VS Code Codex CLI without its parent', () => {
  const initial = new Set([101, 102]);
  const current = [
    { pid: 102, ppid: 1, name: 'codex.exe', commandLine: '', kind: 'cli' as const },
    { pid: 300, ppid: 1, name: 'codex.exe', commandLine: '', kind: 'cli' as const },
  ];
  assert.deepEqual(remainingTrackedProcessIds(initial, current), [102]);
  assert.deepEqual(codexProcessRootIds([
    { pid: 101, ppid: 1, name: 'ChatGPT.exe', commandLine: '', kind: 'app' },
    { pid: 102, ppid: 101, name: 'codex.exe', commandLine: '', kind: 'app' },
  ]), [101]);
  assert.deepEqual(codexProcessRootIds([
    { pid: 11448, ppid: 9000, name: 'codex.exe', commandLine: 'codex app-server', kind: 'cli' },
  ]), [11448]);
});

test('Codex process classification protects app-server and ambiguous children before Desktop ancestry', () => {
  const classified = classifyCodexProcesses([
    { ProcessId: 100, ParentProcessId: 1, Name: 'ChatGPT.exe', CommandLine: 'ChatGPT.exe', ExecutablePath: 'C:\\WindowsApps\\OpenAI.Codex_1\\ChatGPT.exe' },
    { ProcessId: 101, ParentProcessId: 100, Name: 'codex.exe', CommandLine: 'codex app-server', ExecutablePath: 'C:\\WindowsApps\\OpenAI.Codex_1\\codex.exe' },
    { ProcessId: 102, ParentProcessId: 100, Name: 'codex.exe', CommandLine: '', ExecutablePath: 'C:\\WindowsApps\\OpenAI.Codex_1\\codex.exe' },
    { ProcessId: 103, ParentProcessId: 100, Name: 'codex.exe', CommandLine: 'codex exec task', ExecutablePath: 'C:\\WindowsApps\\OpenAI.Codex_1\\codex.exe' },
  ], 999);
  assert.equal(classified.find((process) => process.pid === 100)?.kind, 'app');
  assert.equal(classified.find((process) => process.pid === 101)?.kind, 'helper');
  assert.equal(classified.find((process) => process.pid === 102)?.kind, 'helper');
  assert.equal(classified.find((process) => process.pid === 103)?.kind, 'app');
});

test('Codex Desktop close aborts without force or auth mutation when a helper appears during the wait', async () => {
  resetRoot();
  const auth = codexAuth('live-account', 'live@example.test');
  writeJson(codexAuthPath(), auth);
  const authBefore = fs.readFileSync(codexAuthPath());
  const app = { pid: 100, ppid: 1, name: 'ChatGPT.exe', commandLine: 'ChatGPT.exe', kind: 'app' as const };
  const helper = { pid: 101, ppid: 100, name: 'codex.exe', commandLine: 'codex app-server', kind: 'helper' as const };
  let inventoryCalls = 0;
  let closeCalls = 0;
  let forceCalls = 0;

  await assert.rejects(
    requestGracefulAppClose([app], {
      processInventory: () => (++inventoryCalls === 1 ? [app] : [helper]),
      requestClose: () => { closeCalls++; },
      waitForExit: async () => [],
      forceTerminate: () => { forceCalls++; },
    }),
    /app-server helper is still running/i,
  );

  assert.equal(closeCalls, 1);
  assert.equal(forceCalls, 0);
  assert.deepEqual(fs.readFileSync(codexAuthPath()), authBefore);
});
