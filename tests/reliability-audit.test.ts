import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { codexProfilesPath, dataDir, profilesPath } from '../src/paths';
import { AbandonedFileLockError, withFileLock, withFileLockSync } from '../src/locks';
import { exchangeCode, refreshToken } from '../src/oauth';
import { mutateStore } from '../src/profiles';
import { renameCodexProfile } from '../src/codexProfiles';
import { guardInputHandler, reloadOrKeep } from '../src/tuiGuards';

let root = '';

function resetRoot(): void {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-switch-audit-'));
  process.env.CLAUDE_SWITCH_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'live-claude');
  process.env.CODEX_HOME = path.join(root, 'live-codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
}

function lockDir(name: string): string {
  return path.join(dataDir(), 'locks', `${name}.lock`);
}

test.beforeEach(() => resetRoot());

test.afterEach(() => {
  mock.restoreAll();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

test('a failed lock-owner write removes its own directory instead of orphaning the lock', () => {
  const realWrite = fs.writeFileSync;
  const writeMock = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith(`${path.sep}owner.json`)) {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return realWrite(...args);
  });

  assert.throws(() => withFileLockSync('audit-enospc', () => 'unreachable', { timeoutMs: 500 }), /no space left/);
  assert.equal(fs.existsSync(lockDir('audit-enospc')), false, 'the ownerless lock directory must not survive');

  writeMock.mock.restore();
  // Once the disk recovers, the next acquirer must not be blocked by evidence of the failure.
  assert.equal(withFileLockSync('audit-enospc', () => 'acquired', { timeoutMs: 500 }), 'acquired');
});

test('a waiter does not treat a concurrent acquirer\'s ownerless window as an abandoned lock', async () => {
  // Another process has created the directory but not yet written owner.json.
  const dir = lockDir('audit-window');
  fs.mkdirSync(dir, { recursive: true });
  const finished = setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 300);
  try {
    const value = await withFileLock('audit-window', async () => 'acquired', { timeoutMs: 3_000 });
    assert.equal(value, 'acquired');
  } finally {
    clearTimeout(finished);
  }
});

test('an ownerless lock past its creation window still fails closed for ordinary waiters', () => {
  const dir = lockDir('audit-orphan');
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(dir, old, old);
  assert.throws(
    () => withFileLockSync('audit-orphan', () => 'unreachable', { timeoutMs: 500 }),
    (error: unknown) => error instanceof AbandonedFileLockError,
  );
  assert.equal(fs.existsSync(dir), true, 'ordinary waiters never delete a lock they do not own');
});

for (const [label, body, contentType] of [
  ['a JSON null', 'null', 'application/json'],
  ['a JSON array', '[]', 'application/json'],
  ['an HTML proxy page', '<html>captive portal</html>', 'text/html'],
] as const) {
  test(`Claude OAuth reports ${label} token response clearly without classifying it as invalid_grant`, async () => {
    mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200, headers: { 'Content-Type': contentType } }));
    for (const attempt of [() => refreshToken('refresh-1'), () => exchangeCode('code#state', 'verifier', 'state')]) {
      await assert.rejects(attempt(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unreadable response\. Existing credentials were preserved\./);
        assert.doesNotMatch(error.message, /invalid_grant|Cannot read properties|Unexpected token/);
        return true;
      });
    }
  });
}

test('Claude OAuth network failures still propagate for the caller to keep cached credentials', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(refreshToken('refresh-1'), /fetch failed/);
});

test('a guarded key handler reports a failure instead of throwing out of Ink', () => {
  const seen: unknown[] = [];
  const reported: unknown[] = [];
  const handler = guardInputHandler((input: string, key: { return?: boolean }) => {
    seen.push([input, key.return]);
    if (input === 'x') throw new Error('Timed out waiting for lock: profiles-store');
  }, (error) => reported.push(error));

  handler('r', { return: false });
  assert.doesNotThrow(() => handler('x', { return: true }));
  assert.deepEqual(seen, [['r', false], ['x', true]]);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Timed out waiting for lock/);
});

test('renaming with damaged metadata fails closed for both providers and the guard keeps files intact', () => {
  fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
  fs.writeFileSync(profilesPath(), '{"profiles": [', 'utf8');
  fs.writeFileSync(codexProfilesPath(), '{"profiles": [', 'utf8');
  const claudeBefore = fs.readFileSync(profilesPath());
  const codexBefore = fs.readFileSync(codexProfilesPath());

  const reported: string[] = [];
  const onError = (error: unknown) => reported.push(String(error));
  guardInputHandler(() => {
    mutateStore((store) => {
      const profile = store.profiles[0];
      if (profile) profile.label = 'renamed';
    });
  }, onError)();
  guardInputHandler(() => {
    renameCodexProfile('codex-1', 'renamed');
  }, onError)();

  assert.equal(reported.length, 2);
  assert.match(reported[0], /Claude profile metadata is damaged/);
  assert.match(reported[1], /Codex profile metadata is damaged/);
  assert.deepEqual(fs.readFileSync(profilesPath()), claudeBefore);
  assert.deepEqual(fs.readFileSync(codexProfilesPath()), codexBefore);
});

test('a failed store reload after a failed refresh keeps the last snapshot instead of rejecting', () => {
  const snapshot = { revision: 7, profiles: [] as string[] };
  const errors: unknown[] = [];
  const kept = reloadOrKeep(() => {
    throw new Error('EACCES: permission denied');
  }, snapshot, (error) => errors.push(error));
  assert.equal(kept, snapshot);
  assert.equal(errors.length, 1);

  const fresh = { revision: 8, profiles: ['a'] };
  assert.equal(reloadOrKeep(() => fresh, snapshot, () => assert.fail('no error expected')), fresh);
});
