import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildLauncherAction,
  buildRuntimePathArgs,
  buildSchedulerAction,
  buildWindowsSchedulerRegistrationScript,
  desktopExecArgument,
  posixShellQuote,
  quoteWindowsArgument,
  windowsArgumentLine,
  type RuntimeLocations,
} from '../src/installer';
import { projectCodexFileCredentialStore } from '../src/codexConfig';

const locations: RuntimeLocations = {
  switchHome: path.join('C:', 'Users', 'Test User', 'switch home'),
  claudeConfig: path.join('C:', 'Users', 'Test User', 'claude home'),
  codexHome: path.join('C:', 'Users', 'Test User', 'codex home'),
  codexBin: path.join('C:', 'Program Files', 'Codex', 'codex.exe'),
};

test('Codex file credential-store projection preserves user config and is idempotent', () => {
  const original = [
    'model = "gpt-5.6-sol"',
    'notify = ["tool#name"]',
    '',
    '[projects.\'C:\\\\work\']',
    'trust_level = "trusted"',
    '',
  ].join('\r\n');
  const projected = projectCodexFileCredentialStore(original);

  assert.equal(projected.changed, true);
  assert.equal(projected.previous, 'missing');
  assert.match(projected.content, /notify = \["tool#name"\]\r\ncli_auth_credentials_store = "file"\r\n\r\n\[projects/);
  assert.match(projected.content, /trust_level = "trusted"\r\n$/);

  const repeated = projectCodexFileCredentialStore(projected.content);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.previous, 'file');
  assert.equal(repeated.content, projected.content);
});

test('Codex file credential-store projection replaces one explicit root value and rejects ambiguity', () => {
  const replaced = projectCodexFileCredentialStore([
    'cli_auth_credentials_store = "auto" # keep switching deterministic',
    'model = "gpt-5.6-sol"',
    '',
  ].join('\n'));
  assert.equal(replaced.changed, true);
  assert.equal(replaced.previous, 'auto');
  assert.match(replaced.content, /^cli_auth_credentials_store = "file" # keep switching deterministic$/m);

  assert.throws(
    () => projectCodexFileCredentialStore([
      'cli_auth_credentials_store = "auto"',
      'cli_auth_credentials_store = "keyring"',
    ].join('\n')),
    /multiple top-level cli_auth_credentials_store/i,
  );
  assert.throws(
    () => projectCodexFileCredentialStore('cli_auth_credentials_store = true\n'),
    /must be a quoted TOML string/i,
  );
});

test('persistent runtime flags preserve all custom stores and the resolved Codex binary', () => {
  assert.deepEqual(buildRuntimePathArgs(locations), [
    '--switch-home', path.resolve(locations.switchHome),
    '--claude-config', path.resolve(locations.claudeConfig),
    '--codex-home', path.resolve(locations.codexHome),
    '--codex-bin', path.resolve(locations.codexBin!),
  ]);
  assert.throws(
    () => buildRuntimePathArgs({ ...locations, switchHome: 'unsafe\ncron-entry' }),
    /single-line filesystem path/i,
  );
});

test('Windows shortcuts bypass cmd.exe and preserve custom runtime paths with metacharacters', () => {
  const safeLocations = { ...locations, switchHome: path.join('C:', 'acct&data', 'switch') };
  const node = path.join('C:', 'node', 'node.exe');
  const action = buildLauncherAction({
    node,
    entry: path.join('C:', 'app', 'dist', 'cli.js'),
    root: path.join('C:', 'app'),
    locations: safeLocations,
  });

  assert.equal(action.exe, path.resolve(node));
  assert.equal(action.args[0], path.resolve(path.join('C:', 'app', 'dist', 'cli.js')));
  assert.deepEqual(action.args.slice(1), buildRuntimePathArgs(safeLocations));
  assert.equal(action.exe.toLowerCase().endsWith('.cmd'), false);
  assert.equal(action.cwd, path.resolve(path.join('C:', 'app')));
});

test('direct launchers and scheduler actions share the same durable runtime projection', () => {
  const root = path.join('C:', 'app root');
  const entry = path.join(root, 'dist', 'cli.js');
  const node = path.join('C:', 'node runtime', 'node.exe');
  const launcher = buildLauncherAction({
    node,
    entry,
    root,
    locations,
  });
  const scheduler = buildSchedulerAction({ node, entry, cwd: root, locations });

  assert.deepEqual(launcher.args.slice(1), buildRuntimePathArgs(locations));
  assert.deepEqual(scheduler.args, [path.resolve(entry), 'keep-alive', '--scheduler-runtime', ...buildRuntimePathArgs(locations)]);
});

test('a Claude-only scheduler action does not require Codex or fall back to PATH', () => {
  const claudeOnly = { ...locations, codexBin: undefined };
  const action = buildSchedulerAction({
    node: path.join('C:', 'node', 'node.exe'),
    entry: path.join('C:', 'app', 'dist', 'cli.js'),
    cwd: path.join('C:', 'app'),
    locations: claudeOnly,
  });

  assert.deepEqual(action.args, [
    path.resolve(path.join('C:', 'app', 'dist', 'cli.js')),
    'keep-alive',
    '--scheduler-runtime',
    ...buildRuntimePathArgs(claudeOnly),
  ]);
  assert.equal(action.args.includes('--codex-bin'), false);
});

test('Windows action quoting preserves empty, spaced, quoted, and trailing-backslash arguments', () => {
  assert.equal(quoteWindowsArgument('plain'), 'plain');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('two words'), '"two words"');
  assert.equal(quoteWindowsArgument('C:\\two words\\'), '"C:\\two words\\\\"');
  assert.equal(quoteWindowsArgument('say"hello'), '"say\\"hello"');
  assert.equal(
    windowsArgumentLine(['--codex-home', 'C:\\home with spaces\\']),
    '--codex-home "C:\\home with spaces\\\\"',
  );
});

test('Windows registration uses structured ScheduledTasks fields instead of schtasks /TR', () => {
  const action = buildSchedulerAction({
    node: path.join('C:', 'A very long node installation path', 'node.exe'),
    entry: path.join('C:', 'A very long project path', 'dist', 'cli.js'),
    cwd: path.join('C:', 'A very long project path'),
    locations,
  });
  const script = buildWindowsSchedulerRegistrationScript(action);

  assert.match(script, /New-ScheduledTaskAction -Execute/);
  assert.match(script, /-Argument/);
  assert.match(script, /-WorkingDirectory/);
  assert.match(script, /Register-ScheduledTask/);
  assert.equal((script.match(/New-ScheduledTaskTrigger -Daily/g) ?? []).length, 4);
  assert.doesNotMatch(script, /\bschtasks\b|\/TR\b/i);
  assert.ok(script.includes(windowsArgumentLine(action.args).replace(/'/g, "''")));
});

test('POSIX and desktop launchers quote metacharacters instead of evaluating them', () => {
  assert.equal(posixShellQuote("a'b $HOME"), `'a'"'"'b $HOME'`);
  const desktop = desktopExecArgument('a b$HOME`cmd`%f\\tail');
  assert.equal(desktop, '"a b\\$HOME\\`cmd\\`%%f\\\\tail"');
  assert.throws(() => desktopExecArgument('line\nbreak'), /line breaks/i);
});

test('headless scheduler skips an absent Codex provider without requiring CODEX_BIN', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-claude-only-'));
  const switchHome = path.join(root, 'switch');
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  const env = { ...process.env };
  delete env.CODEX_BIN;
  try {
    const common = [
      path.resolve('src/cli.tsx'),
      'keep-alive',
      '--scheduler-runtime',
      '--switch-home', switchHome,
      '--claude-config', claudeHome,
      '--codex-home', codexHome,
    ];
    const probe = spawnSync(process.execPath, ['--import', 'tsx', ...common, '--scheduler-probe'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /codex-cli=not-required/);

    const keepAlive = spawnSync(process.execPath, ['--import', 'tsx', ...common], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(keepAlive.status, 0, keepAlive.stderr);
    assert.match(keepAlive.stdout, /codex keep-alive: skipped \(no saved Codex accounts\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
