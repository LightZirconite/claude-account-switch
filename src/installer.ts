// Cross-platform "make it feel like a real app" installer: a recurring keep-alive job
// (so saved access tokens are refreshed even with the UI closed) + Start-menu/Desktop shortcuts.
// Every step is best-effort and reported individually — one failure never aborts the rest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataDir, ensureDataDirs } from './paths';
import { logger } from './logger';

export const APP_NAME = 'Claude + Codex Account Switch';
const LEGACY_APP_NAME = 'Claude Account Switch';
const TASK_ID = 'ClaudeAccountSwitch-KeepAlive'; // Windows task / launchd label / cron marker
const KEEPALIVE_INTERVAL_HOURS = 6;

export interface StepResult {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface InstallReport {
  steps: StepResult[];
}

// ---------- path helpers ----------

/** Absolute path to the running entry script (dist/cli.js). */
function entryScript(): string {
  return path.resolve(process.argv[1] ?? '');
}
/** Project root (parent of dist/). */
function projectRoot(): string {
  return path.resolve(path.dirname(entryScript()), '..');
}
function nodeExe(): string {
  return process.execPath;
}
/** The command a shortcut should launch to open the interactive switcher. */
function launcherCommand(): { exe: string; args: string[]; cwd: string } {
  const root = projectRoot();
  if (process.platform === 'win32') {
    const cmd = path.join(root, 'switch.cmd');
    if (fs.existsSync(cmd)) return { exe: cmd, args: [], cwd: root };
  }
  return { exe: nodeExe(), args: [entryScript()], cwd: root };
}

function stateFile(): string {
  return path.join(dataDir(), '.install-state.json');
}

interface InstallState {
  scheduler?: boolean;
  shortcuts?: boolean;
  at?: string;
}
export function installState(): InstallState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as InstallState;
  } catch {
    return {};
  }
}
function writeState(patch: InstallState): void {
  try {
    ensureDataDirs();
    const next = { ...installState(), ...patch, at: new Date().toISOString() };
    fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Whether the first-run setup prompt should be offered (nothing installed, never asked). */
export function shouldOfferSetup(): boolean {
  const s = installState();
  return !s.scheduler && !s.shortcuts && !s.at;
}
/** Record that we offered setup, so we don't nag again even if the user declines. */
export function markSetupOffered(): void {
  if (!installState().at) writeState({});
}

// ---------- shell helper ----------

function run(exe: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(exe, args, { encoding: 'utf8', input });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

// ---------- Windows ----------

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function winSchedulerInstall(): StepResult {
  const tr = `"${nodeExe()}" "${entryScript()}" keep-alive`;
  const r = run('schtasks', [
    '/Create', '/F', '/SC', 'HOURLY', '/MO', String(KEEPALIVE_INTERVAL_HOURS), '/TN', TASK_ID, '/TR', tr,
  ]);
  return { name: 'Auto keep-alive (Task Scheduler)', ok: r.ok, detail: r.ok ? `every ${KEEPALIVE_INTERVAL_HOURS}h` : r.err || 'schtasks failed (try an elevated terminal)' };
}
function winSchedulerUninstall(): StepResult {
  const r = run('schtasks', ['/Delete', '/F', '/TN', TASK_ID]);
  return { name: 'Auto keep-alive (Task Scheduler)', ok: true, detail: r.ok ? 'removed' : 'was not installed' };
}
function winShortcutsInstall(): StepResult {
  const { exe, args, cwd } = launcherCommand();
  const target = args.length ? exe : exe; // TargetPath
  const argLine = args.map((a) => `"${a}"`).join(' ');
  const script = [
    `$W = New-Object -ComObject WScript.Shell`,
    `$dirs = @($W.SpecialFolders.Item('Desktop'), $W.SpecialFolders.Item('Programs'))`,
    `foreach ($d in $dirs) {`,
    `  if (-not $d) { continue }`,
    `  $old = Join-Path $d ${psQuote(LEGACY_APP_NAME + '.lnk')}`,
    `  if (Test-Path $old) { Remove-Item -Force $old }`,
    `  $lnk = Join-Path $d ${psQuote(APP_NAME + '.lnk')}`,
    `  $s = $W.CreateShortcut($lnk)`,
    `  $s.TargetPath = ${psQuote(target)}`,
    argLine ? `  $s.Arguments = ${psQuote(argLine)}` : `  $s.Arguments = ''`,
    `  $s.WorkingDirectory = ${psQuote(cwd)}`,
    `  $s.Description = ${psQuote(APP_NAME)}`,
    `  $s.Save()`,
    `}`,
  ].join('\n');
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return { name: 'Desktop + Start-menu shortcut', ok: r.ok, detail: r.ok ? 'created' : r.err || 'PowerShell failed' };
}
function winShortcutsUninstall(): StepResult {
  const script = [
    `$W = New-Object -ComObject WScript.Shell`,
    `foreach ($d in @($W.SpecialFolders.Item('Desktop'), $W.SpecialFolders.Item('Programs'))) {`,
    `  if (-not $d) { continue }`,
    `  foreach ($name in @(${psQuote(APP_NAME + '.lnk')}, ${psQuote(LEGACY_APP_NAME + '.lnk')})) {`,
    `    $lnk = Join-Path $d $name`,
    `    if (Test-Path $lnk) { Remove-Item -Force $lnk }`,
    `  }`,
    `}`,
  ].join('\n');
  run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return { name: 'Desktop + Start-menu shortcut', ok: true, detail: 'removed' };
}

// ---------- macOS ----------

function macPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${TASK_ID}.plist`);
}
function macSchedulerInstall(): StepResult {
  const plist = macPlistPath();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${TASK_ID}</string>
  <key>ProgramArguments</key>
  <array><string>${nodeExe()}</string><string>${entryScript()}</string><string>keep-alive</string></array>
  <key>StartInterval</key><integer>${KEEPALIVE_INTERVAL_HOURS * 3600}</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>\n`;
  try {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, xml, 'utf8');
    run('launchctl', ['unload', plist]); // ignore if not loaded
    const r = run('launchctl', ['load', '-w', plist]);
    return { name: 'Auto keep-alive (launchd)', ok: r.ok, detail: r.ok ? `every ${KEEPALIVE_INTERVAL_HOURS}h` : r.err || 'launchctl load failed' };
  } catch (e) {
    return { name: 'Auto keep-alive (launchd)', ok: false, detail: (e as Error).message };
  }
}
function macSchedulerUninstall(): StepResult {
  const plist = macPlistPath();
  run('launchctl', ['unload', '-w', plist]);
  try {
    if (fs.existsSync(plist)) fs.unlinkSync(plist);
  } catch {
    /* ignore */
  }
  return { name: 'Auto keep-alive (launchd)', ok: true, detail: 'removed' };
}
function macCommandPath(): string {
  return path.join(os.homedir(), 'Desktop', `${APP_NAME}.command`);
}
function macShortcutsInstall(): StepResult {
  const { exe, args, cwd } = launcherCommand();
  const cmd = macCommandPath();
  const body = `#!/bin/bash\ncd ${JSON.stringify(cwd)}\n${JSON.stringify(exe)} ${args.map((a) => JSON.stringify(a)).join(' ')}\n`;
  try {
    fs.rmSync(path.join(os.homedir(), 'Desktop', `${LEGACY_APP_NAME}.command`), { force: true });
    fs.writeFileSync(cmd, body, { mode: 0o755 });
    fs.chmodSync(cmd, 0o755);
    return { name: 'Desktop launcher (.command)', ok: true, detail: 'created' };
  } catch (e) {
    return { name: 'Desktop launcher (.command)', ok: false, detail: (e as Error).message };
  }
}
function macShortcutsUninstall(): StepResult {
  try {
    if (fs.existsSync(macCommandPath())) fs.unlinkSync(macCommandPath());
    fs.rmSync(path.join(os.homedir(), 'Desktop', `${LEGACY_APP_NAME}.command`), { force: true });
  } catch {
    /* ignore */
  }
  return { name: 'Desktop launcher (.command)', ok: true, detail: 'removed' };
}

// ---------- Linux ----------

const CRON_MARKER = `# ${TASK_ID}`;
function linuxCurrentCrontab(): string {
  const r = run('crontab', ['-l']);
  return r.ok ? r.out : '';
}
function linuxSchedulerInstall(): StepResult {
  const lines = linuxCurrentCrontab().split('\n').filter((l) => l && !l.includes(CRON_MARKER));
  // Every 6h at minute 0 (0,6,12,18).
  const hours = Array.from({ length: 24 / KEEPALIVE_INTERVAL_HOURS }, (_, i) => i * KEEPALIVE_INTERVAL_HOURS).join(',');
  lines.push(`0 ${hours} * * * "${nodeExe()}" "${entryScript()}" keep-alive ${CRON_MARKER}`);
  const r = run('crontab', ['-'], lines.join('\n') + '\n');
  return { name: 'Auto keep-alive (cron)', ok: r.ok, detail: r.ok ? `every ${KEEPALIVE_INTERVAL_HOURS}h` : r.err || 'crontab failed (is cron installed?)' };
}
function linuxSchedulerUninstall(): StepResult {
  const lines = linuxCurrentCrontab().split('\n').filter((l) => l && !l.includes(CRON_MARKER));
  run('crontab', ['-'], lines.length ? lines.join('\n') + '\n' : '\n');
  return { name: 'Auto keep-alive (cron)', ok: true, detail: 'removed' };
}
function linuxDesktopFiles(appName = APP_NAME): string[] {
  return [
    path.join(os.homedir(), '.local', 'share', 'applications', `${TASK_ID}.desktop`),
    path.join(os.homedir(), 'Desktop', `${appName}.desktop`),
  ];
}
function linuxShortcutsInstall(): StepResult {
  const { exe, args, cwd } = launcherCommand();
  const execLine = [exe, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  const content = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Switch between Claude Code and Codex accounts
Exec=${execLine}
Path=${cwd}
Terminal=true
Categories=Utility;Development;
`;
  let ok = false;
  fs.rmSync(path.join(os.homedir(), 'Desktop', `${LEGACY_APP_NAME}.desktop`), { force: true });
  for (const f of linuxDesktopFiles()) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content, { mode: 0o755 });
      fs.chmodSync(f, 0o755);
      ok = true;
    } catch {
      /* try the next location */
    }
  }
  return { name: 'App menu + Desktop shortcut (.desktop)', ok, detail: ok ? 'created' : 'could not write .desktop files' };
}
function linuxShortcutsUninstall(): StepResult {
  for (const f of [...linuxDesktopFiles(), path.join(os.homedir(), 'Desktop', `${LEGACY_APP_NAME}.desktop`)]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  return { name: 'App menu + Desktop shortcut (.desktop)', ok: true, detail: 'removed' };
}

// ---------- platform dispatch ----------

function schedulerInstall(): StepResult {
  if (process.platform === 'win32') return winSchedulerInstall();
  if (process.platform === 'darwin') return macSchedulerInstall();
  return linuxSchedulerInstall();
}
function schedulerUninstall(): StepResult {
  if (process.platform === 'win32') return winSchedulerUninstall();
  if (process.platform === 'darwin') return macSchedulerUninstall();
  return linuxSchedulerUninstall();
}
function shortcutsInstall(): StepResult {
  if (process.platform === 'win32') return winShortcutsInstall();
  if (process.platform === 'darwin') return macShortcutsInstall();
  return linuxShortcutsInstall();
}
function shortcutsUninstall(): StepResult {
  if (process.platform === 'win32') return winShortcutsUninstall();
  if (process.platform === 'darwin') return macShortcutsUninstall();
  return linuxShortcutsUninstall();
}

/** Install everything: recurring keep-alive + shortcuts. Returns a per-step report. */
export function installAll(): InstallReport {
  const steps = [schedulerInstall(), shortcutsInstall()];
  writeState({ scheduler: steps[0].ok, shortcuts: steps[1].ok });
  logger.info('installer: installAll', { steps: steps.map((s) => `${s.name}:${s.ok}`) });
  return { steps };
}

/** Remove everything we installed. */
export function uninstallAll(): InstallReport {
  const steps = [schedulerUninstall(), shortcutsUninstall()];
  writeState({ scheduler: false, shortcuts: false });
  logger.info('installer: uninstallAll');
  return { steps };
}

/** Install only the recurring keep-alive job (no shortcuts). */
export function schedulerOnlyInstall(): StepResult {
  const s = schedulerInstall();
  writeState({ scheduler: s.ok });
  return s;
}
export function schedulerOnlyUninstall(): StepResult {
  const s = schedulerUninstall();
  writeState({ scheduler: false });
  return s;
}
