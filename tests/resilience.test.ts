import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claudeProfileCredentialsPath,
  codexAuthPath,
  codexProfileHome,
  codexProfilesPath,
  profilesPath,
} from '../src/paths';
import {
  deleteProfile,
  loadStore,
  mutateStore,
  reconcileWithLive,
  restoreLatestDeletedProfile,
  saveStore,
} from '../src/profiles';
import {
  deleteCodexProfile,
  importCodexFromPath,
  bestNowCodex,
  loadCodexStore,
  readCodexAuth,
  recoverAbandonedCodexHomes,
  restoreLatestDeletedCodexProfile,
  renameCodexProfile,
  saveCodexStore,
} from '../src/codexProfiles';
import { codexRedirectUriFromAuthUrl, validateCodexCallbackUrl } from '../src/codexAppServer';
import { applyCodexAuthTransaction, codexProcessRootIds, remainingTrackedProcessIds } from '../src/codexSwitch';
import { applyProfile } from '../src/claudeStore';
import { withFileLock } from '../src/locks';
import { moveProviderCursor, switchProviderTab } from '../src/navigation';
import { buildManualAuth } from '../src/oauth';
import { bestNow, fetchUsage } from '../src/usage';
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
  mutateStore((fresh) => deleteProfile(fresh, 'two'));
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
  const [profile] = importCodexFromPath(importFile);
  const codexStoreBefore = fs.readFileSync(codexProfilesPath(), 'utf8');
  const codexCredentialBefore = fs.readFileSync(codexAuthPath(codexProfileHome(profile.id)), 'utf8');

  const claudeApplied = applyProfile(loadStore().profiles[0]);
  assert.equal(claudeApplied.ok, true);
  assert.equal(fs.readFileSync(codexProfilesPath(), 'utf8'), codexStoreBefore);
  assert.equal(fs.readFileSync(codexAuthPath(codexProfileHome(profile.id)), 'utf8'), codexCredentialBefore);

  const rolledBack = await applyCodexAuthTransaction(profile.id, async () => {
    throw new Error('forced validation failure');
  });
  assert.equal(rolledBack.ok, false);
  assert.equal(readCodexAuth(process.env.CODEX_HOME!)?.tokens.account_id, 'workspace-old');
  renameCodexProfile(profile.id, 'renamed Codex');
  assert.equal(fs.readFileSync(claudeProfileCredentialsPath('claude-one'), 'utf8'), claudeBefore);
});

test('a Codex tombstone blocks stale resurrection and provider cursors stay independent', () => {
  resetRoot();
  const importFile = path.join(root, 'auth.json');
  writeJson(importFile, codexAuth('workspace-one', 'one@example.test'));
  const [profile] = importCodexFromPath(importFile);
  const stale = loadCodexStore();
  deleteCodexProfile(profile.id);
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
  const reconciled = mutateStore((fresh) => { reconcileWithLive(fresh); });
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
