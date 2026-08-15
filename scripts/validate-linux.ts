import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLinuxDesktopEntry, buildLinuxSystemdUnits, type LaunchAction } from '../src/installer';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-linux-fixtures-'));
const action: LaunchAction = {
  exe: process.execPath,
  args: [
    path.resolve('dist/cli.js'),
    'keep-alive',
    '--scheduler-runtime',
    '--switch-home', path.join(root, 'switch'),
    '--claude-config', path.join(root, 'claude'),
    '--codex-home', path.join(root, 'codex'),
  ],
  cwd: path.resolve('.'),
};

function requireCommand(exe: string, args: string[]): void {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${exe} ${args.join(' ')} failed:\n${String(result.stderr || result.stdout || result.error?.message || '')}`);
  }
}

try {
  const units = buildLinuxSystemdUnits(action);
  const service = path.join(root, 'claude-codex-account-switch-keepalive.service');
  const timer = path.join(root, 'claude-codex-account-switch-keepalive.timer');
  const desktop = path.join(root, 'claude-codex-account-switch.desktop');
  fs.writeFileSync(service, units.service, { mode: 0o600 });
  fs.writeFileSync(timer, units.timer, { mode: 0o600 });
  fs.writeFileSync(desktop, buildLinuxDesktopEntry({ ...action, args: [path.resolve('dist/cli.js')] }), { mode: 0o755 });
  requireCommand('systemd-analyze', ['verify', service, timer]);
  requireCommand('desktop-file-validate', [desktop]);
  console.log('Linux systemd and Desktop Entry fixtures are valid.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
