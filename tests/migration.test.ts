import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverMigrationArchiveInput,
  discoverPortableMigrationPassphraseFile,
  exportMigration,
  importMigration,
  inspectMigration,
  PORTABLE_MIGRATION_KEY_NAME,
  readMigrationPassphraseFile,
  readPortableMigrationPassphraseFile,
  resolveMigrationArchiveInput,
  verifyMigration,
} from '../src/migration';

const passphrase = 'correct horse battery staple';
const quiet = {
  claudeProcessInventory: () => [],
  codexProcessInventory: () => [],
  includeDesktopRecovery: false,
  targetPlatform: 'linux' as const,
};

function setHomes(root: string): void {
  process.env.CLAUDE_SWITCH_HOME = path.join(root, 'switch');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  fs.mkdirSync(process.env.CLAUDE_SWITCH_HOME, { recursive: true });
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
}

test('encrypted migration round-trips portable state, verifies hashes, and backs up conflicts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-migration-test-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const portableFolder = path.join(root, 'Coder');
  const archive = path.join(portableFolder, 'portable.ccswitch-migration');
  const previous = {
    switchHome: process.env.CLAUDE_SWITCH_HOME,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  };
  try {
    setHomes(source);
    fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'portable-note.txt'), 'switcher-private-state\n');
    fs.mkdirSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'exports'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'exports', 'previous.ccswitch-migration'), 'do not recursively archive me');
    const desktopSnapshotDir = path.join(process.env.CLAUDE_SWITCH_HOME!, 'desktop', 'desktop-only-profile');
    fs.mkdirSync(desktopSnapshotDir, { recursive: true });
    fs.writeFileSync(path.join(desktopSnapshotDir, 'machine-cookie.bin'), 'windows-machine-bound-cookie');
    fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'profiles.json'), `${JSON.stringify({
      version: 3,
      revision: 0,
      activeProfileId: null,
      activeProfileIds: { claude: null, codex: null },
      tombstones: [],
      profiles: [{
        provider: 'claude',
        id: 'desktop-only-profile',
        label: 'Desktop only',
        email: 'desktop@example.test',
        desktopSnapshotDir,
        desktopCapturedAt: Date.now(),
        createdAt: Date.now(),
      }],
    }, null, 2)}\n`);
    fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{"refreshToken":"claude-secret-value"}\n');
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), '{"oauthAccount":{"emailAddress":"portable@example.test"}}\n');
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'sessions', 'history.jsonl'), '{"message":"portable Claude history"}\n');
    fs.mkdirSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(process.env.CODEX_HOME!, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'auth.json'), '{"tokens":{"access_token":"codex-secret-value"}}\n');
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'config.toml'), '[mcp.test]\ncommand = "C:\\tools\\server.exe"\n');
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'hooks', 'run.ps1'), 'Write-Output "Windows only"\n');
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'sessions', 'history.jsonl'), '{"message":"portable Codex history"}\n');
    fs.mkdirSync(path.join(process.env.CODEX_HOME!, '.sandbox'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, '.sandbox', 'sandbox.log'), 'transient runtime log\n');
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, '.sandbox', 'setup_marker.json'), '{}\n');
    fs.mkdirSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'locks', 'ignored.lock'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'locks', 'ignored.lock', 'owner.json'), '{}');

    const exported = await exportMigration(passphrase, archive, quiet);
    assert.equal(exported.output, path.resolve(archive));
    assert.ok(exported.manifest.entries.some((entry) => entry.scope === 'claude' && entry.path === '.credentials.json'));
    assert.ok(exported.manifest.entries.some((entry) => entry.scope === 'claude-meta' && entry.path === '.claude.json'));
    assert.equal(exported.manifest.entries.some((entry) => entry.scope === 'claude' && entry.path === '.claude.json'), false);
    assert.ok(exported.manifest.entries.some((entry) => entry.scope === 'codex' && entry.path === 'auth.json'));
    assert.ok(exported.manifest.entries.some((entry) => entry.scope === 'recovery' && entry.path.endsWith('/codex/hooks/run.ps1')));
    assert.ok(exported.manifest.portabilityWarnings.some((entry) => entry.scope === 'codex' && entry.path === 'config.toml'));
    assert.ok(exported.manifest.exclusions.some((entry) => entry.scope === 'switch' && entry.path === 'locks'));
    assert.ok(exported.manifest.exclusions.some((entry) => entry.scope === 'switch' && entry.path === 'exports/previous.ccswitch-migration'));
    assert.ok(exported.manifest.exclusions.some((entry) => entry.scope === 'codex'
      && entry.path === '.sandbox/sandbox.log'
      && entry.reason === 'ephemeral Codex sandbox runtime log'));
    assert.equal(exported.manifest.entries.some((entry) => entry.scope === 'codex' && entry.path === '.sandbox/sandbox.log'), false);
    assert.ok(exported.manifest.entries.some((entry) => entry.scope === 'codex' && entry.path === '.sandbox/setup_marker.json'));
    const ciphertext = fs.readFileSync(archive);
    assert.equal(ciphertext.includes(Buffer.from('claude-secret-value')), false);
    assert.equal(ciphertext.includes(Buffer.from('codex-secret-value')), false);

    assert.equal(resolveMigrationArchiveInput(portableFolder), path.resolve(archive));
    assert.equal(discoverMigrationArchiveInput(portableFolder), path.resolve(archive));
    const portableKey = path.join(portableFolder, PORTABLE_MIGRATION_KEY_NAME);
    fs.writeFileSync(portableKey, `${passphrase}\n`, { mode: 0o644 });
    assert.equal(discoverPortableMigrationPassphraseFile(portableFolder), portableKey);
    assert.equal(discoverPortableMigrationPassphraseFile(archive), portableKey);
    assert.equal(readPortableMigrationPassphraseFile(portableKey), passphrase);
    assert.throws(
      () => readPortableMigrationPassphraseFile(path.join(portableFolder, 'unexpected-key.txt')),
      /must be named/i,
    );
    const inspected = await inspectMigration(portableFolder, passphrase);
    assert.equal(inspected.archiveId, exported.manifest.archiveId);
    assert.equal((await verifyMigration(portableFolder, passphrase)).entries.length, inspected.entries.length);
    await assert.rejects(inspectMigration(archive, 'wrong passphrase value'), /wrong passphrase|modified archive/i);

    setHomes(target);
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{"refreshToken":"target-conflict"}\n');
    await assert.rejects(
      importMigration(portableFolder, passphrase, quiet),
      /--replace-existing/i,
    );
    assert.match(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'), /target-conflict/);

    const imported = await importMigration(portableFolder, passphrase, { ...quiet, replaceExisting: true });
    assert.ok(imported.written >= 5);
    assert.ok(imported.backupDir);
    assert.match(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'), /claude-secret-value/);
    assert.match(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8'), /portable@example\.test/);
    assert.match(fs.readFileSync(path.join(process.env.CODEX_HOME!, 'auth.json'), 'utf8'), /codex-secret-value/);
    assert.match(fs.readFileSync(path.join(process.env.CODEX_HOME!, 'config.toml'), 'utf8'), /C:\\tools\\server\.exe/);
    assert.match(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'sessions', 'history.jsonl'), 'utf8'), /portable Claude history/);
    assert.match(fs.readFileSync(path.join(process.env.CODEX_HOME!, 'sessions', 'history.jsonl'), 'utf8'), /portable Codex history/);
    assert.equal(fs.existsSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'locks', 'ignored.lock', 'owner.json')), false);
    assert.match(fs.readFileSync(path.join(imported.backupDir!, 'claude', '.credentials.json'), 'utf8'), /target-conflict/);
    const importedProfiles = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'profiles.json'), 'utf8')) as {
      profiles: Array<{ desktopSnapshotDir?: string; needsReauth?: boolean }>;
    };
    assert.equal(importedProfiles.profiles[0].desktopSnapshotDir, undefined);
    assert.equal(importedProfiles.profiles[0].needsReauth, true);
    assert.ok(imported.desktopLinksDetached >= 1);
    assert.equal(fs.existsSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'desktop', 'desktop-only-profile', 'machine-cookie.bin')), false);
    assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME!, 'hooks', 'run.ps1')), false);
    assert.ok(imported.recoveryDir);
    assert.equal(fs.existsSync(path.join(imported.recoveryDir!, 'windows', 'provider-machine-files', 'codex', 'hooks', 'run.ps1')), true);
    assert.ok(imported.portabilityReviewFile);
  } finally {
    if (previous.switchHome === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previous.switchHome;
    if (previous.claudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claudeConfig;
    if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration rechecks provider processes before publishing or mutating live data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-migration-boundary-'));
  const archive = path.join(root, 'portable.ccswitch-migration');
  const blockedArchive = path.join(root, 'blocked.ccswitch-migration');
  const previous = {
    switchHome: process.env.CLAUDE_SWITCH_HOME,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  };
  try {
    setHomes(path.join(root, 'source'));
    fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'state.txt'), 'source state\n');

    let exportChecks = 0;
    await assert.rejects(
      exportMigration(passphrase, blockedArchive, {
        ...quiet,
        claudeProcessInventory: () => (++exportChecks < 3 ? [] : [{ pid: 8101, name: 'claude' }]),
      }),
      /publication boundary/i,
    );
    assert.equal(fs.existsSync(blockedArchive), false);

    await exportMigration(passphrase, archive, quiet);
    setHomes(path.join(root, 'target'));
    let importChecks = 0;
    await assert.rejects(
      importMigration(archive, passphrase, {
        ...quiet,
        claudeProcessInventory: () => (++importChecks === 1 ? [] : [{ pid: 8102, name: 'claude-desktop' }]),
      }),
      /mutation boundary/i,
    );
    assert.equal(fs.existsSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'state.txt')), false);
  } finally {
    if (previous.switchHome === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previous.switchHome;
    if (previous.claudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claudeConfig;
    if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration passphrase files cannot live inside an exported data root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-migration-passphrase-'));
  const previous = {
    switchHome: process.env.CLAUDE_SWITCH_HOME,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  };
  try {
    setHomes(root);
    const unsafe = path.join(process.env.CLAUDE_SWITCH_HOME!, 'migration-passphrase');
    fs.writeFileSync(unsafe, `${passphrase}\n`, { mode: 0o600 });
    assert.throws(() => readMigrationPassphraseFile(unsafe, { forExport: true }), /outside the switcher/i);

    const safe = path.join(root, 'separate-passphrase');
    fs.writeFileSync(safe, `${passphrase}\n`, { mode: 0o600 });
    assert.equal(readMigrationPassphraseFile(safe, { forExport: true }), passphrase);
  } finally {
    if (previous.switchHome === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previous.switchHome;
    if (previous.claudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claudeConfig;
    if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration authentication detects ciphertext corruption before import', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-migration-corrupt-'));
  const archive = path.join(root, 'valid.ccswitch-migration');
  const corrupted = path.join(root, 'corrupt.ccswitch-migration');
  const previous = {
    switchHome: process.env.CLAUDE_SWITCH_HOME,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  };
  try {
    setHomes(path.join(root, 'source'));
    fs.writeFileSync(path.join(process.env.CLAUDE_SWITCH_HOME!, 'state.txt'), 'authenticated content\n');
    await exportMigration(passphrase, archive, quiet);
    const bytes = fs.readFileSync(archive);
    bytes[Math.floor(bytes.length / 2)] ^= 0x40;
    fs.writeFileSync(corrupted, bytes);
    await assert.rejects(verifyMigration(corrupted, passphrase), /wrong passphrase|modified archive|decompression/i);
  } finally {
    if (previous.switchHome === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previous.switchHome;
    if (previous.claudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claudeConfig;
    if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
