// Cross-platform "make it feel like a real app" installer: a recurring keep-alive job
// (so saved access tokens are refreshed even with the UI closed) + Start-menu/Desktop shortcuts.
// Every step is best-effort and reported individually — one failure never aborts the rest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeConfigDir, codexAuthPath, codexHome, dataDir, ensureDataDirs } from './paths';
import { findCodexExe } from './codexAppServer';
import { configureCodexFileCredentialStore } from './codexConfig';
import { loadCodexStore } from './codexProfiles';
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

export interface RuntimeLocations {
  switchHome: string;
  claudeConfig: string;
  codexHome: string;
  codexBin?: string;
}

export interface LaunchAction {
  exe: string;
  args: string[];
  cwd: string;
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

/** Stable path flags embedded into every persisted launcher. */
export function buildRuntimePathArgs(locations: RuntimeLocations): string[] {
  const persistentPath = (label: string, value: string): string => {
    if (!value || /[\0\r\n]/u.test(value)) {
      throw new Error(`${label} must be a non-empty single-line filesystem path.`);
    }
    return path.resolve(value);
  };
  const args = [
    '--switch-home', persistentPath('Switch home', locations.switchHome),
    '--claude-config', persistentPath('Claude config', locations.claudeConfig),
    '--codex-home', persistentPath('Codex home', locations.codexHome),
  ];
  if (locations.codexBin?.trim()) args.push('--codex-bin', persistentPath('Codex executable', locations.codexBin.trim()));
  return args;
}

function usableExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve now, while the interactive installer still has the user's full PATH. */
function resolvedCodexExecutable(): string | null {
  const configured = findCodexExe().trim();
  if (!configured) return null;
  if (path.isAbsolute(configured) || /[\\/]/.test(configured)) {
    const absolute = path.resolve(configured);
    return usableExecutable(absolute) ? absolute : null;
  }

  const extensions = process.platform === 'win32'
    ? (path.extname(configured) ? [''] : ['.exe'])
    : [''];
  for (const segment of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = segment.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    for (const extension of extensions) {
      const absolute = path.resolve(directory, configured + extension);
      if (usableExecutable(absolute)) return absolute;
    }
  }
  return null;
}

function currentLocations(forScheduler: boolean): RuntimeLocations {
  const codexBin = resolvedCodexExecutable();
  if (forScheduler && !codexBin && loadCodexStore().profiles.length > 0) {
    throw new Error('Codex executable could not be resolved to an absolute file. Install Codex or set CODEX_BIN, then retry; no scheduled task was created.');
  }
  return {
    switchHome: dataDir(),
    claudeConfig: claudeConfigDir(),
    codexHome: codexHome(),
    codexBin: codexBin ?? undefined,
  };
}

export function buildSchedulerAction(input: {
  node: string;
  entry: string;
  cwd: string;
  locations: RuntimeLocations;
}): LaunchAction {
  return {
    exe: path.resolve(input.node),
    args: [path.resolve(input.entry), 'keep-alive', '--scheduler-runtime', ...buildRuntimePathArgs(input.locations)],
    cwd: path.resolve(input.cwd),
  };
}

export function buildLauncherAction(input: {
  node: string;
  entry: string;
  root: string;
  locations: RuntimeLocations;
}): LaunchAction {
  const runtimeArgs = buildRuntimePathArgs(input.locations);
  const root = path.resolve(input.root);
  // Persisted launchers execute Node directly. Routing custom paths through switch.cmd
  // would make cmd.exe reinterpret &, |, <, >, ^, %, and ! in otherwise valid paths.
  return { exe: path.resolve(input.node), args: [path.resolve(input.entry), ...runtimeArgs], cwd: root };
}

function schedulerAction(): LaunchAction {
  return buildSchedulerAction({
    node: nodeExe(),
    entry: entryScript(),
    cwd: projectRoot(),
    locations: currentLocations(true),
  });
}

/** The command a shortcut should launch to open the interactive switcher. */
function launcherCommand(): LaunchAction {
  const root = projectRoot();
  return buildLauncherAction({
    node: nodeExe(),
    entry: entryScript(),
    root,
    locations: currentLocations(false),
  });
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

function run(exe: string, args: string[], input?: string, cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(exe, args, { encoding: 'utf8', input, cwd, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

function schedulerProbe(action: LaunchAction): { ok: boolean; detail?: string } {
  const result = run(action.exe, [...action.args, '--scheduler-probe'], undefined, action.cwd);
  return { ok: result.ok, detail: result.ok ? result.out : result.err || 'registered scheduler action probe failed' };
}

function verifiedSchedulerDetail(action: LaunchAction): string {
  const providerScope = action.args.includes('--codex-bin')
    ? 'custom homes and pinned Codex binary verified'
    : 'custom homes and Claude-only provider scope verified';
  return `every ${KEEPALIVE_INTERVAL_HOURS}h; registered action, ${providerScope}`;
}

export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function desktopExecArgument(value: string): string {
  if (/[\r\n]/u.test(value)) throw new Error('Desktop launcher arguments cannot contain line breaks.');
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '%%')}"`;
}

function desktopEntryValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ---------- Windows ----------

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Quote one argv element according to the Windows CommandLineToArgvW rules. */
export function quoteWindowsArgument(value: string): string {
  if (value.length && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes++;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}

export function windowsArgumentLine(args: string[]): string {
  return args.map(quoteWindowsArgument).join(' ');
}

export function buildWindowsSchedulerRegistrationScript(action: LaunchAction): string {
  const triggerHours = Array.from(
    { length: 24 / KEEPALIVE_INTERVAL_HOURS },
    (_, index) => index * KEEPALIVE_INTERVAL_HOURS,
  );
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$action = New-ScheduledTaskAction -Execute ${psQuote(action.exe)} -Argument ${psQuote(windowsArgumentLine(action.args))} -WorkingDirectory ${psQuote(action.cwd)}`,
    `$triggers = @(${triggerHours.map((hour) => `New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(${hour}))`).join('; ')})`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew`,
    `Register-ScheduledTask -TaskName ${psQuote(TASK_ID)} -Action $action -Trigger $triggers -Settings $settings -Description ${psQuote(`${APP_NAME} provider-isolated keep-alive`)} -Force | Out-Null`,
  ].join('\n');
}

interface WindowsRegisteredAction {
  Execute?: string;
  Arguments?: string;
  WorkingDirectory?: string;
  TriggerCount?: number;
}

interface WindowsTaskSnapshot {
  existed: boolean;
  xmlBase64?: string;
}

function snapshotWindowsTask(): { ok: boolean; snapshot?: WindowsTaskSnapshot; detail?: string } {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$task = Get-ScheduledTask -TaskName ${psQuote(TASK_ID)} -ErrorAction SilentlyContinue`,
    `if ($task) { $xml = Export-ScheduledTask -TaskName ${psQuote(TASK_ID)}; '__PRESENT__:' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($xml)) } else { '__ABSENT__' }`,
  ].join('\n');
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!result.ok) return { ok: false, detail: result.err || 'could not snapshot the previous scheduled task' };
  if (result.out === '__ABSENT__') return { ok: true, snapshot: { existed: false } };
  if (result.out.startsWith('__PRESENT__:') && result.out.slice('__PRESENT__:'.length).trim()) {
    return { ok: true, snapshot: { existed: true, xmlBase64: result.out.slice('__PRESENT__:'.length).trim() } };
  }
  return { ok: false, detail: 'Task Scheduler returned an unreadable previous task definition.' };
}

function restoreWindowsTask(snapshot: WindowsTaskSnapshot): { ok: boolean; detail: string } {
  if (!snapshot.existed) {
    const script = [
      `$task = Get-ScheduledTask -TaskName ${psQuote(TASK_ID)} -ErrorAction SilentlyContinue`,
      `if ($task) { Unregister-ScheduledTask -TaskName ${psQuote(TASK_ID)} -Confirm:$false }`,
    ].join('\n');
    const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return { ok: result.ok, detail: result.ok ? 'new task removed' : result.err || 'new task removal failed' };
  }
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$encoded = [Console]::In.ReadToEnd().Trim()`,
    `$xml = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))`,
    `Register-ScheduledTask -TaskName ${psQuote(TASK_ID)} -Xml $xml -Force | Out-Null`,
  ].join('\n');
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], snapshot.xmlBase64 ?? '');
  return { ok: result.ok, detail: result.ok ? 'previous task restored' : result.err || 'previous task restore failed' };
}

function inspectWindowsRegisteredAction(): { ok: boolean; action?: WindowsRegisteredAction; detail?: string } {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$task = Get-ScheduledTask -TaskName ${psQuote(TASK_ID)}`,
    `$actions = @($task.Actions)`,
    `if ($actions.Count -ne 1) { throw "Expected exactly one registered action; found $($actions.Count)." }`,
    `[pscustomobject]@{ Execute = $actions[0].Execute; Arguments = $actions[0].Arguments; WorkingDirectory = $actions[0].WorkingDirectory; TriggerCount = @($task.Triggers).Count } | ConvertTo-Json -Compress`,
  ].join('\n');
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!result.ok) return { ok: false, detail: result.err || 'could not inspect the registered task action' };
  try {
    return { ok: true, action: JSON.parse(result.out) as WindowsRegisteredAction };
  } catch {
    return { ok: false, detail: 'Task Scheduler returned an unreadable action definition.' };
  }
}

function sameWindowsPath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function winSchedulerInstall(action: LaunchAction): StepResult {
  const previous = snapshotWindowsTask();
  if (!previous.ok || !previous.snapshot) {
    return { name: 'Auto keep-alive (Task Scheduler)', ok: false, detail: previous.detail };
  }
  const registered = run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command', buildWindowsSchedulerRegistrationScript(action),
  ]);
  const inspected = registered.ok ? inspectWindowsRegisteredAction() : { ok: false };
  const actionMatches = inspected.ok
    && sameWindowsPath(inspected.action?.Execute, action.exe)
    && inspected.action?.Arguments === windowsArgumentLine(action.args)
    && sameWindowsPath(inspected.action?.WorkingDirectory, action.cwd)
    && inspected.action?.TriggerCount === 24 / KEEPALIVE_INTERVAL_HOURS;
  const actualAction = actionMatches ? {
    exe: inspected.action!.Execute!,
    args: action.args,
    cwd: inspected.action!.WorkingDirectory!,
  } : null;
  const probe = actualAction ? schedulerProbe(actualAction) : { ok: false };
  const ok = registered.ok && actionMatches && probe.ok;
  const failure = !registered.ok
    ? registered.err || 'ScheduledTasks registration failed'
    : !inspected.ok
      ? inspected.detail
      : !actionMatches
        ? 'Task Scheduler changed the registered executable, arguments, working directory, or trigger count; installation was not accepted.'
        : probe.detail;
  const rollback = ok ? null : restoreWindowsTask(previous.snapshot);
  return {
    name: 'Auto keep-alive (Task Scheduler)',
    ok,
    detail: ok
      ? verifiedSchedulerDetail(actualAction!)
      : `${failure ?? 'scheduler verification failed'}; rollback: ${rollback!.detail}`,
  };
}
function winSchedulerUninstall(): StepResult {
  const script = [
    `$task = Get-ScheduledTask -TaskName ${psQuote(TASK_ID)} -ErrorAction SilentlyContinue`,
    `if ($task) { Unregister-ScheduledTask -TaskName ${psQuote(TASK_ID)} -Confirm:$false; 'removed' } else { 'absent' }`,
  ].join('\n');
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return {
    name: 'Auto keep-alive (Task Scheduler)',
    ok: result.ok,
    detail: result.ok ? (result.out.includes('removed') ? 'removed' : 'was not installed') : result.err || 'ScheduledTasks removal failed',
  };
}
function winShortcutsInstall(): StepResult {
  const { exe, args, cwd } = launcherCommand();
  const target = exe;
  const argLine = windowsArgumentLine(args);
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
function macSchedulerInstall(action: LaunchAction): StepResult {
  const plist = macPlistPath();
  let previous: string | null;
  try {
    previous = fs.existsSync(plist) ? fs.readFileSync(plist, 'utf8') : null;
  } catch (error) {
    return { name: 'Auto keep-alive (launchd)', ok: false, detail: `Could not snapshot the previous launchd action: ${String((error as Error).message ?? error)}` };
  }
  let changed = false;
  const fail = (detail: string): StepResult => {
    if (!changed) return { name: 'Auto keep-alive (launchd)', ok: false, detail };
    run('launchctl', ['unload', '-w', plist]);
    try {
      if (previous == null) {
        fs.rmSync(plist, { force: true });
        return { name: 'Auto keep-alive (launchd)', ok: false, detail: `${detail}; rollback: new action removed` };
      }
      fs.writeFileSync(plist, previous, 'utf8');
      const restored = run('launchctl', ['load', '-w', plist]);
      return {
        name: 'Auto keep-alive (launchd)',
        ok: false,
        detail: `${detail}; rollback: ${restored.ok ? 'previous action restored' : restored.err || 'previous action reload failed'}`,
      };
    } catch (error) {
      return { name: 'Auto keep-alive (launchd)', ok: false, detail: `${detail}; rollback failed: ${String((error as Error).message ?? error)}` };
    }
  };
  const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const programArgs = [action.exe, ...action.args].map((arg) => `<string>${xmlEscape(arg)}</string>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${TASK_ID}</string>
  <key>ProgramArguments</key>
  <array>${programArgs}</array>
  <key>WorkingDirectory</key><string>${xmlEscape(action.cwd)}</string>
  <key>StartInterval</key><integer>${KEEPALIVE_INTERVAL_HOURS * 3600}</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>\n`;
  try {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, xml, 'utf8');
    changed = true;
    run('launchctl', ['unload', plist]); // ignore if not loaded
    const loaded = run('launchctl', ['load', '-w', plist]);
    if (!loaded.ok) {
      return fail(loaded.err || 'launchctl load failed');
    }
    const inspected = run('plutil', ['-convert', 'json', '-o', '-', plist]);
    if (!inspected.ok) {
      return fail(inspected.err || 'could not inspect registered launchd action');
    }
    let actual: LaunchAction;
    try {
      const parsed = JSON.parse(inspected.out) as { ProgramArguments?: unknown; WorkingDirectory?: unknown };
      if (!Array.isArray(parsed.ProgramArguments) || !parsed.ProgramArguments.every((arg) => typeof arg === 'string')) {
        throw new Error('ProgramArguments is not a string array.');
      }
      if (parsed.ProgramArguments.length < 1 || typeof parsed.WorkingDirectory !== 'string') {
        throw new Error('The launchd action is incomplete.');
      }
      actual = {
        exe: parsed.ProgramArguments[0] as string,
        args: parsed.ProgramArguments.slice(1) as string[],
        cwd: parsed.WorkingDirectory,
      };
    } catch (error) {
      return fail(`Unreadable launchd action: ${String((error as Error).message ?? error)}`);
    }
    const actionMatches = actual.exe === action.exe
      && actual.cwd === action.cwd
      && JSON.stringify(actual.args) === JSON.stringify(action.args);
    if (!actionMatches) {
      return fail('launchd changed the registered executable, arguments, or working directory; installation was not accepted.');
    }
    const probe = schedulerProbe(actual);
    if (!probe.ok) return fail(probe.detail ?? 'registered launchd action probe failed');
    return {
      name: 'Auto keep-alive (launchd)',
      ok: true,
      detail: verifiedSchedulerDetail(actual),
    };
  } catch (e) {
    return fail((e as Error).message);
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
  const body = `#!/bin/bash\ncd -- ${posixShellQuote(cwd)} || exit 1\nexec ${posixShellQuote(exe)} ${args.map(posixShellQuote).join(' ')}\n`;
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
function linuxSchedulerInstall(action: LaunchAction): StepResult {
  const previous = linuxCurrentCrontab();
  const rollback = (detail: string): StepResult => {
    const restored = run('crontab', ['-'], previous ? `${previous}\n` : '\n');
    return {
      name: 'Auto keep-alive (cron)',
      ok: false,
      detail: `${detail}; rollback: ${restored.ok ? 'previous crontab restored' : restored.err || 'previous crontab restore failed'}`,
    };
  };
  const lines = previous.split('\n').filter((l) => l && !l.includes(CRON_MARKER));
  // Every 6h at minute 0 (0,6,12,18).
  const hours = Array.from({ length: 24 / KEEPALIVE_INTERVAL_HOURS }, (_, i) => i * KEEPALIVE_INTERVAL_HOURS).join(',');
  const command = `cd ${posixShellQuote(action.cwd)} && ${posixShellQuote(action.exe)} ${action.args.map(posixShellQuote).join(' ')}`;
  const registeredLine = `0 ${hours} * * * ${command} ${CRON_MARKER}`;
  lines.push(registeredLine);
  const r = run('crontab', ['-'], lines.join('\n') + '\n');
  if (!r.ok) return rollback(r.err || 'crontab failed (is cron installed?)');
  const installedLine = linuxCurrentCrontab().split('\n').find((line) => line.includes(CRON_MARKER));
  if (installedLine !== registeredLine) {
    return rollback('cron changed or omitted the registered action; installation was not accepted.');
  }
  const probe = schedulerProbe(action);
  if (!probe.ok) return rollback(probe.detail ?? 'registered cron action probe failed');
  return {
    name: 'Auto keep-alive (cron)',
    ok: true,
    detail: verifiedSchedulerDetail(action),
  };
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
  const execLine = [exe, ...args].map(desktopExecArgument).join(' ');
  const content = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Switch between Claude Code and Codex accounts
Exec=${execLine}
Path=${desktopEntryValue(cwd)}
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
  try {
    const action = schedulerAction();
    if (process.platform === 'win32') return winSchedulerInstall(action);
    if (process.platform === 'darwin') return macSchedulerInstall(action);
    return linuxSchedulerInstall(action);
  } catch (error) {
    const platformName = process.platform === 'win32' ? 'Task Scheduler' : process.platform === 'darwin' ? 'launchd' : 'cron';
    return {
      name: `Auto keep-alive (${platformName})`,
      ok: false,
      detail: String((error as Error).message ?? error),
    };
  }
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

function codexCredentialStoreInstall(): StepResult {
  const name = 'Codex deterministic auth.json store';
  try {
    const hasCodexAccountEvidence = loadCodexStore().profiles.length > 0 || fs.existsSync(codexAuthPath());
    if (!hasCodexAccountEvidence) {
      return { name, ok: true, detail: 'not needed yet (no saved or live Codex account)' };
    }
    const result = configureCodexFileCredentialStore();
    return {
      name,
      ok: true,
      detail: result.changed
        ? `configured from ${result.previous}${result.backupPath ? '; previous config backed up' : ''}`
        : 'already explicitly file-backed',
    };
  } catch (error) {
    return { name, ok: false, detail: String((error as Error).message ?? error) };
  }
}

/** Install everything: recurring keep-alive + shortcuts. Returns a per-step report. */
export function installAll(): InstallReport {
  const steps = [codexCredentialStoreInstall(), schedulerInstall(), shortcutsInstall()];
  writeState({ scheduler: steps[1].ok, shortcuts: steps[2].ok });
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
