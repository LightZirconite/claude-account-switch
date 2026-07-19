import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  backupsDir,
  claudeJsonPath,
  claudeProfileCredentialsPath,
  codexAuthPath,
  codexProfileHome,
  codexProfilesPath,
  credentialsPath,
  dataDir,
} from '../src/paths';
import {
  applyProfile,
  backupLive,
  claudeLiveAuthJournalPath,
  inspectClaudeLiveAuthRecovery,
  recoverClaudeLiveAuthTransaction,
  restoreFromBackup,
} from '../src/claudeStore';
import {
  applyDesktopSnapshot,
  inspectDesktopRecovery,
  recoverDesktopTransactions,
  snapshotLiveDesktopInto,
} from '../src/desktopStore';
import {
  archiveCodexProfile,
  codexCredentialLockName,
  exportAllCodexProfiles,
  importCodexFromPath,
  loadCodexStore,
  readCodexAuth,
  reconcileLiveCodex,
  renameCodexProfile,
  setActiveCodexProfile,
  writeCodexProfileAuth,
} from '../src/codexProfiles';
import {
  addOrUpdateProfile,
  archiveClaudeProfile,
  captureDesktopAccount,
  loadStore,
  mutateStore,
  reconcileStoreWithProviderProof,
  reconcileStoreWithLive,
  saveStore,
  checkpointClaudeAuthorization,
  fieldsFromRawFiles,
  finalizeClaudeAuthorization,
  exportAllProfiles,
  exportProfile,
  persistProfileCredentials,
  syntheticClaudeAccountId,
} from '../src/profiles';
import { ensureFreshToken, fetchUsage } from '../src/usage';
import { AbandonedFileLockError, withFileLock } from '../src/locks';
import {
  BACKUP_RETENTION_PROTECTION_MARKER,
  protectBackupFromRetention,
  pruneManagedBackupDirs,
} from '../src/retention';
import { applyCodexAuthTransaction, restoreCodexLiveBackup } from '../src/codexSwitch';
import { primeIdentity } from '../src/oauth';
import type { CodexAuthFile, Profile, ProfilesStore } from '../src/types';

let root = '';
const desktopTestOptions = { assertClaudeClosed: (): void => {} };

function resetRoot(): void {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-durability-test-'));
  process.env.CLAUDE_SWITCH_HOME = path.join(root, 'switch');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'live-claude');
  process.env.CODEX_HOME = path.join(root, 'live-codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function profile(id: string): Profile {
  return {
    id,
    provider: 'claude',
    label: id,
    email: `${id}@example.test`,
    accountUuid: `account-${id}`,
    organizationUuid: `org-${id}`,
    oauthAccount: { accountUuid: `account-${id}`, emailAddress: `${id}@example.test`, organizationUuid: `org-${id}` },
    claudeAiOauth: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function profilesStore(profiles: Profile[]): ProfilesStore {
  return { version: 3, revision: 0, activeProfileId: profiles[0]?.id ?? null, profiles };
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
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
      refresh_token: `refresh-${accountId}`,
    },
  };
}

test.afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

test('an unattributed live Claude rotation is quarantined before another profile is applied', () => {
  resetRoot();
  const outgoing = profile('outgoing');
  const target = profile('target');
  saveStore(profilesStore([outgoing, target]));

  writeJson(credentialsPath(), {
    claudeAiOauth: { ...outgoing.claudeAiOauth, accessToken: 'live-access-r1', refreshToken: 'live-refresh-r1' },
    organizationUuid: outgoing.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: outgoing.oauthAccount });

  const reconciled = reconcileStoreWithLive();
  assert.equal(reconciled.profiles.find((candidate) => candidate.id === outgoing.id)?.claudeAiOauth?.refreshToken, outgoing.claudeAiOauth?.refreshToken);
  const recovery = reconciled.profiles.find((candidate) => candidate.accountUuid?.startsWith('pending:'));
  assert.equal(recovery?.claudeAiOauth?.refreshToken, 'live-refresh-r1');
  assert.equal(recovery?.needsReauth, true);
  assert.equal(reconciled.activeProfileId, null);
  assert.equal(applyProfile(reconciled.profiles.find((candidate) => candidate.id === target.id)!, { processInventory: () => [] }).ok, true);
  assert.equal(loadStore().profiles.find((candidate) => candidate.id === recovery?.id)?.claudeAiOauth?.refreshToken, 'live-refresh-r1');
});

test('provider-proved normal Claude rotation promotes the canonical account and keeps it active', () => {
  resetRoot();
  const active = profile('proved-live-rotation');
  saveStore(profilesStore([active]));
  const rotatedOauth = {
    ...active.claudeAiOauth!,
    accessToken: 'proved-live-access-r2',
    refreshToken: 'proved-live-refresh-r2',
    expiresAt: Date.now() + 3_600_000,
  };
  writeJson(credentialsPath(), { claudeAiOauth: rotatedOauth, organizationUuid: active.organizationUuid });
  writeJson(claudeJsonPath(), { oauthAccount: active.oauthAccount, userID: active.userID });

  const reconciled = reconcileStoreWithProviderProof(undefined, {
    processInventory: () => [],
    identityProbe: (pending, checkpoint) => {
      const identity = {
        claudeAiOauth: pending.claudeAiOauth!,
        oauthAccount: active.oauthAccount!,
        userID: active.userID,
        organizationUuidRoot: active.organizationUuidRoot,
      };
      checkpoint(identity);
      return identity;
    },
  });

  assert.equal(reconciled.activeProfileId, active.id);
  assert.equal(reconciled.profiles.length, 1);
  assert.equal(reconciled.profiles[0].claudeAiOauth?.refreshToken, rotatedOauth.refreshToken);
  assert.equal(reconciled.profiles[0].needsReauth, false);
});

test('official live Claude status promotes a normal active rotation without starting a second credential owner', () => {
  resetRoot();
  const active = profile('live-status-rotation');
  saveStore(profilesStore([active]));
  const rotatedOauth = {
    ...active.claudeAiOauth!,
    accessToken: 'live-status-access-r2',
    refreshToken: 'live-status-refresh-r2',
    expiresAt: Date.now() + 3_600_000,
  };
  writeJson(credentialsPath(), { claudeAiOauth: rotatedOauth, organizationUuid: active.organizationUuid });
  writeJson(claudeJsonPath(), { oauthAccount: active.oauthAccount, userID: active.userID });

  let isolatedProbeCalls = 0;
  const reconciled = reconcileStoreWithProviderProof(undefined, {
    processInventory: () => [{ pid: 4242, name: 'claude' }],
    authStatusProbe: () => ({
      loggedIn: true,
      email: active.email,
      organizationId: active.organizationUuid,
      subscriptionType: 'pro',
      observedAt: Date.now(),
    }),
    identityProbe: () => {
      isolatedProbeCalls++;
      throw new Error('must not launch beside the live Claude process');
    },
  });

  assert.equal(isolatedProbeCalls, 0);
  assert.equal(reconciled.activeProfileId, active.id);
  assert.equal(reconciled.profiles.length, 1);
  assert.equal(reconciled.profiles[0].claudeAiOauth?.refreshToken, rotatedOauth.refreshToken);
  assert.equal(reconciled.profiles[0].needsReauth, false);
  assert.equal(reconciled.profiles[0].planSource, 'claude-auth-status');
});

test('official Claude status never resolves a new chain when provider email disagrees', () => {
  resetRoot();
  const saved = profile('live-status-mismatch');
  saveStore(profilesStore([saved]));
  const savedRefresh = saved.claudeAiOauth?.refreshToken;
  writeJson(credentialsPath(), {
    claudeAiOauth: {
      ...saved.claudeAiOauth!,
      accessToken: 'mismatched-status-access',
      refreshToken: 'mismatched-status-refresh',
    },
    organizationUuid: saved.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: saved.oauthAccount, userID: saved.userID });

  const reconciled = reconcileStoreWithProviderProof(undefined, {
    processInventory: () => [{ pid: 4243, name: 'claude' }],
    authStatusProbe: () => ({
      loggedIn: true,
      email: 'different-account@example.test',
      organizationId: saved.organizationUuid,
      observedAt: Date.now(),
    }),
  });

  assert.equal(reconciled.activeProfileId, null);
  assert.equal(reconciled.profiles.length, 2);
  assert.equal(reconciled.profiles.find((candidate) => candidate.id === saved.id)?.claudeAiOauth?.refreshToken, savedRefresh);
  assert.equal(reconciled.profiles.find((candidate) => candidate.id !== saved.id)?.claudeAiOauth?.refreshToken, 'mismatched-status-refresh');
});

test('Claude reconciliation rejects a hybrid live identity and token generation', () => {
  resetRoot();
  const identityOwner = profile('hybrid-identity');
  const tokenOwner = profile('hybrid-token');
  saveStore(profilesStore([identityOwner, tokenOwner]));
  const identityEnvelopeBefore = fs.readFileSync(claudeProfileCredentialsPath(identityOwner.id));
  const tokenEnvelopeBefore = fs.readFileSync(claudeProfileCredentialsPath(tokenOwner.id));

  writeJson(credentialsPath(), {
    claudeAiOauth: tokenOwner.claudeAiOauth,
    organizationUuid: tokenOwner.organizationUuid,
  });
  writeJson(claudeJsonPath(), {
    oauthAccount: identityOwner.oauthAccount,
    userID: identityOwner.userID,
  });

  assert.throws(
    () => reconcileStoreWithLive(),
    /live identity and refresh-token chain belong to different saved profiles/,
  );
  assert.deepEqual(fs.readFileSync(claudeProfileCredentialsPath(identityOwner.id)), identityEnvelopeBefore);
  assert.deepEqual(fs.readFileSync(claudeProfileCredentialsPath(tokenOwner.id)), tokenEnvelopeBefore);
});

test('Claude reconciliation quarantines an unknown token paired with a stale known identity', () => {
  resetRoot();
  const saved = profile('known-hybrid-identity');
  saveStore(profilesStore([saved]));
  const envelopeBefore = fs.readFileSync(claudeProfileCredentialsPath(saved.id));

  writeJson(credentialsPath(), {
    claudeAiOauth: {
      accessToken: 'unknown-new-login-access',
      refreshToken: 'unknown-new-login-refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
    },
    organizationUuid: 'different-new-login-organization',
  });
  writeJson(claudeJsonPath(), { oauthAccount: saved.oauthAccount });

  const reconciled = reconcileStoreWithLive();
  assert.deepEqual(fs.readFileSync(claudeProfileCredentialsPath(saved.id)), envelopeBefore);
  const recovery = reconciled.profiles.find((candidate) => candidate.id !== saved.id);
  assert.equal(recovery?.accountUuid?.startsWith('pending:'), true);
  assert.equal(recovery?.claudeAiOauth?.refreshToken, 'unknown-new-login-refresh');
  assert.equal(recovery?.oauthAccount?.accountUuid, '');
  assert.equal(reconciled.activeProfileId, null);
});

test('same-organization Claude accounts never use organizationUuid as token ownership proof', () => {
  resetRoot();
  const saved = profile('same-org-a');
  saved.organizationUuid = 'shared-team-org';
  saved.organizationUuidRoot = 'shared-team-org';
  saved.oauthAccount = { ...saved.oauthAccount, organizationUuid: 'shared-team-org' };
  saveStore(profilesStore([saved]));
  const envelopeBefore = fs.readFileSync(claudeProfileCredentialsPath(saved.id));

  writeJson(credentialsPath(), {
    claudeAiOauth: {
      accessToken: 'same-org-account-b-access',
      refreshToken: 'same-org-account-b-refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
    },
    organizationUuid: 'shared-team-org',
  });
  writeJson(claudeJsonPath(), { oauthAccount: saved.oauthAccount });

  const reconciled = reconcileStoreWithLive();
  assert.deepEqual(fs.readFileSync(claudeProfileCredentialsPath(saved.id)), envelopeBefore);
  const recovery = reconciled.profiles.find((candidate) => candidate.id !== saved.id);
  assert.equal(recovery?.claudeAiOauth?.refreshToken, 'same-org-account-b-refresh');
  assert.equal(recovery?.needsReauth, true);

  const resolved = reconcileStoreWithProviderProof(undefined, {
    processInventory: () => [],
    identityProbe: (pending, checkpoint) => {
      const identity = {
        claudeAiOauth: pending.claudeAiOauth!,
        oauthAccount: {
          accountUuid: 'same-org-account-b',
          emailAddress: 'same-org-b@example.test',
          organizationUuid: 'shared-team-org',
        },
        organizationUuidRoot: 'shared-team-org',
      };
      checkpoint(identity);
      return identity;
    },
  });
  assert.equal(resolved.profiles.find((candidate) => candidate.id === saved.id)?.claudeAiOauth?.refreshToken, saved.claudeAiOauth?.refreshToken);
  assert.ok(resolved.profiles.some((candidate) => candidate.accountUuid === 'same-org-account-b'));
  assert.equal(resolved.activeProfileId, null);
});

test('an ambiguous live chain for an archived Claude identity is quarantined without resurrection', () => {
  resetRoot();
  const active = profile('archive-checkpoint-active');
  const archived = profile('archive-checkpoint-target');
  saveStore(profilesStore([active, archived]));
  writeJson(credentialsPath(), {
    claudeAiOauth: active.claudeAiOauth,
    organizationUuid: active.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: active.oauthAccount });
  archiveClaudeProfile(archived.id);

  const rotatedRefresh = 'archive-checkpoint-refresh-r2';
  writeJson(credentialsPath(), {
    claudeAiOauth: {
      ...archived.claudeAiOauth,
      accessToken: 'archive-checkpoint-access-r2',
      refreshToken: rotatedRefresh,
      expiresAt: Date.now() + 3_600_000,
    },
    organizationUuid: archived.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: archived.oauthAccount });

  const reconciled = reconcileStoreWithLive();
  assert.equal(reconciled.activeProfileId, null);
  assert.equal(reconciled.profiles.some((candidate) => candidate.id === archived.id), false);
  assert.ok(reconciled.tombstones?.some((tombstone) => tombstone.id === archived.id && !tombstone.restoredAt));
  const envelope = JSON.parse(fs.readFileSync(claudeProfileCredentialsPath(archived.id), 'utf8')) as {
    claudeAiOauth: { refreshToken: string };
  };
  assert.equal(envelope.claudeAiOauth.refreshToken, archived.claudeAiOauth?.refreshToken);
  const recovery = reconciled.profiles.find((candidate) => candidate.accountUuid?.startsWith('pending:'));
  assert.equal(recovery?.claudeAiOauth?.refreshToken, rotatedRefresh);

  assert.equal(applyProfile(active, { processInventory: () => [] }).ok, true);
  const afterSwitch = JSON.parse(fs.readFileSync(claudeProfileCredentialsPath(archived.id), 'utf8')) as {
    claudeAiOauth: { refreshToken: string };
  };
  assert.equal(afterSwitch.claudeAiOauth.refreshToken, archived.claudeAiOauth?.refreshToken);
  assert.equal(loadStore().profiles.find((candidate) => candidate.id === recovery?.id)?.claudeAiOauth?.refreshToken, rotatedRefresh);
});

test('Claude apply rollback restores files that were initially absent', () => {
  resetRoot();
  const target = profile('rollback-target');
  saveStore(profilesStore([target]));
  fs.rmSync(credentialsPath(), { force: true });
  fs.rmSync(claudeJsonPath(), { force: true });

  const originalRename = fs.renameSync;
  fs.renameSync = ((source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(claudeJsonPath())) {
      throw new Error('simulated second live-file write failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    const result = applyProfile(target, { processInventory: () => [] });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /simulated second live-file write failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.existsSync(credentialsPath()), false);
  assert.equal(fs.existsSync(claudeJsonPath()), false);
});

test('a consumed Claude OAuth code is checkpointed before identity enrichment', () => {
  resetRoot();
  const oauth = {
    accessToken: 'new-issued-access',
    refreshToken: 'new-issued-refresh',
    expiresAt: Date.now() + 60_000,
    scopes: ['user:inference'],
  };
  const checkpoint = checkpointClaudeAuthorization(oauth);
  assert.equal(checkpoint.profile.needsReauth, true);
  assert.equal(loadStore().profiles[0].claudeAiOauth?.refreshToken, 'new-issued-refresh');
  assert.equal(fs.existsSync(`${claudeProfileCredentialsPath(checkpoint.profile.id)}.bak`), true);

  const finalized = finalizeClaudeAuthorization(checkpoint.profile.id, {
    email: 'durable@example.test',
    accountUuid: 'durable-account',
    organizationUuid: 'durable-org',
    organizationUuidRoot: 'durable-org',
    subscriptionType: 'pro',
    claudeAiOauth: { ...oauth, accessToken: 'resolved-access', refreshToken: 'resolved-refresh' },
    oauthAccount: {
      accountUuid: 'durable-account',
      emailAddress: 'durable@example.test',
      organizationUuid: 'durable-org',
    },
  });
  assert.equal(finalized.profile.id, checkpoint.profile.id);
  assert.equal(finalized.profile.needsReauth, false);
  assert.equal(loadStore().profiles[0].claudeAiOauth?.refreshToken, 'resolved-refresh');
});

test('an unresolved Claude re-authorization never email-merges over a known credential chain', () => {
  resetRoot();
  const known = profile('unresolved-reauth-known');
  saveStore(profilesStore([known]));
  const knownEnvelope = fs.readFileSync(claudeProfileCredentialsPath(known.id));
  const unresolvedOauth = {
    accessToken: 'unresolved-reauth-access',
    refreshToken: 'unresolved-reauth-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference'],
  };
  const checkpoint = checkpointClaudeAuthorization(unresolvedOauth);
  const finalized = finalizeClaudeAuthorization(checkpoint.profile.id, {
    email: known.email,
    accountUuid: syntheticClaudeAccountId(unresolvedOauth),
    organizationUuid: '',
    claudeAiOauth: unresolvedOauth,
    oauthAccount: { accountUuid: '', emailAddress: known.email },
  });

  assert.equal(finalized.store.profiles.length, 2);
  assert.equal(finalized.profile.id, checkpoint.profile.id);
  assert.equal(finalized.profile.needsReauth, true);
  assert.deepEqual(fs.readFileSync(claudeProfileCredentialsPath(known.id)), knownEnvelope);
  assert.equal(finalized.store.profiles.find((candidate) => candidate.id === known.id)?.claudeAiOauth?.refreshToken, known.claudeAiOauth?.refreshToken);
});

test('a stale metadata save cannot overwrite a newly promoted Claude refresh-token generation', () => {
  resetRoot();
  const original = profile('credential-cas');
  saveStore(profilesStore([original]));
  const staleSnapshot = loadStore();
  const rotated: Profile = {
    ...original,
    claudeAiOauth: {
      ...original.claudeAiOauth!,
      accessToken: 'credential-cas-access-r2',
      refreshToken: 'credential-cas-refresh-r2',
      expiresAt: Date.now() + 3_600_000,
    },
    updatedAt: Date.now(),
  };

  persistProfileCredentials(rotated, {
    expectedPreviousRefreshToken: original.claudeAiOauth!.refreshToken,
  });
  staleSnapshot.profiles[0].label = 'Renamed from stale snapshot';
  saveStore(staleSnapshot);

  for (const file of [claudeProfileCredentialsPath(original.id), `${claudeProfileCredentialsPath(original.id)}.bak`]) {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth: { refreshToken: string } };
    assert.equal(envelope.claudeAiOauth.refreshToken, 'credential-cas-refresh-r2');
  }
  const generationDir = path.join(path.dirname(claudeProfileCredentialsPath(original.id)), 'generations');
  const generations = fs.readdirSync(generationDir).map((file) =>
    JSON.parse(fs.readFileSync(path.join(generationDir, file), 'utf8')) as { claudeAiOauth: { refreshToken: string } });
  assert.ok(generations.some((entry) => entry.claudeAiOauth.refreshToken === original.claudeAiOauth!.refreshToken));
  assert.ok(generations.some((entry) => entry.claudeAiOauth.refreshToken === 'credential-cas-refresh-r2'));
});

test('Claude credential generation history stays bounded while retaining the newest durable chain', () => {
  resetRoot();
  const saved = profile('bounded-credential-history');
  saveStore(profilesStore([saved]));
  let current = loadStore().profiles.find((candidate) => candidate.id === saved.id)!;

  for (let generation = 1; generation <= 32; generation++) {
    const predecessor = current.claudeAiOauth!.refreshToken;
    current = {
      ...current,
      claudeAiOauth: {
        ...current.claudeAiOauth!,
        accessToken: `bounded-access-${generation}`,
        refreshToken: `bounded-refresh-${generation}`,
        expiresAt: Date.now() + generation * 1_000,
      },
      updatedAt: Date.now(),
    };
    persistProfileCredentials(current, { expectedPreviousRefreshToken: predecessor });
  }

  const generationDir = path.join(path.dirname(claudeProfileCredentialsPath(saved.id)), 'generations');
  assert.equal(fs.readdirSync(generationDir).filter((file) => file.endsWith('.json')).length, 24);
  assert.equal(loadStore().profiles.find((candidate) => candidate.id === saved.id)?.claudeAiOauth?.refreshToken, 'bounded-refresh-32');
  for (const file of [claudeProfileCredentialsPath(saved.id), `${claudeProfileCredentialsPath(saved.id)}.bak`]) {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth: { refreshToken: string } };
    assert.equal(envelope.claudeAiOauth.refreshToken, 'bounded-refresh-32');
  }
});

test('identity metadata failure still checkpoints the newest rotated Claude credential', (t) => {
  if (process.platform === 'darwin') return t.skip('Claude OAuth is Keychain-backed on macOS.');
  const tokens = {
    accessToken: 'prime-access-old',
    refreshToken: 'prime-refresh-old',
    expiresAt: Date.now() + 60_000,
    scopes: ['user:inference'],
  };
  let tempHome = '';
  let checkpointedRefresh = '';
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (tempHome && path.resolve(String(file)) === path.resolve(path.join(tempHome, '.claude.json'))) {
      throw new Error('simulated identity metadata read failure');
    }
    return (originalRead as (...readArgs: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  try {
    const identity = primeIdentity(tokens, 'unused-claude', undefined, (resolved) => {
      checkpointedRefresh = resolved.claudeAiOauth.refreshToken;
    }, {
      runIdentityLookup: (_exe, home) => {
        tempHome = home;
        writeJson(path.join(home, '.credentials.json'), {
          claudeAiOauth: {
            ...tokens,
            accessToken: 'prime-access-rotated',
            refreshToken: 'prime-refresh-rotated',
          },
        });
        writeJson(path.join(home, '.claude.json'), { oauthAccount: { accountUuid: 'rotated-account' } });
        return { status: 0 };
      },
    });
    assert.equal(identity.claudeAiOauth.refreshToken, 'prime-refresh-rotated');
    assert.equal(checkpointedRefresh, 'prime-refresh-rotated');
    assert.equal(fs.existsSync(tempHome), false);
  } finally {
    fs.readFileSync = originalRead;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('an unreadable post-probe Claude credential retains the isolated recovery home', (t) => {
  if (process.platform === 'darwin') return t.skip('Claude OAuth is Keychain-backed on macOS.');
  const tokens = {
    accessToken: 'prime-unreadable-access-old',
    refreshToken: 'prime-unreadable-refresh-old',
    expiresAt: Date.now() + 60_000,
    scopes: ['user:inference'],
  };
  let tempHome = '';
  let checkpointCalled = false;
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (tempHome && path.resolve(String(file)) === path.resolve(path.join(tempHome, '.credentials.json'))) {
      throw new Error('simulated rotated credential read failure');
    }
    return (originalRead as (...readArgs: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => primeIdentity(tokens, 'unused-claude', undefined, () => {
      checkpointCalled = true;
    }, {
      runIdentityLookup: (_exe, home) => {
        tempHome = home;
        writeJson(path.join(home, '.credentials.json'), {
          claudeAiOauth: {
            ...tokens,
            accessToken: 'prime-unreadable-access-rotated',
            refreshToken: 'prime-unreadable-refresh-rotated',
          },
        });
        return { status: 0 };
      },
    }), /isolated recovery home was retained/);
    assert.equal(checkpointCalled, false);
    assert.equal(fs.existsSync(tempHome), true);
  } finally {
    fs.readFileSync = originalRead;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('missing live Claude identity preserves the exact-token active profile', () => {
  resetRoot();
  const active = profile('identity-temporarily-missing');
  saveStore(profilesStore([active]));
  writeJson(credentialsPath(), {
    claudeAiOauth: active.claudeAiOauth,
    organizationUuid: active.organizationUuid,
  });
  fs.rmSync(claudeJsonPath(), { force: true });

  const reconciled = reconcileStoreWithLive();
  assert.equal(reconciled.activeProfileId, active.id);
  assert.equal(reconciled.profiles[0].claudeAiOauth?.refreshToken, active.claudeAiOauth?.refreshToken);
});

test('manual Claude restore rolls back both files when the second write fails', () => {
  resetRoot();
  writeJson(credentialsPath(), { claudeAiOauth: profile('target-backup').claudeAiOauth, organizationUuid: 'target-org' });
  fs.writeFileSync(claudeJsonPath(), '{\n  // official JSONC is supported\n  "oauthAccount": { "accountUuid": "target-account" },\n}\n');
  const targetBackup = backupLive();

  const oldCredentials = `${JSON.stringify({ claudeAiOauth: profile('old-live').claudeAiOauth, organizationUuid: 'old-org' }, null, 2)}\n`;
  const oldClaudeJson = `${JSON.stringify({ oauthAccount: { accountUuid: 'old-account' }, userID: 'old-user' }, null, 2)}\n`;
  fs.writeFileSync(credentialsPath(), oldCredentials);
  fs.writeFileSync(claudeJsonPath(), oldClaudeJson);

  const originalRename = fs.renameSync;
  let failedOnce = false;
  fs.renameSync = ((source, destination) => {
    if (!failedOnce && path.resolve(String(destination)) === path.resolve(claudeJsonPath())) {
      failedOnce = true;
      throw new Error('simulated restore second-write failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => restoreFromBackup(targetBackup, { processInventory: () => [] }),
      /previous live authentication was restored/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), oldCredentials);
  assert.equal(fs.readFileSync(claudeJsonPath(), 'utf8'), oldClaudeJson);
});

test('an abrupt process death between Claude live files is recovered from the durable journal', () => {
  resetRoot();
  const outgoing = profile('journal-outgoing');
  const target = profile('journal-target');
  writeJson(credentialsPath(), {
    claudeAiOauth: outgoing.claudeAiOauth,
    organizationUuid: outgoing.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: outgoing.oauthAccount, userID: outgoing.userID });
  const outgoingCredentials = fs.readFileSync(credentialsPath());
  const outgoingIdentity = fs.readFileSync(claudeJsonPath());
  const targetPath = path.join(root, 'journal-target-profile.json');
  writeJson(targetPath, target);

  // The child exits synchronously at the real atomic rename boundary for the second
  // provider file. Production code has no crash-simulation flag or bypass.
  const source = `
    import fs from 'node:fs';
    import path from 'node:path';
    const identityPath = path.resolve(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
    const originalRename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (path.resolve(String(to)) === identityPath) process.exit(86);
      return originalRename(from, to);
    };
    const { withFileLockSync } = await import(process.env.LOCKS_MODULE);
    const { applyProfile } = await import(process.env.CLAUDE_STORE_MODULE);
    const target = JSON.parse(fs.readFileSync(process.env.TEST_TARGET_PROFILE, 'utf8'));
    const result = withFileLockSync('claude-provider-switch', () => (
      applyProfile(target, { processInventory: () => [] })
    ));
    process.exit(result.ok ? 0 : 87);
  `;
  const crashed = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_STORE_MODULE: pathToFileURL(path.resolve('src/claudeStore.ts')).href,
        LOCKS_MODULE: pathToFileURL(path.resolve('src/locks.ts')).href,
        TEST_TARGET_PROFILE: targetPath,
      },
      timeout: 30_000,
    },
  );
  assert.equal(crashed.status, 86, `child did not stop at the transaction midpoint: ${crashed.stderr}`);
  const providerLock = path.join(dataDir(), 'locks', 'claude-provider-switch.lock');
  const liveLock = path.join(dataDir(), 'locks', 'claude-live-auth.lock');
  assert.equal(fs.existsSync(providerLock), true);
  assert.equal(fs.existsSync(liveLock), true);

  const interrupted = inspectClaudeLiveAuthRecovery();
  assert.equal(interrupted.pending, true);
  assert.equal(interrupted.damaged, false);
  assert.equal(interrupted.state, 'applying');
  assert.ok(interrupted.backupDir);
  assert.equal(
    fs.existsSync(path.join(interrupted.backupDir!, BACKUP_RETENTION_PROTECTION_MARKER)),
    true,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')).claudeAiOauth.refreshToken,
    target.claudeAiOauth?.refreshToken,
  );
  assert.deepEqual(fs.readFileSync(claudeJsonPath()), outgoingIdentity);

  const journalBeforeBlockedRecovery = fs.readFileSync(claudeLiveAuthJournalPath());
  assert.throws(
    () => recoverClaudeLiveAuthTransaction({
      processInventory: () => [{ pid: 9917, name: 'claude' }],
    }),
    /Close Claude first/,
  );
  assert.deepEqual(fs.readFileSync(claudeLiveAuthJournalPath()), journalBeforeBlockedRecovery);
  assert.equal(
    fs.existsSync(path.join(interrupted.backupDir!, BACKUP_RETENTION_PROTECTION_MARKER)),
    true,
  );

  // A replacement backup can be internally self-consistent; the journal's manifest
  // digest must still reject it as the wrong generation before any recovery write.
  const backupCredentialsPath = path.join(interrupted.backupDir!, '.credentials.json');
  const backupManifestPath = path.join(interrupted.backupDir!, 'transaction.json');
  const originalBackupCredentials = fs.readFileSync(backupCredentialsPath);
  const originalBackupManifest = fs.readFileSync(backupManifestPath);
  const substituted = `${JSON.stringify({
    claudeAiOauth: profile('coherent-but-wrong-generation').claudeAiOauth,
    organizationUuid: 'coherent-but-wrong-generation-org',
  }, null, 2)}\n`;
  fs.writeFileSync(backupCredentialsPath, substituted, 'utf8');
  const replacedManifest = JSON.parse(originalBackupManifest.toString('utf8')) as {
    credentials: { present: true; sha256: string };
  };
  replacedManifest.credentials.sha256 = crypto.createHash('sha256').update(substituted).digest('hex');
  fs.writeFileSync(backupManifestPath, `${JSON.stringify(replacedManifest, null, 2)}\n`, 'utf8');
  const hybridCredentials = fs.readFileSync(credentialsPath());
  assert.throws(
    () => recoverClaudeLiveAuthTransaction({ processInventory: () => [] }),
    /manifest generation anchored by the journal/,
  );
  assert.deepEqual(fs.readFileSync(credentialsPath()), hybridCredentials);
  assert.deepEqual(fs.readFileSync(claudeJsonPath()), outgoingIdentity);
  assert.equal(fs.existsSync(path.join(interrupted.backupDir!, BACKUP_RETENTION_PROTECTION_MARKER)), true);
  fs.writeFileSync(backupCredentialsPath, originalBackupCredentials);
  fs.writeFileSync(backupManifestPath, originalBackupManifest);

  const recovered = recoverClaudeLiveAuthTransaction({ processInventory: () => [] });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.action, 'rolled-back');
  assert.deepEqual(fs.readFileSync(credentialsPath()), outgoingCredentials);
  assert.deepEqual(fs.readFileSync(claudeJsonPath()), outgoingIdentity);
  assert.equal(inspectClaudeLiveAuthRecovery().pending, false);
  assert.equal(fs.existsSync(claudeLiveAuthJournalPath()), false);
  assert.equal(
    fs.existsSync(path.join(interrupted.backupDir!, BACKUP_RETENTION_PROTECTION_MARKER)),
    false,
  );
  assert.equal(fs.existsSync(providerLock), false);
  assert.equal(fs.existsSync(liveLock), false);
});

test('a malformed Claude live-auth journal freezes mutations and preserves protected evidence', () => {
  resetRoot();
  const outgoing = profile('damaged-journal-outgoing');
  writeJson(credentialsPath(), {
    claudeAiOauth: outgoing.claudeAiOauth,
    organizationUuid: outgoing.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: outgoing.oauthAccount, userID: outgoing.userID });
  const outgoingCredentials = fs.readFileSync(credentialsPath());
  const outgoingIdentity = fs.readFileSync(claudeJsonPath());
  const evidence = backupLive({ protectUntilTransactionEnds: true });
  fs.mkdirSync(path.dirname(claudeLiveAuthJournalPath()), { recursive: true });
  fs.writeFileSync(claudeLiveAuthJournalPath(), '{ definitely-not-valid-json\n', 'utf8');
  const damagedJournal = fs.readFileSync(claudeLiveAuthJournalPath());

  assert.deepEqual(inspectClaudeLiveAuthRecovery(), {
    pending: true,
    damaged: true,
    journalPath: claudeLiveAuthJournalPath(),
  });
  assert.throws(
    () => recoverClaudeLiveAuthTransaction({ processInventory: () => [] }),
    /journal is damaged/,
  );
  const refused = applyProfile(profile('must-not-overwrite-damaged-journal'), {
    processInventory: () => [],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /journal is damaged/);
  assert.deepEqual(fs.readFileSync(claudeLiveAuthJournalPath()), damagedJournal);
  assert.deepEqual(fs.readFileSync(credentialsPath()), outgoingCredentials);
  assert.deepEqual(fs.readFileSync(claudeJsonPath()), outgoingIdentity);
  assert.equal(fs.existsSync(path.join(evidence, BACKUP_RETENTION_PROTECTION_MARKER)), true);
});

test('terminal Claude journal cleanup never requires Claude to be closed', () => {
  resetRoot();
  const outgoing = profile('terminal-cleanup-outgoing');
  const target = profile('terminal-cleanup-target');
  writeJson(credentialsPath(), {
    claudeAiOauth: outgoing.claudeAiOauth,
    organizationUuid: outgoing.organizationUuid,
  });
  writeJson(claudeJsonPath(), { oauthAccount: outgoing.oauthAccount, userID: outgoing.userID });

  const originalRm = fs.rmSync;
  let deferredOnce = false;
  fs.rmSync = ((selected, options) => {
    if (!deferredOnce && path.resolve(String(selected)) === path.resolve(claudeLiveAuthJournalPath())) {
      deferredOnce = true;
      throw new Error('simulated terminal journal cleanup interruption');
    }
    return originalRm(selected, options as never);
  }) as typeof fs.rmSync;
  let applied;
  try {
    applied = applyProfile(target, { processInventory: () => [] });
  } finally {
    fs.rmSync = originalRm;
  }
  assert.equal(applied.ok, true);
  assert.equal(inspectClaudeLiveAuthRecovery().state, 'committed');

  let processScans = 0;
  const cleanup = recoverClaudeLiveAuthTransaction({
    processInventory: () => {
      processScans++;
      return [{ pid: 8851, name: 'claude' }];
    },
  });
  assert.equal(cleanup.action, 'cleaned-terminal');
  assert.equal(processScans, 0);
  assert.equal(inspectClaudeLiveAuthRecovery().pending, false);
  assert.equal(
    JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')).claudeAiOauth.refreshToken,
    target.claudeAiOauth?.refreshToken,
  );
});

test('Claude restore pins the oldest retained generation while staging its rollback backup', () => {
  resetRoot();
  const target = profile('oldest-claude-restore');
  writeJson(credentialsPath(), { claudeAiOauth: target.claudeAiOauth, organizationUuid: target.organizationUuid });
  writeJson(claudeJsonPath(), { oauthAccount: target.oauthAccount, userID: target.userID });
  const oldest = backupLive();
  fs.utimesSync(oldest, new Date(1_000), new Date(1_000));

  for (let index = 0; index < 19; index++) {
    const generation = profile(`claude-retention-${index}`);
    writeJson(credentialsPath(), { claudeAiOauth: generation.claudeAiOauth, organizationUuid: generation.organizationUuid });
    writeJson(claudeJsonPath(), { oauthAccount: generation.oauthAccount, userID: generation.userID });
    backupLive();
  }
  const current = profile('claude-before-oldest-restore');
  writeJson(credentialsPath(), { claudeAiOauth: current.claudeAiOauth, organizationUuid: current.organizationUuid });
  writeJson(claudeJsonPath(), { oauthAccount: current.oauthAccount, userID: current.userID });

  restoreFromBackup(oldest, { processInventory: () => [] });
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')).claudeAiOauth.refreshToken, target.claudeAiOauth?.refreshToken);
  assert.equal(JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8')).oauthAccount.accountUuid, target.accountUuid);
  assert.equal(fs.existsSync(oldest), true);
});

test('legacy Claude backups without integrity manifests fail before live writes', () => {
  resetRoot();
  const liveCredentials = `${JSON.stringify({ claudeAiOauth: profile('live-safe').claudeAiOauth }, null, 2)}\n`;
  const liveIdentity = `${JSON.stringify({ oauthAccount: { accountUuid: 'live-safe-account' } }, null, 2)}\n`;
  fs.writeFileSync(credentialsPath(), liveCredentials);
  fs.writeFileSync(claudeJsonPath(), liveIdentity);

  const partial = path.join(root, 'legacy-partial');
  writeJson(path.join(partial, '.credentials.json'), { claudeAiOauth: profile('partial').claudeAiOauth });
  assert.throws(
    () => restoreFromBackup(partial, { processInventory: () => [] }),
    /predates complete integrity manifests/,
  );
  assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), liveCredentials);
  assert.equal(fs.readFileSync(claudeJsonPath(), 'utf8'), liveIdentity);

  const complete = path.join(root, 'legacy-complete');
  writeJson(path.join(complete, '.credentials.json'), { claudeAiOauth: profile('complete').claudeAiOauth });
  writeJson(path.join(complete, '.claude.json'), { oauthAccount: { accountUuid: 'complete-account' } });
  assert.throws(
    () => restoreFromBackup(complete, { processInventory: () => [{ pid: 4321, name: 'claude' }] }),
    /predates complete integrity manifests/,
  );
  assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), liveCredentials);
  assert.equal(fs.readFileSync(claudeJsonPath(), 'utf8'), liveIdentity);
});

test('Claude v2 backup manifests reject altered presence and digest declarations before writes', () => {
  resetRoot();
  writeJson(credentialsPath(), { claudeAiOauth: profile('manifest-source').claudeAiOauth, organizationUuid: 'manifest-org' });
  writeJson(claudeJsonPath(), { oauthAccount: { accountUuid: 'manifest-source-account' } });
  const backup = backupLive();
  const manifestPath = path.join(backup, 'transaction.json');
  const originalManifest = fs.readFileSync(manifestPath, 'utf8');

  const liveCredentials = `${JSON.stringify({ claudeAiOauth: profile('manifest-live').claudeAiOauth }, null, 2)}\n`;
  const liveIdentity = `${JSON.stringify({ oauthAccount: { accountUuid: 'manifest-live-account' } }, null, 2)}\n`;
  fs.writeFileSync(credentialsPath(), liveCredentials);
  fs.writeFileSync(claudeJsonPath(), liveIdentity);

  const missingDigest = JSON.parse(originalManifest) as {
    credentials: { present: boolean; sha256?: string };
  };
  delete missingDigest.credentials.sha256;
  fs.writeFileSync(manifestPath, `${JSON.stringify(missingDigest, null, 2)}\n`);
  assert.throws(
    () => restoreFromBackup(backup, { processInventory: () => [] }),
    /incomplete or invalid transaction manifest/,
  );
  assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), liveCredentials);
  assert.equal(fs.readFileSync(claudeJsonPath(), 'utf8'), liveIdentity);

  const falseAbsence = JSON.parse(originalManifest) as {
    claudeJson: { present: boolean; sha256?: string };
  };
  falseAbsence.claudeJson = { present: false };
  fs.writeFileSync(manifestPath, `${JSON.stringify(falseAbsence, null, 2)}\n`);
  assert.throws(
    () => restoreFromBackup(backup, { processInventory: () => [] }),
    /incomplete or invalid transaction manifest/,
  );
  assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), liveCredentials);
  assert.equal(fs.readFileSync(claudeJsonPath(), 'utf8'), liveIdentity);
});

test('Claude switch and restore recheck processes at the exact mutation boundary', () => {
  resetRoot();
  const active = profile('mutation-guard-active');
  const target = profile('mutation-guard-target');
  writeJson(credentialsPath(), { claudeAiOauth: active.claudeAiOauth, organizationUuid: active.organizationUuid });
  writeJson(claudeJsonPath(), { oauthAccount: active.oauthAccount, userID: active.userID });
  const liveCredentials = fs.readFileSync(credentialsPath());
  const liveIdentity = fs.readFileSync(claudeJsonPath());

  let switchScans = 0;
  const switched = applyProfile(target, {
    processInventory: () => (++switchScans === 1 ? [] : [{ pid: 701, name: 'claude' }]),
  });
  assert.equal(switched.ok, false);
  assert.match(switched.error ?? '', /appeared while staging the switch/);
  assert.deepEqual(fs.readFileSync(credentialsPath()), liveCredentials);
  assert.deepEqual(fs.readFileSync(claudeJsonPath()), liveIdentity);

  writeJson(credentialsPath(), { claudeAiOauth: target.claudeAiOauth, organizationUuid: target.organizationUuid });
  writeJson(claudeJsonPath(), { oauthAccount: target.oauthAccount, userID: target.userID });
  const restoreTarget = backupLive();
  fs.writeFileSync(credentialsPath(), liveCredentials);
  fs.writeFileSync(claudeJsonPath(), liveIdentity);
  let restoreScans = 0;
  assert.throws(
    () => restoreFromBackup(restoreTarget, {
      processInventory: () => (++restoreScans < 3 ? [] : [{ pid: 702, name: 'claude' }]),
    }),
    /appeared while staging the restore/,
  );
  assert.deepEqual(fs.readFileSync(credentialsPath()), liveCredentials);
  assert.deepEqual(fs.readFileSync(claudeJsonPath()), liveIdentity);
});

test('manual Codex restore is provider-scoped and rolls back a failed atomic replacement', async () => {
  resetRoot();
  const oldAuth = codexAuth('codex-restore-old', 'old-restore@example.test');
  writeJson(codexAuthPath(), oldAuth);
  const source = path.join(root, 'codex-restore-target.json');
  writeJson(source, codexAuth('codex-restore-target', 'target-restore@example.test'));
  const [target] = await importCodexFromPath(source);
  const applied = await applyCodexAuthTransaction(target.id, async () => true, { processInventory: () => [] });
  assert.equal(applied.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')).tokens.account_id, 'codex-restore-target');
  const currentBytes = fs.readFileSync(codexAuthPath());
  const inspections = (afterRestoreEmail: string | null) => {
    let calls = 0;
    return async () => ({
      credentialStore: 'file',
      account: {
        type: 'chatgpt' as const,
        email: calls++ === 0 ? 'target-restore@example.test' : afterRestoreEmail,
      },
    });
  };

  const originalRename = fs.renameSync;
  let failedOnce = false;
  fs.renameSync = ((from, to) => {
    if (!failedOnce && path.resolve(String(to)) === path.resolve(codexAuthPath())) {
      failedOnce = true;
      throw new Error('simulated Codex restore replace failure');
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(
      restoreCodexLiveBackup(applied.backupDir, {
        processInventory: () => [],
        inspectEffective: inspections('old-restore@example.test'),
      }),
      /previous live authentication was restored/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readFileSync(codexAuthPath()), currentBytes);

  await assert.rejects(
    restoreCodexLiveBackup(applied.backupDir, {
      processInventory: () => [],
      inspectEffective: async () => ({ credentialStore: 'keyring' }),
    }),
    /requires cli_auth_credentials_store="file"/,
  );
  assert.deepEqual(fs.readFileSync(codexAuthPath()), currentBytes);

  await restoreCodexLiveBackup(applied.backupDir, {
    processInventory: () => [],
    // Enterprise account/read projections may omit email. The already-verified
    // file-backed auth.json/account_id remains the durable restore identity.
    inspectEffective: inspections(null),
  });
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')).tokens.account_id, oldAuth.tokens.account_id);
});

test('Codex restore pins the oldest retained generation while staging its rollback backup', async () => {
  resetRoot();
  writeJson(codexAuthPath(), codexAuth('codex-oldest-original', 'oldest-original@example.test'));
  const firstSource = path.join(root, 'codex-retention-first.json');
  const secondSource = path.join(root, 'codex-retention-second.json');
  writeJson(firstSource, codexAuth('codex-retention-first', 'retention-first@example.test'));
  writeJson(secondSource, codexAuth('codex-retention-second', 'retention-second@example.test'));
  const [first] = await importCodexFromPath(firstSource);
  const [second] = await importCodexFromPath(secondSource);

  const firstApply = await applyCodexAuthTransaction(first.id, async () => true, { processInventory: () => [] });
  assert.equal(firstApply.ok, true);
  if (!firstApply.ok) assert.fail('Initial Codex transaction unexpectedly failed.');
  const oldest = firstApply.backupDir;
  fs.utimesSync(oldest, new Date(1_000), new Date(1_000));
  for (let index = 0; index < 19; index++) {
    const selected = index % 2 === 0 ? second : first;
    const applied = await applyCodexAuthTransaction(selected.id, async () => true, { processInventory: () => [] });
    assert.equal(applied.ok, true);
  }

  await restoreCodexLiveBackup(oldest, {
    processInventory: () => [],
    inspectEffective: async () => ({
      credentialStore: 'file',
      account: { type: 'chatgpt', email: 'oldest-original@example.test' },
      requiresOpenaiAuth: false,
      rateLimits: null,
    }),
  });
  assert.equal(readCodexAuth(process.env.CODEX_HOME!)?.tokens.account_id, 'codex-oldest-original');
  assert.equal(fs.existsSync(oldest), true);
});

test('manual Codex restore rechecks processes after creating its rollback backup', async () => {
  resetRoot();
  writeJson(codexAuthPath(), codexAuth('restore-guard-old', 'old-guard@example.test'));
  const source = path.join(root, 'restore-guard-target.json');
  writeJson(source, codexAuth('restore-guard-target', 'target-guard@example.test'));
  const [target] = await importCodexFromPath(source);
  const applied = await applyCodexAuthTransaction(target.id, async () => true, { processInventory: () => [] });
  assert.equal(applied.ok, true);
  if (!applied.ok) assert.fail('Codex apply unexpectedly failed.');
  const liveBefore = fs.readFileSync(codexAuthPath());
  let scans = 0;

  await assert.rejects(
    restoreCodexLiveBackup(applied.backupDir, {
      processInventory: () => (++scans === 3
        ? [{ pid: 7331, ppid: 1, name: 'codex.exe', commandLine: 'codex', kind: 'cli' }]
        : []),
      inspectEffective: async () => ({
        credentialStore: 'file',
        account: { type: 'chatgpt', email: 'target-guard@example.test' },
      }),
    }),
    /while the rollback backup was being created.*Nothing changed/,
  );

  assert.equal(scans, 3);
  assert.deepEqual(fs.readFileSync(codexAuthPath()), liveBefore);
});

test('Codex live-auth transactions serialize with a concurrent manual restore', async () => {
  resetRoot();
  const original = codexAuth('codex-lock-original', 'original-lock@example.test');
  writeJson(codexAuthPath(), original);

  const firstSource = path.join(root, 'codex-lock-first.json');
  writeJson(firstSource, codexAuth('codex-lock-first', 'first-lock@example.test'));
  const [first] = await importCodexFromPath(firstSource);
  const firstApply = await applyCodexAuthTransaction(first.id, async () => true, { processInventory: () => [] });
  assert.equal(firstApply.ok, true);

  const secondSource = path.join(root, 'codex-lock-second.json');
  writeJson(secondSource, codexAuth('codex-lock-second', 'second-lock@example.test'));
  const [second] = await importCodexFromPath(secondSource);

  let releaseValidation!: () => void;
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  let validationStarted!: () => void;
  const enteredValidation = new Promise<void>((resolve) => { validationStarted = resolve; });
  const transaction = applyCodexAuthTransaction(second.id, async () => {
    validationStarted();
    await validationGate;
    return true;
  }, { processInventory: () => [] });
  await enteredValidation;
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')).tokens.account_id, second.accountId);

  let inspectionCalls = 0;
  let restoreCompleted = false;
  const restore = restoreCodexLiveBackup(firstApply.backupDir, {
    processInventory: () => [],
    inspectEffective: async () => ({
      credentialStore: 'file',
      account: {
        type: 'chatgpt',
        email: inspectionCalls++ === 0 ? 'second-lock@example.test' : 'original-lock@example.test',
      },
    }),
  }).then(() => { restoreCompleted = true; });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(restoreCompleted, false);
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')).tokens.account_id, second.accountId);

  releaseValidation();
  const transactionResult = await transaction;
  assert.equal(transactionResult.ok, true);
  await restore;
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')).tokens.account_id, original.tokens.account_id);
});

test('two stale-lock waiters fail closed without deleting or reacquiring the observed lock', async () => {
  resetRoot();
  const lockName = 'stale-interleaving-regression';
  const lockDir = path.join(dataDir(), 'locks', `${lockName}.lock`);
  fs.mkdirSync(lockDir, { recursive: true });
  const owner = {
    pid: 2_147_483_647,
    ownerId: 'dead-owner-generation',
    at: Date.now() - 60_000,
    name: lockName,
  };
  const ownerPath = path.join(lockDir, 'owner.json');
  writeJson(ownerPath, owner);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  const ownerBefore = fs.readFileSync(ownerPath);
  let criticalSectionEntries = 0;

  const waiter = () => withFileLock(lockName, async () => {
    criticalSectionEntries++;
  }, { staleMs: 1, timeoutMs: 100 });
  const results = await Promise.allSettled([waiter(), waiter()]);

  assert.equal(criticalSectionEntries, 0);
  assert.ok(results.every((result) => result.status === 'rejected'
    && result.reason instanceof AbandonedFileLockError));
  assert.deepEqual(fs.readFileSync(ownerPath), ownerBefore);
  assert.equal(fs.existsSync(lockDir), true);
});

test('opt-in async lock recovery reclaims a valid dead owner immediately after restart', async () => {
  resetRoot();
  const lockName = 'async-restart-recovery';
  const lockDir = path.join(dataDir(), 'locks', `${lockName}.lock`);
  writeJson(path.join(lockDir, 'owner.json'), {
    pid: 2_147_483_647,
    ownerId: 'dead-owner-before-restart',
    at: Date.now(),
    name: lockName,
  });
  let entered = false;

  await withFileLock(lockName, async () => {
    entered = true;
  }, { staleMs: 60_000, timeoutMs: 1_000, recoverAbandoned: true });

  assert.equal(entered, true);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(fs.existsSync(path.join(dataDir(), 'locks', `${lockName}.abandoned-takeover.lock`)), false);
});

test('concurrent opt-in async recoverers serialize without deleting the replacement lock', async () => {
  resetRoot();
  const lockName = 'async-restart-recovery-race';
  const lockDir = path.join(dataDir(), 'locks', `${lockName}.lock`);
  writeJson(path.join(lockDir, 'owner.json'), {
    pid: 2_147_483_647,
    ownerId: 'dead-owner-generation',
    at: Date.now() - 60_000,
    name: lockName,
  });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  let active = 0;
  let maxActive = 0;
  let entries = 0;
  const enter = () => withFileLock(lockName, async () => {
    entries++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
  }, { staleMs: 1, timeoutMs: 1_000, recoverAbandoned: true });

  await Promise.all([enter(), enter()]);

  assert.equal(entries, 2);
  assert.equal(maxActive, 1);
  assert.equal(fs.existsSync(lockDir), false);
});

test('Codex live reconciliation opts into safe restart lock recovery', async () => {
  resetRoot();
  const auth = codexAuth('codex-restart-recovery', 'restart@example.test');
  writeJson(codexAuthPath(), auth);
  const lockName = 'codex-live-auth';
  const lockDir = path.join(dataDir(), 'locks', `${lockName}.lock`);
  writeJson(path.join(lockDir, 'owner.json'), {
    pid: 2_147_483_647,
    ownerId: 'dead-codex-worker',
    at: Date.now(),
    name: lockName,
  });

  const reconciled = await reconcileLiveCodex(false, {
    inspect: async () => ({
      credentialStore: 'file',
      account: { type: 'chatgpt', email: 'restart@example.test', planType: 'pro' },
      requiresOpenaiAuth: false,
      rateLimits: null,
    }),
  });

  assert.equal(reconciled.profile?.accountId, auth.tokens.account_id);
  assert.equal(fs.existsSync(lockDir), false);
});

test('missing Codex account projection preserves the active file-backed profile and aborts refresh', async () => {
  resetRoot();
  const auth = codexAuth('codex-live-ambiguous', 'ambiguous@example.test');
  const source = path.join(root, 'ambiguous-auth.json');
  writeJson(source, auth);
  const [profile] = await importCodexFromPath(source);
  setActiveCodexProfile(profile.id);
  writeJson(codexAuthPath(), auth);

  await assert.rejects(
    reconcileLiveCodex(false, {
      inspect: async () => ({ credentialStore: 'file', account: null }),
    }),
    /official account projection is unavailable/,
  );
  assert.equal(loadCodexStore().activeProfileId, profile.id);
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')).tokens.refresh_token, auth.tokens.refresh_token);
});

test('file-backed Codex reconciliation accepts the official null-email account projection', async () => {
  resetRoot();
  const auth = codexAuth('codex-null-email', 'enterprise@example.test');
  writeJson(codexAuthPath(), auth);
  const reconciled = await reconcileLiveCodex(false, {
    inspect: async () => ({
      credentialStore: 'file',
      account: { type: 'chatgpt', email: null, planType: 'enterprise' },
      requiresOpenaiAuth: false,
      rateLimits: null,
    }),
  });
  assert.equal(reconciled.profile?.accountId, auth.tokens.account_id);
  assert.equal(reconciled.store.activeProfileId, reconciled.profile?.id);
  assert.equal(readCodexAuth(codexProfileHome(reconciled.profile!.id))?.tokens.refresh_token, auth.tokens.refresh_token);
});

test('live Codex reconciliation persists the quota-backed Pro plan over stale account metadata', async () => {
  resetRoot();
  const auth = codexAuth('codex-upgraded-plan', 'upgraded@example.test');
  writeJson(codexAuthPath(), auth);

  const reconciled = await reconcileLiveCodex(false, {
    inspect: async () => ({
      credentialStore: 'file',
      account: { type: 'chatgpt', email: 'upgraded@example.test', planType: 'plus' },
      requiresOpenaiAuth: false,
      rateLimits: {
        rateLimits: { limitId: 'codex', planType: 'prolite' },
        rateLimitsByLimitId: {},
      },
    }),
  });

  assert.equal(reconciled.profile?.planType, 'prolite');
  assert.equal(reconciled.profile?.planSource, 'codex-rate-limits');
  assert.ok((reconciled.profile?.planObservedAt ?? 0) > 0);
  assert.equal(loadCodexStore().profiles[0]?.planType, 'prolite');
});

test('raw Claude imports accept comments and trailing commas without exposing token fragments', () => {
  resetRoot();
  const creds = path.join(root, 'raw', '.credentials.json');
  const identity = path.join(root, 'raw', '.claude.json');
  writeJson(creds, { claudeAiOauth: profile('jsonc').claudeAiOauth, organizationUuid: 'jsonc-org' });
  fs.writeFileSync(identity, '{\n // retained provider comment\n "oauthAccount": { "accountUuid": "jsonc-account", "emailAddress": "jsonc@example.test" },\n "userID": "jsonc-user",\n}\n');
  const fields = fieldsFromRawFiles(creds, identity);
  assert.equal(fields?.accountUuid, 'jsonc-account');
  assert.equal(fields?.email, 'jsonc@example.test');
  assert.equal(fields?.userID, 'jsonc-user');
});

test('a server-rotated Claude token survives metadata corruption in its credential envelope', async () => {
  resetRoot();
  const account = profile('rotated-journal');
  account.claudeAiOauth!.expiresAt = Date.now() - 1;
  saveStore(profilesStore([account]));
  fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'profiles.json'), '{broken', 'utf8');
  fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'profiles.json.bak'), '{broken', 'utf8');
  fs.rmSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'backups', 'profiles'), { recursive: true, force: true });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/v1/oauth/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'rotated-access-r2',
          refresh_token: 'rotated-refresh-r2',
          expires_in: 3600,
          scope: 'user:inference',
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ five_hour: null, seven_day: null }) } as Response;
  }) as typeof fetch;
  try {
    const usage = await fetchUsage(account, 'test', { force: true });
    assert.equal(usage.status, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const envelope = JSON.parse(fs.readFileSync(claudeProfileCredentialsPath(account.id), 'utf8')) as {
    claudeAiOauth: { refreshToken: string };
  };
  assert.equal(envelope.claudeAiOauth.refreshToken, 'rotated-refresh-r2');
});

test('a switch-time token check joins an in-flight hover rotation before cooldown', async () => {
  resetRoot();
  const active = profile('single-flight-active');
  const account = profile('single-flight-switch');
  account.claudeAiOauth!.expiresAt = Date.now() - 1;
  saveStore(profilesStore([active, account]));
  assert.equal(applyProfile(active, { processInventory: () => [] }).ok, true);
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/v1/oauth/token')) {
      tokenCalls++;
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'joined-access', refresh_token: 'joined-refresh', expires_in: 3600 }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ five_hour: null, seven_day: null }) } as Response;
  }) as typeof fetch;
  try {
    const hover = fetchUsage(account, 'test', { force: true });
    await new Promise((resolve) => setImmediate(resolve));
    const switching = withFileLock('claude-provider-switch', () =>
      ensureFreshToken(account, undefined, { providerLockHeld: true }));
    assert.equal(tokenCalls, 1);
    release();
    const [, fresh] = await Promise.all([hover, switching]);
    assert.equal(fresh, true);
    assert.equal(tokenCalls, 1);
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
});

test('a parked Claude refresh queued behind a switch never rotates the newly active account', async () => {
  resetRoot();
  const active = profile('refresh-race-active');
  const parked = profile('refresh-race-target');
  parked.claudeAiOauth!.expiresAt = Date.now() - 1;
  saveStore(profilesStore([active, parked]));
  assert.equal(applyProfile(active, { processInventory: () => [] }).ok, true);

  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/v1/oauth/token')) tokenCalls++;
    throw new Error('the newly active Claude credential must never be rotated by a parked refresh');
  }) as typeof fetch;

  let providerHeld!: () => void;
  let allowSwitch!: () => void;
  let switched!: () => void;
  let releaseSwitch!: () => void;
  const held = new Promise<void>((resolve) => { providerHeld = resolve; });
  const proceed = new Promise<void>((resolve) => { allowSwitch = resolve; });
  const targetIsLive = new Promise<void>((resolve) => { switched = resolve; });
  const release = new Promise<void>((resolve) => { releaseSwitch = resolve; });

  try {
    const switchTransaction = withFileLock('claude-provider-switch', async () => {
      providerHeld();
      await proceed;
      assert.equal(applyProfile(parked, { processInventory: () => [] }).ok, true);
      mutateStore((store) => {
        store.activeProfileId = parked.id;
      });
      switched();
      await release;
    });

    await held;
    // This object was captured while the profile was still parked. Its refresh waits for
    // the switch transaction, then must re-read both live identity and active metadata.
    const staleBackgroundRefresh = ensureFreshToken(parked);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tokenCalls, 0);

    allowSwitch();
    await targetIsLive;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tokenCalls, 0);

    releaseSwitch();
    await switchTransaction;
    assert.equal(await staleBackgroundRefresh, false);
    assert.equal(tokenCalls, 0);
    assert.equal(loadStore().activeProfileId, parked.id);
  } finally {
    allowSwitch();
    releaseSwitch();
    globalThis.fetch = originalFetch;
  }
});

test('invalid Codex import cannot overwrite an existing valid auth home', async () => {
  resetRoot();
  const validFile = path.join(root, 'valid-auth.json');
  writeJson(validFile, codexAuth('codex-safe', 'safe@example.test'));
  const [saved] = await importCodexFromPath(validFile);
  const savedPath = codexAuthPath(codexProfileHome(saved.id));
  const before = fs.readFileSync(savedPath);

  const invalidFile = path.join(root, 'invalid-auth.json');
  writeJson(invalidFile, { auth_mode: 'chatgpt', tokens: { account_id: 'codex-safe' } });
  await assert.rejects(importCodexFromPath(invalidFile), /missing a non-empty tokens\.id_token/);
  assert.deepEqual(fs.readFileSync(savedPath), before);
});

test('a stale Codex import cannot overwrite a rotation completed while it waited', async () => {
  resetRoot();
  const accountId = 'codex-import-rotation';
  const staleFile = path.join(root, 'stale-codex-auth.json');
  const staleAuth = codexAuth(accountId, 'rotation@example.test');
  writeJson(staleFile, staleAuth);
  const [saved] = await importCodexFromPath(staleFile);

  const rotatedAuth: CodexAuthFile = {
    ...staleAuth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...staleAuth.tokens,
      access_token: jwt({ generation: 'r2', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
      refresh_token: 'refresh-codex-import-rotation-r2',
    },
  };
  let entered!: () => void;
  const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rotation = withFileLock(codexCredentialLockName(accountId), async () => {
    writeCodexProfileAuth(saved.id, rotatedAuth);
    entered();
    await gate;
  });
  await lockEntered;

  const staleImport = importCodexFromPath(staleFile);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await rotation;
  await assert.rejects(staleImport, /Refusing to replace an existing Codex login/);
  const persisted = JSON.parse(fs.readFileSync(codexAuthPath(codexProfileHome(saved.id)), 'utf8')) as CodexAuthFile;
  assert.equal(persisted.tokens.refresh_token, rotatedAuth.tokens.refresh_token);
});

test('Codex archive re-proves inactivity after a concurrent live transaction', async () => {
  resetRoot();
  const source = path.join(root, 'archive-race-auth.json');
  writeJson(source, codexAuth('codex-archive-race', 'archive-race@example.test'));
  const [saved] = await importCodexFromPath(source);

  let entered!: () => void;
  const liveLockHeld = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const becomingLive = withFileLock('codex-live-auth', async () => {
    entered();
    await gate;
    setActiveCodexProfile(saved.id);
  });
  await liveLockHeld;
  const archiving = archiveCodexProfile(saved.id, {
    inspect: async () => ({ credentialStore: 'file', account: null }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await becomingLive;

  await assert.rejects(archiving, /active Codex account/);
  const store = loadCodexStore();
  assert.equal(store.activeProfileId, saved.id);
  assert.ok(store.profiles.some((profile) => profile.id === saved.id));
});

test('Codex restore rejects a JSON-valid backup whose credential bytes changed', async () => {
  resetRoot();
  const original = codexAuth('codex-backup-original', 'original-backup@example.test');
  writeJson(codexAuthPath(), original);
  const source = path.join(root, 'codex-backup-target.json');
  writeJson(source, codexAuth('codex-backup-target', 'target-backup@example.test'));
  const [target] = await importCodexFromPath(source);
  const applied = await applyCodexAuthTransaction(target.id, async () => true, { processInventory: () => [] });
  assert.equal(applied.ok, true);
  if (!applied.ok) assert.fail('Codex apply unexpectedly failed.');

  const backupPath = codexAuthPath(applied.backupDir);
  const tampered = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as CodexAuthFile;
  tampered.tokens.refresh_token = 'json-valid-but-not-original';
  writeJson(backupPath, tampered);

  await assert.rejects(
    restoreCodexLiveBackup(applied.backupDir, {
      processInventory: () => [],
      inspectEffective: async () => ({
        credentialStore: 'file',
        account: { type: 'chatgpt', email: 'target-backup@example.test' },
        requiresOpenaiAuth: false,
        rateLimits: null,
      }),
    }),
    /not a complete, reusable Codex live-auth backup/,
  );
  assert.equal(readCodexAuth(process.env.CODEX_HOME!)?.tokens.account_id, target.accountId);
});

test('transaction protection preserves recovery evidence even without a manual marker', () => {
  resetRoot();
  const backupRoot = path.join(backupsDir(), 'retention-protection-test');
  for (let index = 0; index < 4; index++) {
    const dir = path.join(backupRoot, `generation-${index}`);
    writeJson(path.join(dir, 'transaction.json'), { complete: true, createdAt: index });
    fs.utimesSync(dir, new Date(1_000 + index * 1_000), new Date(1_000 + index * 1_000));
  }
  const critical = path.join(backupRoot, 'generation-0');
  protectBackupFromRetention(critical, 'rollback unresolved; manual marker write may fail');
  pruneManagedBackupDirs(backupRoot, 1);

  assert.equal(fs.existsSync(critical), true);
  const remaining = fs.readdirSync(backupRoot).filter((entry) => fs.statSync(path.join(backupRoot, entry)).isDirectory());
  assert.deepEqual(remaining.sort(), ['generation-0', 'generation-3']);
});

test('Codex actually recovers metadata from its newest structural snapshot', async () => {
  resetRoot();
  const authFile = path.join(root, 'snapshot-auth.json');
  writeJson(authFile, codexAuth('codex-snapshot', 'snapshot@example.test'));
  const [saved] = await importCodexFromPath(authFile);
  renameCodexProfile(saved.id, 'renamed-to-create-structural-snapshot');
  fs.writeFileSync(codexProfilesPath(), '{broken-main', 'utf8');
  fs.writeFileSync(`${codexProfilesPath()}.bak`, '{broken-sidecar', 'utf8');

  const recovered = loadCodexStore();
  assert.equal(recovered.profiles.length, 1);
  assert.equal(recovered.profiles[0].accountId, 'codex-snapshot');
  assert.ok(fs.readdirSync(path.dirname(codexProfilesPath())).some((file) => file.startsWith('codex-profiles.json.corrupt-')));
});

test('portable Claude import cannot resurrect an archived identity or replace its durable envelope', () => {
  resetRoot();
  const active = profile('archive-import-active');
  const archived = profile('archive-import-target');
  saveStore(profilesStore([active, archived]));
  archiveClaudeProfile(archived.id);

  const markerPath = path.join(path.dirname(claudeProfileCredentialsPath(archived.id)), '.archived.json');
  const envelopePath = claudeProfileCredentialsPath(archived.id);
  const markerBefore = fs.readFileSync(markerPath);
  const envelopeBefore = fs.readFileSync(envelopePath);
  const forged = {
    email: archived.email,
    accountUuid: archived.accountUuid!,
    organizationUuid: archived.organizationUuid!,
    organizationUuidRoot: archived.organizationUuidRoot,
    organizationType: archived.organizationType,
    subscriptionType: archived.subscriptionType,
    claudeAiOauth: {
      ...archived.claudeAiOauth!,
      accessToken: 'forged-archived-access',
      refreshToken: 'forged-archived-refresh',
    },
    oauthAccount: archived.oauthAccount!,
    userID: archived.userID,
  };

  assert.throws(
    () => mutateStore((fresh) => { addOrUpdateProfile(fresh, forged); }),
    /voluntarily archived/,
  );
  const reloaded = loadStore();
  assert.equal(reloaded.profiles.some((candidate) => candidate.id === archived.id), false);
  assert.equal(reloaded.tombstones?.find((candidate) => candidate.id === archived.id)?.restoredAt, undefined);
  assert.deepEqual(fs.readFileSync(markerPath), markerBefore);
  assert.deepEqual(fs.readFileSync(envelopePath), envelopeBefore);
});

test('a typed Desktop email never auto-links or replaces an existing Claude Code profile', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const cli = profile('desktop-email-owner');
    saveStore(profilesStore([cli]));
    writeJson(path.join(process.env.APPDATA, 'Claude', 'config.json'), { account: 'opaque-desktop-session' });
    let captured: Profile | undefined;
    const next = mutateStore((fresh) => {
      captured = captureDesktopAccount(fresh, 'Desktop capture', cli.email, { assertClaudeClosed: () => {} });
    });
    assert.ok(captured);
    assert.notEqual(captured.id, cli.id);
    assert.equal(next.profiles.length, 2);
    assert.equal(next.profiles.find((candidate) => candidate.id === cli.id)?.desktopSnapshotDir, undefined);
    assert.ok(next.profiles.find((candidate) => candidate.id === captured?.id)?.desktopSnapshotDir);
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('Claude portable export reports Desktop-only sessions instead of claiming a full backup', async () => {
  resetRoot();
  const cli = profile('portable-export-cli');
  const desktopOnly: Profile = {
    id: 'portable-export-desktop',
    provider: 'claude',
    label: 'Machine-bound Desktop',
    email: 'desktop@example.test',
    desktopSnapshotDir: path.join(root, 'desktop-bundle'),
    desktopCapturedAt: Date.now(),
    createdAt: Date.now(),
  };
  saveStore(profilesStore([cli, desktopOnly]));
  const result = await exportAllProfiles(profilesStore([cli, desktopOnly]), { processInventory: () => [] });
  const payload = JSON.parse(fs.readFileSync(result.file, 'utf8')) as { accounts: unknown[] };
  assert.equal(result.exportedCount, 1);
  assert.deepEqual(result.skippedDesktopOnly, [{ id: desktopOnly.id, label: desktopOnly.label }]);
  assert.equal(payload.accounts.length, 1);
});

test('Claude export waits for a paused rotation and serializes the durable new refresh token', async () => {
  resetRoot();
  const staleCaller = profile('claude-export-rotation');
  const initialRefreshToken = staleCaller.claudeAiOauth!.refreshToken;
  const initial = profilesStore([staleCaller]);
  initial.activeProfileId = null;
  saveStore(initial);

  let entered!: () => void;
  const rotationCommitted = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const holdRotation = new Promise<void>((resolve) => { release = resolve; });
  const rotatedRefreshToken = 'refresh-claude-export-rotation-r2';
  const rotation = withFileLock('claude-provider-switch', async () => {
    const rotated = {
      ...loadStore().profiles.find((candidate) => candidate.id === staleCaller.id)!,
      claudeAiOauth: {
        ...staleCaller.claudeAiOauth!,
        accessToken: 'access-claude-export-rotation-r2',
        refreshToken: rotatedRefreshToken,
        expiresAt: Date.now() + 3_600_000,
      },
    };
    persistProfileCredentials(rotated, { expectedPreviousRefreshToken: initialRefreshToken });
    mutateStore((store) => {
      const target = store.profiles.find((candidate) => candidate.id === staleCaller.id);
      if (!target) throw new Error('Claude rotation target disappeared.');
      target.claudeAiOauth = rotated.claudeAiOauth;
    });
    entered();
    await holdRotation;
  });
  await rotationCommitted;

  const exporting = exportProfile(staleCaller, { processInventory: () => [] });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await rotation;
  const file = await exporting;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    claudeAiOauth: { refreshToken: string };
  };
  assert.equal(payload.claudeAiOauth.refreshToken, rotatedRefreshToken);
  assert.equal(staleCaller.claudeAiOauth!.refreshToken, initialRefreshToken);
});

test('Codex export-all waits for a paused account rotation and serializes the new refresh token', async () => {
  resetRoot();
  const accountId = 'codex-export-rotation';
  const source = path.join(root, 'codex-export-rotation.json');
  const initialAuth = codexAuth(accountId, 'codex-export@example.test');
  writeJson(source, initialAuth);
  const [saved] = await importCodexFromPath(source);
  const staleCallerStore = loadCodexStore();
  const rotatedRefreshToken = 'refresh-codex-export-rotation-r2';
  const rotatedAuth: CodexAuthFile = {
    ...initialAuth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...initialAuth.tokens,
      access_token: jwt({ generation: 'r2', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
      refresh_token: rotatedRefreshToken,
    },
  };

  let entered!: () => void;
  const rotationCommitted = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const holdRotation = new Promise<void>((resolve) => { release = resolve; });
  const rotation = withFileLock(codexCredentialLockName(accountId), async () => {
    writeCodexProfileAuth(saved.id, rotatedAuth);
    entered();
    await holdRotation;
  });
  await rotationCommitted;

  const exporting = exportAllCodexProfiles(staleCallerStore, {
    processInventory: () => [],
    inspect: async () => ({ credentialStore: 'file', account: null }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await rotation;
  const file = await exporting;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    accounts: Array<{ auth: CodexAuthFile }>;
  };
  assert.equal(payload.accounts.length, 1);
  assert.equal(payload.accounts[0]?.auth.tokens.refresh_token, rotatedRefreshToken);
  assert.equal(readCodexAuth(codexProfileHome(saved.id))?.tokens.refresh_token, rotatedRefreshToken);
});

test('Desktop session replacement preserves unrelated user data', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const live = path.join(process.env.APPDATA, 'Claude');
    writeJson(path.join(live, 'config.json'), { account: 'one' });
    writeJson(path.join(live, 'unrelated-settings.json'), { keep: true });
    const snapshot = snapshotLiveDesktopInto('desktop-one', desktopTestOptions);
    writeJson(path.join(live, 'config.json'), { account: 'two' });
    writeJson(path.join(live, 'unrelated-settings.json'), { keep: 'still-here' });

    assert.equal(applyDesktopSnapshot(snapshot, desktopTestOptions).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'config.json'), 'utf8')), { account: 'one' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'unrelated-settings.json'), 'utf8')), { keep: 'still-here' });
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('a tampered or partial Desktop snapshot fails before any live mutation', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const live = path.join(process.env.APPDATA, 'Claude');
    writeJson(path.join(live, 'config.json'), { account: 'captured' });
    const snapshot = snapshotLiveDesktopInto('desktop-tamper', desktopTestOptions);
    const manifestFile = path.join(snapshot, '.bundle.json');
    const originalManifest = fs.readFileSync(manifestFile, 'utf8');
    const manifest = JSON.parse(originalManifest) as {
      version: number;
      scopeVersion: number;
      entries: string[];
      absentEntries: string[];
      fingerprints: Record<string, unknown>;
    };
    assert.equal(manifest.version, 2);
    assert.equal(manifest.scopeVersion, 1);
    assert.deepEqual(manifest.entries, ['config.json']);
    assert.ok(manifest.fingerprints['config.json']);

    writeJson(path.join(live, 'config.json'), { account: 'must-survive' });
    writeJson(path.join(live, 'Local State'), { encryption: 'must-survive' });
    writeJson(path.join(snapshot, 'config.json'), { account: 'tampered' });
    const beforeConfig = fs.readFileSync(path.join(live, 'config.json'));
    const beforeLocalState = fs.readFileSync(path.join(live, 'Local State'));

    const altered = applyDesktopSnapshot(snapshot, desktopTestOptions);
    assert.equal(altered.ok, false);
    assert.equal(altered.rollback, 'not-needed');
    assert.match(altered.error ?? '', /integrity check failed/i);
    assert.deepEqual(fs.readFileSync(path.join(live, 'config.json')), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(live, 'Local State')), beforeLocalState);

    // The complete scope/absence declaration is itself checksummed. An omission cannot
    // be turned into a destructive instruction by editing the manifest.
    writeJson(path.join(snapshot, 'config.json'), { account: 'captured' });
    writeJson(manifestFile, { ...manifest, absentEntries: manifest.absentEntries.filter((entry) => entry !== 'Local State') });
    const alteredAbsence = applyDesktopSnapshot(snapshot, desktopTestOptions);
    assert.equal(alteredAbsence.ok, false);
    assert.equal(alteredAbsence.rollback, 'not-needed');
    assert.match(alteredAbsence.error ?? '', /manifest content integrity/i);
    assert.deepEqual(fs.readFileSync(path.join(live, 'Local State')), beforeLocalState);

    // Restoring the manifest and then removing a declared-present entry is rejected too.
    fs.writeFileSync(manifestFile, originalManifest, 'utf8');
    fs.rmSync(path.join(snapshot, 'config.json'));
    const partial = applyDesktopSnapshot(snapshot, desktopTestOptions);
    assert.equal(partial.ok, false);
    assert.equal(partial.rollback, 'not-needed');
    assert.match(partial.error ?? '', /declared by the manifest is absent/i);
    assert.deepEqual(fs.readFileSync(path.join(live, 'config.json')), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(live, 'Local State')), beforeLocalState);
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('Desktop apply removes only explicitly attested target absences and cannot create a hybrid session', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const live = path.join(process.env.APPDATA, 'Claude');
    writeJson(path.join(live, 'config.json'), { account: 'captured' });
    const snapshot = snapshotLiveDesktopInto('desktop-sparse', desktopTestOptions);

    writeJson(path.join(live, 'config.json'), { account: 'current' });
    writeJson(path.join(live, 'Local State'), { encryption: 'newer-live-state' });
    writeJson(path.join(live, 'Network', 'Cookies-journal'), { cookie: 'outgoing' });
    writeJson(path.join(live, 'Session Storage', 'state.json'), { session: 'outgoing' });
    writeJson(path.join(live, 'IndexedDB', 'db', 'state.json'), { indexed: 'outgoing' });
    writeJson(path.join(live, 'unrelated-settings.json'), { keep: true });
    const applied = applyDesktopSnapshot(snapshot, desktopTestOptions);
    assert.equal(applied.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'config.json'), 'utf8')), { account: 'captured' });
    for (const entry of ['Local State', path.join('Network', 'Cookies-journal'), 'Session Storage', 'IndexedDB']) {
      assert.equal(fs.existsSync(path.join(live, entry)), false, `${entry} must not leak from the outgoing account`);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'unrelated-settings.json'), 'utf8')), { keep: true });
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('Desktop process rechecks abort apply and recapture immediately before their first rename', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const live = path.join(process.env.APPDATA, 'Claude');
    writeJson(path.join(live, 'config.json'), { account: 'captured-target' });
    const snapshot = snapshotLiveDesktopInto('desktop-process-race', desktopTestOptions);
    writeJson(path.join(live, 'config.json'), { account: 'outgoing-must-survive' });

    let applyChecks = 0;
    const blockedApply = applyDesktopSnapshot(snapshot, {
      assertClaudeClosed: () => {
        applyChecks++;
        if (applyChecks === 2) throw new Error('simulated Desktop restart after staging');
      },
    });
    assert.equal(applyChecks, 2);
    assert.equal(blockedApply.ok, false);
    assert.equal(blockedApply.rollback, 'not-needed');
    assert.match(blockedApply.error ?? '', /simulated Desktop restart/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'config.json'), 'utf8')), { account: 'outgoing-must-survive' });

    let captureChecks = 0;
    assert.throws(
      () => snapshotLiveDesktopInto('desktop-process-race', {
        assertClaudeClosed: () => {
          captureChecks++;
          if (captureChecks === 2) throw new Error('simulated Desktop restart before publish');
        },
      }),
      /simulated Desktop restart before publish/,
    );
    assert.equal(captureChecks, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, 'config.json'), 'utf8')), { account: 'captured-target' });

    // Even when the final process inventory is green, a live entry that appeared
    // during the long copy invalidates the candidate's explicit absence proof.
    assert.throws(
      () => snapshotLiveDesktopInto('desktop-process-race', {
        assertClaudeClosed: () => {},
        afterCandidateCopiedForTest: () => {
          writeJson(path.join(live, 'Local State'), { appeared: 'during-copy' });
        },
      }),
      /live entry appeared while the profile snapshot was captured/i,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, 'config.json'), 'utf8')), { account: 'captured-target' });
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('an interrupted Desktop live transaction is restored from its durable journal', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const live = path.join(process.env.APPDATA, 'Claude');
    writeJson(path.join(live, 'config.json'), { account: 'target' });
    const snapshot = snapshotLiveDesktopInto('desktop-recovery', desktopTestOptions);
    writeJson(path.join(live, 'config.json'), { account: 'outgoing-before-swap' });
    writeJson(path.join(live, 'Session Storage', 'state.json'), { session: 'outgoing-before-swap' });
    writeJson(path.join(live, 'IndexedDB', 'db.json'), { indexed: 'outgoing-before-swap' });

    const applied = applyDesktopSnapshot(snapshot, desktopTestOptions);
    assert.equal(applied.ok, true);
    assert.ok(applied.transactionDir);
    assert.ok(applied.backupDir);
    assert.equal(fs.existsSync(path.join(live, 'Session Storage')), false);
    assert.equal(fs.existsSync(path.join(live, 'IndexedDB')), false);
    writeJson(path.join(live, 'config.json'), { account: 'partial-after-crash' });

    const journalPath = path.join(applied.transactionDir!, 'transaction.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    journal.state = 'applying';
    journal.complete = false;
    journal.updatedAt = Date.now();
    writeJson(journalPath, journal);

    assert.equal(inspectDesktopRecovery().livePending, 1);
    const recovered = recoverDesktopTransactions(desktopTestOptions);
    assert.equal(recovered.recoveredLive, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'config.json'), 'utf8')), { account: 'outgoing-before-swap' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'Session Storage', 'state.json'), 'utf8')), { session: 'outgoing-before-swap' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, 'IndexedDB', 'db.json'), 'utf8')), { indexed: 'outgoing-before-swap' });
    const completed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { state: string; complete: boolean };
    assert.equal(completed.state, 'rolled-back');
    assert.equal(completed.complete, true);
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('an interrupted Desktop recapture atomically restores the previous profile bundle', { skip: process.platform !== 'win32' }, () => {
  resetRoot();
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    const live = path.join(process.env.APPDATA, 'Claude');
    writeJson(path.join(live, 'config.json'), { account: 'first-capture' });
    const destination = snapshotLiveDesktopInto('desktop-recapture', desktopTestOptions);
    writeJson(path.join(live, 'config.json'), { account: 'second-capture' });
    snapshotLiveDesktopInto('desktop-recapture', desktopTestOptions);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'config.json'), 'utf8')), { account: 'second-capture' });

    const transactionsRoot = path.join(process.env.CLAUDE_SWITCH_HOME!, 'backups', 'desktop-transactions');
    const interruptedDir = fs.readdirSync(transactionsRoot)
      .map((name) => path.join(transactionsRoot, name))
      .find((dir) => {
        if (!fs.existsSync(path.join(dir, 'previous', 'config.json'))) return false;
        const value = JSON.parse(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8')) as { kind?: string; profileId?: string };
        return value.kind === 'claude-codex-account-switch/claude-desktop-capture-transaction'
          && value.profileId === 'desktop-recapture';
      });
    assert.ok(interruptedDir);
    const journalPath = path.join(interruptedDir, 'transaction.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    journal.state = 'publishing';
    journal.complete = false;
    journal.updatedAt = Date.now();
    writeJson(journalPath, journal);

    assert.equal(inspectDesktopRecovery().capturePending, 1);
    const recovered = recoverDesktopTransactions(desktopTestOptions);
    assert.equal(recovered.recoveredCaptures, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'config.json'), 'utf8')), { account: 'first-capture' });
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  }
});

test('backup retention deletes only durably completed generations', () => {
  resetRoot();
  const retentionRoot = path.join(root, 'retention');
  const oldComplete = path.join(retentionRoot, 'old-complete');
  const newComplete = path.join(retentionRoot, 'new-complete');
  const interrupted = path.join(retentionRoot, 'interrupted');
  writeJson(path.join(oldComplete, 'transaction.json'), { complete: true });
  writeJson(path.join(newComplete, 'transaction.json'), { complete: true });
  writeJson(path.join(interrupted, 'transaction.json'), { complete: false });
  fs.utimesSync(oldComplete, new Date(1_000), new Date(1_000));
  fs.utimesSync(newComplete, new Date(3_000), new Date(3_000));
  fs.utimesSync(interrupted, new Date(500), new Date(500));

  pruneManagedBackupDirs(retentionRoot, 1);
  assert.equal(fs.existsSync(oldComplete), false);
  assert.equal(fs.existsSync(newComplete), true);
  assert.equal(fs.existsSync(interrupted), true);
});
