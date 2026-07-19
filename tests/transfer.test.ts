import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { pathToFileURL } from 'node:url';

import { importCodexFromPath, loadCodexStore } from '../src/codexProfiles';
import { ensureDataDirs, providerImportDir } from '../src/paths';
import {
  addOrUpdateProfile,
  groupClaudeImportCandidates,
  importFromPath,
  loadStore,
  mutateStore,
  recoverMissingClaudeProfileMetadata,
} from '../src/profiles';
import { commandHelpPages } from '../src/presentation';
import {
  archiveImportedSources,
  normalizeImportPath,
  uniqueExportPath,
} from '../src/transfer';

const roots: string[] = [];

function resetRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-transfer-'));
  roots.push(root);
  process.env.CLAUDE_SWITCH_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'official-claude');
  process.env.CODEX_HOME = path.join(root, 'official-codex');
  ensureDataDirs();
  return root;
}

afterEach(() => {
  delete process.env.CLAUDE_SWITCH_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codexAuth(accountId: string, email: string) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email }),
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' } }),
      refresh_token: `refresh-${accountId}`,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
}

test('dragged and quoted import paths normalize without shell evaluation', () => {
  const file = path.join(os.tmpdir(), 'folder with spaces', 'auth.json');
  assert.equal(normalizeImportPath(`"${file}"`), file);
  assert.equal(normalizeImportPath(`& '${file}'`), file);
  assert.equal(normalizeImportPath(pathToFileURL(file).href), file);
});

test('Claude raw import needs only .credentials.json and groups optional companions explicitly', () => {
  const root = resetRoot();
  const file = path.join(root, 'single.credentials.json');
  fs.writeFileSync(file, JSON.stringify({
    organizationUuid: 'organization-one',
    claudeAiOauth: {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
  }));

  const candidates = importFromPath(file);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].format, 'raw-credentials');
  assert.deepEqual(candidates[0].consumedPaths, [path.resolve(file)]);
  assert.equal(candidates[0].fields.email, '(imported)');
  const groups = groupClaudeImportCandidates(candidates);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].candidates.length, 1);
});

test('Claude imported-session provenance survives storage and clears after official re-authentication', () => {
  const root = resetRoot();
  const file = path.join(root, 'single.credentials.json');
  fs.writeFileSync(file, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-provenance',
      refreshToken: 'refresh-provenance',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile'],
    },
  }));
  const [candidate] = importFromPath(file);
  mutateStore((store) => {
    addOrUpdateProfile(store, candidate.fields, undefined, { credentialSource: 'raw-import' });
  });
  assert.equal(loadStore().profiles[0].importedSession?.format, 'raw-file');

  mutateStore((store) => {
    addOrUpdateProfile(store, {
      ...candidate.fields,
      email: 'verified@example.test',
      accountUuid: 'verified-account',
      organizationUuid: 'verified-organization',
      oauthAccount: {
        accountUuid: 'verified-account',
        emailAddress: 'verified@example.test',
        organizationUuid: 'verified-organization',
      },
    }, 'Verified', { credentialSource: 'validated-login' });
  });
  assert.equal(loadStore().profiles[0].importedSession, undefined);
});

test('Claude legacy raw imports self-heal from provider metadata without changing credentials', async () => {
  const root = resetRoot();
  const file = path.join(root, 'legacy.credentials.json');
  fs.writeFileSync(file, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-self-heal',
      refreshToken: 'refresh-self-heal',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile'],
    },
  }));
  const [candidate] = importFromPath(file);
  mutateStore((store) => {
    addOrUpdateProfile(store, candidate.fields, undefined, { credentialSource: 'raw-import' });
  });

  const fetchImpl = (async () => new Response(JSON.stringify({
    account: {
      uuid: 'provider-account',
      email: 'provider@example.test',
      display_name: 'Provider Account',
      has_claude_pro: true,
    },
    organization: {
      uuid: 'provider-organization',
      organization_type: 'claude_pro',
    },
  }), { status: 200 })) as typeof fetch;
  const result = await recoverMissingClaudeProfileMetadata('2.1.0', { fetchImpl });
  assert.equal(result.checkedCount, 1);
  assert.equal(result.verifiedCount, 1);
  const [saved] = result.store.profiles;
  assert.equal(saved.accountUuid, 'provider-account');
  assert.equal(saved.email, 'provider@example.test');
  assert.equal(saved.label, 'Provider Account');
  assert.equal(saved.subscriptionType, 'pro');
  assert.equal(saved.claudeAiOauth?.accessToken, 'access-self-heal');
  assert.equal(saved.claudeAiOauth?.refreshToken, 'refresh-self-heal');
  assert.equal(saved.importedSession?.format, 'raw-file');
});

test('successful managed-inbox imports move evidence with a secret-free receipt while external files remain', () => {
  const root = resetRoot();
  const inboxFile = path.join(providerImportDir('claude'), '.credentials.json');
  const externalFile = path.join(root, 'external.credentials.json');
  const secret = 'refresh-secret-never-in-receipt';
  fs.writeFileSync(inboxFile, JSON.stringify({ secret }));
  fs.writeFileSync(externalFile, JSON.stringify({ external: true }));

  const result = archiveImportedSources('claude', [inboxFile, externalFile], [{ id: 'profile-one', label: 'One' }]);

  assert.equal(fs.existsSync(inboxFile), false);
  assert.equal(fs.existsSync(externalFile), true);
  assert.equal(result.moved.length, 1);
  assert.deepEqual(result.retained, [path.resolve(externalFile)]);
  assert.ok(result.receiptPath && fs.existsSync(result.receiptPath));
  const receipt = fs.readFileSync(result.receiptPath!, 'utf8');
  assert.doesNotMatch(receipt, new RegExp(secret));
  assert.match(receipt, /"provider": "claude"/);
  assert.match(receipt, /"sha256": "[a-f0-9]{64}"/);
});

test('timestamped export paths never overwrite an existing recovery artifact', () => {
  resetRoot();
  const now = new Date('2026-07-19T10:11:12.345Z');
  const first = uniqueExportPath('all accounts', '.ccswitch.json', now);
  fs.writeFileSync(first, '{}');
  const second = uniqueExportPath('all accounts', '.ccswitch.json', now);
  assert.notEqual(second, first);
  assert.match(path.basename(first), /^2026-07-19T10-11-12-345Z-all_accounts\.ccswitch\.json$/);
  assert.match(path.basename(second), /-2\.ccswitch\.json$/);
});

test('Codex validates an entire export-all bundle before importing its first account', async () => {
  const root = resetRoot();
  const file = path.join(root, 'mixed.codexswitch.json');
  const valid = codexAuth('valid-account', 'valid@example.test');
  const invalid = codexAuth('invalid-account', 'invalid@example.test');
  invalid.tokens.refresh_token = '';
  fs.writeFileSync(file, JSON.stringify({
    kind: 'claude-codex-account-switch/export-all',
    version: 2,
    provider: 'codex',
    exportedAt: Date.now(),
    accounts: [
      {
        kind: 'claude-codex-account-switch/export',
        version: 2,
        provider: 'codex',
        exportedAt: Date.now(),
        label: 'Valid',
        email: 'valid@example.test',
        accountId: 'valid-account',
        auth: valid,
      },
      {
        kind: 'claude-codex-account-switch/export',
        version: 2,
        provider: 'codex',
        exportedAt: Date.now(),
        label: 'Invalid',
        email: 'invalid@example.test',
        accountId: 'invalid-account',
        auth: invalid,
      },
    ],
  }));

  await assert.rejects(importCodexFromPath(file), /missing a non-empty tokens\.refresh_token/);
  assert.equal(loadCodexStore().profiles.length, 0);
});

test('Codex records whether an imported session came from a raw file or portable export', async () => {
  const root = resetRoot();
  const rawFile = path.join(root, 'auth.json');
  fs.writeFileSync(rawFile, JSON.stringify(codexAuth('raw-account', 'raw@example.test')));
  const [raw] = await importCodexFromPath(rawFile);
  assert.equal(raw.importedSession?.format, 'raw-file');
  assert.ok((raw.importedSession?.importedAt ?? 0) > 0);

  const portableFile = path.join(root, 'portable.codexswitch.json');
  const auth = codexAuth('portable-account', 'portable@example.test');
  fs.writeFileSync(portableFile, JSON.stringify({
    kind: 'claude-codex-account-switch/export',
    version: 2,
    provider: 'codex',
    exportedAt: Date.now(),
    label: 'Portable',
    email: 'portable@example.test',
    accountId: 'portable-account',
    auth,
  }));
  const [portable] = await importCodexFromPath(portableFile);
  assert.equal(portable.importedSession?.format, 'portable-export');
});

test('command help stays short, paged, and complete for both providers', () => {
  const sharedCapabilities = [
    'navigate', 'page-accounts', 'jump-accounts', 'search', 'provider-tab', 'help',
    'switch', 'refresh', 'best-now', 'raw-headroom', 'cancel-refresh',
    'add-account', 'rename-account', 'archive-account', 'restore-account',
    'import-inbox', 'import-path', 'import-select', 'import-open', 'import-rescan', 'import-close',
    'export-selected', 'export-all', 'export-open', 'export-unique', 'export-secrets', 'export-provider-limit',
    'setup', 'setup-actions', 'confirm', 'submit-back', 'edit', 'quit',
    'cli-launch', 'cli-login', 'cli-import', 'cli-import-all', 'cli-export-all', 'cli-doctor',
    'cli-dry-run', 'cli-restore', 'cli-install', 'cli-keep-alive', 'cli-keep-alive-job', 'cli-help',
    'safety-switch', 'safety-provider', 'safety-archive', 'safety-import', 'safety-export', 'safety-storage',
  ];

  for (const provider of ['claude', 'codex'] as const) {
    const pages = commandHelpPages(provider);
    assert.equal(pages.length, 9);
    assert.ok(pages.every((page) => page.sections.length > 0));
    assert.ok(pages.every((page) => page.sections.flatMap((section) => section.entries).length <= 6));
    assert.equal(new Set(pages.map((page) => page.shortTitle)).size, pages.length);
    const entries = pages.flatMap((page) => page.sections.flatMap((section) => section.entries));
    const ids = new Set(entries.map((entry) => entry.id));
    assert.equal(ids.size, entries.length, `${provider} help contains duplicate capability ids`);
    for (const id of sharedCapabilities) assert.ok(ids.has(id), `${provider} help is missing ${id}`);
    assert.equal(ids.has('capture-desktop'), provider === 'claude');
    assert.ok(entries.every((entry) => entry.description.length <= 68));
    assert.ok(entries.every((entry) => entry.key.trim().length > 0));
  }
});
