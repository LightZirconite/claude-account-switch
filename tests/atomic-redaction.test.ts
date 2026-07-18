import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { atomicCopyFile, atomicWriteFile, ensurePrivateDir } from '../src/atomicFile';
import { logger, redactText, redactValue } from '../src/logger';

function tempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-atomic-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

test('atomicWriteFile replaces text and binary content with private permissions', (t) => {
  const root = tempRoot(t);
  const privateDir = path.join(root, 'private', 'nested');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(privateDir, 0o755);

  ensurePrivateDir(privateDir);
  const target = path.join(privateDir, 'auth.json');
  atomicWriteFile(target, 'first');
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');

  const binary = Buffer.from([0, 1, 2, 127, 128, 255]);
  atomicWriteFile(target, binary);
  assert.deepEqual(fs.readFileSync(target), binary);
  assert.equal(fs.readdirSync(privateDir).some((name) => name.startsWith('.auth.json.tmp-')), false);

  if (process.platform !== 'win32') {
    assert.equal(modeOf(privateDir), 0o700);
    assert.equal(modeOf(target), 0o600);
  }
});

test('atomicWriteFile never tightens an existing generic parent directory', (t) => {
  const root = tempRoot(t);
  if (process.platform === 'win32') return;
  fs.chmodSync(root, 0o755);
  atomicWriteFile(path.join(root, 'live-auth.json'), '{}\n');
  assert.equal(modeOf(root), 0o755);
  assert.equal(modeOf(path.join(root, 'live-auth.json')), 0o600);
});

test('atomicWriteFile fails closed and removes its temp file when rename cannot replace the target', (t) => {
  const root = tempRoot(t);
  const target = path.join(root, 'auth.json');
  fs.writeFileSync(target, 'original', 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = ((oldPath, newPath) => {
    if (path.resolve(String(newPath)) === path.resolve(target)) {
      const error = new Error('simulated atomic replace failure') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;

  try {
    assert.throws(() => atomicWriteFile(target, 'replacement'), /simulated atomic replace failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.auth.json.tmp-')), false);
});

test('atomicCopyFile copies bytes and leaves an existing target untouched when source reading fails', (t) => {
  const root = tempRoot(t);
  const source = path.join(root, 'source.bin');
  const target = path.join(root, 'target.bin');
  const content = Buffer.from([255, 0, 42, 13, 10]);
  fs.writeFileSync(source, content);
  fs.writeFileSync(target, 'old');

  atomicCopyFile(source, target);
  assert.deepEqual(fs.readFileSync(target), content);
  if (process.platform !== 'win32') assert.equal(modeOf(target), 0o600);

  assert.throws(() => atomicCopyFile(path.join(root, 'missing.bin'), target));
  assert.deepEqual(fs.readFileSync(target), content);
});

test('redactValue recursively removes secret fields, embedded tokens, and URL query values', () => {
  const input: Record<string, unknown> = {
    ordinary: 'safe-value',
    nested: {
      refreshToken: 'short-refresh-secret',
      callback: 'http://localhost:1455/auth/callback?code=callback-code&state=callback-state',
      message: 'Authorization: Bearer bearer-secret',
      serialized: '{"code":"json-code-secret","state":"json-state-secret"}',
    },
    values: [
      { authorization: 'Bearer nested-secret' },
      'request failed at https://auth.example.test/authorize?client_id=public&code=hidden-code',
      'sk-ant-embedded-secret-value',
      'aaaaaaaaaaa.bbbbbbbbbbb.cccccccccc',
    ],
  };
  input.self = input;

  const serialized = JSON.stringify(redactValue(input));
  assert.match(serialized, /safe-value/);
  assert.match(serialized, /http:\/\/localhost:1455\/auth\/callback\?<redacted>/);
  assert.match(serialized, /<circular>/);
  for (const secret of [
    'short-refresh-secret',
    'callback-code',
    'callback-state',
    'bearer-secret',
    'json-code-secret',
    'json-state-secret',
    'nested-secret',
    'hidden-code',
    'sk-ant-embedded-secret-value',
    'aaaaaaaaaaa.bbbbbbbbbbb.cccccccccc',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('redactText makes persisted and terminal error messages safe', () => {
  const safe = redactText(new Error(
    'callback http://localhost:1455/auth/callback?code=terminal-code&state=terminal-state Bearer terminal-bearer',
  ));
  assert.match(safe, /callback http:\/\/localhost:1455\/auth\/callback\?<redacted>/);
  assert.doesNotMatch(safe, /terminal-code|terminal-state|terminal-bearer/);
});

test('logger redacts actions, nested details, and Error messages before one private append', (t) => {
  const root = tempRoot(t);
  const previousHome = process.env.CLAUDE_SWITCH_HOME;
  process.env.CLAUDE_SWITCH_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previousHome;
  });

  logger.error(
    'callback failed: http://localhost:1455/auth/callback?code=action-code&state=action-state',
    new Error('request Bearer error-bearer at https://auth.example.test/callback?code=error-code'),
    {
      nested: {
        accessToken: 'tiny-access-token',
        callbackUrl: 'https://auth.example.test/authorize?code=detail-code&state=detail-state',
      },
    },
  );

  const file = path.join(root, 'logs', 'switch.log');
  const line = fs.readFileSync(file, 'utf8');
  assert.match(line, /\[ERROR\] callback failed:/);
  assert.match(line, /http:\/\/localhost:1455\/auth\/callback\?<redacted>/);
  for (const secret of [
    'action-code',
    'action-state',
    'error-bearer',
    'error-code',
    'tiny-access-token',
    'detail-code',
    'detail-state',
  ]) {
    assert.equal(line.includes(secret), false);
  }
  if (process.platform !== 'win32') assert.equal(modeOf(file), 0o600);
});
