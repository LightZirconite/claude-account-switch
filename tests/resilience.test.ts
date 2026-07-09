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
  saveStore,
} from '../src/profiles';
import {
  deleteCodexProfile,
  importCodexFromPath,
  loadCodexStore,
  readCodexAuth,
  renameCodexProfile,
  saveCodexStore,
} from '../src/codexProfiles';
import { applyCodexAuthTransaction } from '../src/codexSwitch';
import { applyProfile } from '../src/claudeStore';
import { withFileLock } from '../src/locks';
import { moveProviderCursor, switchProviderTab } from '../src/navigation';
import type { CodexAuthFile, Profile, ProfilesStore } from '../src/types';

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
  saveStore(store([claudeProfile('one', 'one@example.test'), claudeProfile('two', 'two@example.test')], 3));
  const stale = loadStore();
  mutateStore((fresh) => deleteProfile(fresh, 'two'));
  saveStore(stale);
  const finalStore = loadStore();
  assert.deepEqual(finalStore.profiles.map((profile) => profile.id), ['one']);
  assert.ok(finalStore.tombstones?.some((entry) => entry.id === 'two'));
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

  const initial = { provider: 'claude' as const, cursors: { claude: 2, codex: 5 } };
  const codexTab = switchProviderTab(initial, 'right');
  const moved = moveProviderCursor(codexTab, 'codex', 7, 1);
  const claudeTab = switchProviderTab(moved, 'left');
  assert.equal(claudeTab.provider, 'claude');
  assert.deepEqual(claudeTab.cursors, { claude: 2, codex: 6 });
});
