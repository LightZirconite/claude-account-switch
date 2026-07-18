import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  archiveCodexProfile,
  importCodexFromPath,
  loadCodexStore,
  readCodexAuth,
  refreshAllCodexProfiles,
  renameCodexProfile,
  setActiveCodexProfile,
} from '../src/codexProfiles';
import { applyCodexAuthTransaction } from '../src/codexSwitch';
import { CodexAppServerShutdownError } from '../src/codexAppServer';
import {
  backupsDir,
  codexAuthPath,
  codexProfileHome,
  codexProfilesPath,
} from '../src/paths';
import type { CodexAuthFile } from '../src/types';

let root = '';

function resetRoot(): void {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-critical-test-'));
  process.env.CLAUDE_SWITCH_HOME = path.join(root, 'switch');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'live-claude');
  process.env.CODEX_HOME = path.join(root, 'live-codex');
  delete process.env.CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT;
  delete process.env.CLAUDE_SWITCH_CODEX_RESULT_DEADLINE_AT;
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codexAuth(
  accountId: string,
  email: string,
  issuedAt = 100,
  generation = 'one',
  claimedAccountId = accountId,
): CodexAuthFile {
  const authClaims = {
    chatgpt_account_id: claimedAccountId,
    chatgpt_plan_type: 'pro',
  };
  return {
    auth_mode: 'chatgpt',
    last_refresh: new Date(issuedAt * 1000).toISOString(),
    tokens: {
      account_id: accountId,
      id_token: jwt({ email, iat: issuedAt, 'https://api.openai.com/auth': authClaims }),
      access_token: jwt({ iat: issuedAt, 'https://api.openai.com/auth': authClaims }),
      refresh_token: `refresh-${accountId}-${generation}`,
    },
  };
}

async function importAuth(auth: CodexAuthFile, name = 'auth.json') {
  const file = path.join(root, name);
  writeJson(file, auth);
  return (await importCodexFromPath(file))[0];
}

test.afterEach(() => {
  delete process.env.CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT;
  delete process.env.CLAUDE_SWITCH_CODEX_RESULT_DEADLINE_AT;
  delete process.env.CODEX_BIN;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

test('archive markers suppress stale rows loaded from main, sidecar, and snapshot stores', async () => {
  for (const source of ['main', 'sidecar', 'snapshot'] as const) {
    resetRoot();
    const profile = await importAuth(codexAuth(`archived-${source}`, `${source}@example.test`));
    const staleStore = fs.readFileSync(codexProfilesPath(), 'utf8');
    writeJson(path.join(codexProfileHome(profile.id), '.archived.json'), {
      kind: 'claude-codex-account-switch/codex-profile-archive',
      version: 1,
      profileId: profile.id,
      accountId: profile.accountId,
      archivedAt: Date.now(),
    });

    if (source === 'sidecar') {
      fs.writeFileSync(codexProfilesPath(), '{broken-main', 'utf8');
      fs.writeFileSync(`${codexProfilesPath()}.bak`, staleStore, 'utf8');
    } else if (source === 'snapshot') {
      fs.writeFileSync(codexProfilesPath(), '{broken-main', 'utf8');
      fs.writeFileSync(`${codexProfilesPath()}.bak`, '{broken-sidecar', 'utf8');
      const snapshot = path.join(backupsDir(), 'codex-profiles', 'profiles-z-test.json');
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      fs.writeFileSync(snapshot, staleStore, 'utf8');
    }

    const loaded = loadCodexStore();
    assert.equal(loaded.profiles.some((candidate) => candidate.id === profile.id), false, source);
    assert.ok(loaded.tombstones.some((tombstone) => tombstone.id === profile.id), source);
  }
});

test('archive marker survives a sidecar failure after the primary deletion commit', async () => {
  resetRoot();
  const profile = await importAuth(codexAuth('archive-primary', 'archive@example.test'));
  const marker = path.join(codexProfileHome(profile.id), '.archived.json');
  const originalRename = fs.renameSync;
  fs.renameSync = ((source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(`${codexProfilesPath()}.bak`)) {
      throw new Error('simulated sidecar commit failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(archiveCodexProfile(profile.id, {
      inspect: async () => ({ credentialStore: 'file', account: null }),
    }), /simulated sidecar commit failure/);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(fs.existsSync(marker), true);
  fs.writeFileSync(codexProfilesPath(), '{broken-primary-after-commit', 'utf8');
  assert.equal(loadCodexStore().profiles.some((candidate) => candidate.id === profile.id), false);
});

test('Codex imports reject JWT account mismatches and credential downgrades without overwriting auth', async () => {
  resetRoot();
  const profile = await importAuth(codexAuth('safe-account', 'safe@example.test', 300, 'current'));
  const canonical = codexAuthPath(codexProfileHome(profile.id));
  const before = fs.readFileSync(canonical);

  const mismatch = path.join(root, 'mismatch.json');
  writeJson(mismatch, codexAuth('safe-account', 'safe@example.test', 400, 'mismatch', 'different-account'));
  await assert.rejects(importCodexFromPath(mismatch), /do not match tokens\.account_id/);
  assert.deepEqual(fs.readFileSync(canonical), before);

  const oldBackup = path.join(root, 'old-backup.json');
  writeJson(oldBackup, codexAuth('safe-account', 'safe@example.test', 200, 'old'));
  await assert.rejects(importCodexFromPath(oldBackup), /Refusing to replace an existing Codex login/);
  assert.deepEqual(fs.readFileSync(canonical), before);
});

test('applyCodexAuthTransaction reports a rollback failure and retains recovery evidence', async () => {
  resetRoot();
  writeJson(codexAuthPath(), codexAuth('live-old', 'old@example.test', 100, 'old'));
  const profile = await importAuth(codexAuth('live-target', 'target@example.test', 200, 'target'));
  const livePath = path.resolve(codexAuthPath());
  const originalRename = fs.renameSync;
  let liveReplacements = 0;
  fs.renameSync = ((source, destination) => {
    if (path.resolve(String(destination)) === livePath && ++liveReplacements === 2) {
      throw new Error('simulated rollback replacement failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;

  let result: Awaited<ReturnType<typeof applyCodexAuthTransaction>>;
  try {
    result = await applyCodexAuthTransaction(profile.id, async () => {
      throw new Error('simulated validation failure');
    }, { processInventory: () => [] });
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(result.ok, false);
  if (result.ok) assert.fail('transaction unexpectedly succeeded');
  assert.equal(result.rollbackSucceeded, false);
  assert.match(result.rollbackError?.message ?? '', /simulated rollback replacement failure/);
  assert.equal(readCodexAuth(process.env.CODEX_HOME!)?.tokens.account_id, 'live-target');
  assert.equal(readCodexAuth(result.backupDir)?.tokens.account_id, 'live-old');
});

test('Codex apply rechecks processes after backup and does not rewrite unchanged live auth', async () => {
  resetRoot();
  writeJson(codexAuthPath(), codexAuth('guard-old', 'old@example.test', 100, 'old'));
  const liveBefore = fs.readFileSync(codexAuthPath());
  const profile = await importAuth(codexAuth('guard-target', 'target@example.test', 200, 'target'));
  let validationCalls = 0;

  const result = await applyCodexAuthTransaction(profile.id, async () => {
    validationCalls++;
    return true;
  }, {
    processInventory: () => [{ pid: 4242, ppid: 1, name: 'codex.exe', commandLine: 'codex', kind: 'cli' }],
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail('transaction unexpectedly succeeded');
  assert.equal(result.rollbackSucceeded, true);
  assert.equal(validationCalls, 0);
  assert.deepEqual(fs.readFileSync(codexAuthPath()), liveBefore);
  assert.match(result.error.message, /while the rollback backup was being created/);
});

test('Codex apply never rolls back under a validation helper whose exit is unproven', async () => {
  resetRoot();
  writeJson(codexAuthPath(), codexAuth('shutdown-old', 'old@example.test', 100, 'old'));
  const profile = await importAuth(codexAuth('shutdown-target', 'target@example.test', 200, 'target'));

  const result = await applyCodexAuthTransaction(profile.id, async () => {
    throw new CodexAppServerShutdownError(process.pid);
  }, { processInventory: () => [] });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail('transaction unexpectedly succeeded');
  assert.equal(result.rollbackSucceeded, false);
  assert.match(result.rollbackError?.message ?? '', /deliberately deferred/);
  assert.equal(readCodexAuth(process.env.CODEX_HOME!)?.tokens.account_id, 'shutdown-target');
  assert.equal(readCodexAuth(result.backupDir)?.tokens.account_id, 'shutdown-old');
});

test('expired worker mutation deadline blocks Codex metadata writes', async () => {
  resetRoot();
  const profile = await importAuth(codexAuth('deadline-account', 'deadline@example.test'));
  const before = fs.readFileSync(codexProfilesPath());
  process.env.CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT = String(Date.now() - 1);
  assert.throws(() => renameCodexProfile(profile.id, 'must-not-commit'), /deadline elapsed/);
  assert.deepEqual(fs.readFileSync(codexProfilesPath()), before);
});

test('refresh-all fails closed when live reconciliation cannot commit', async () => {
  resetRoot();
  const active = await importAuth(codexAuth('refresh-active', 'active@example.test', 200, 'active'), 'active.json');
  const parked = await importAuth(codexAuth('refresh-parked', 'parked@example.test', 200, 'parked'), 'parked.json');
  setActiveCodexProfile(active.id);
  writeJson(codexAuthPath(), codexAuth('refresh-active', 'active@example.test', 300, 'live'));
  const parkedPath = codexAuthPath(codexProfileHome(parked.id));
  const parkedBefore = fs.readFileSync(parkedPath);
  const liveBefore = fs.readFileSync(codexAuthPath());
  const originalRename = fs.renameSync;
  process.env.CODEX_BIN = path.join(root, 'missing-codex-binary.exe');
  fs.renameSync = ((source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(codexProfilesPath())) {
      throw new Error('simulated live reconciliation metadata failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(refreshAllCodexProfiles(), /refresh aborted before parked credentials were touched/);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepEqual(fs.readFileSync(parkedPath), parkedBefore);
  assert.deepEqual(fs.readFileSync(codexAuthPath()), liveBefore);
});
