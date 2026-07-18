// Resolves all filesystem locations, honoring CLAUDE_CONFIG_DIR and platform quirks.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Directory Claude Code uses for its config (~/.claude by default). */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.claude');
}

/**
 * Path to the big config file holding `oauthAccount` + `userID`.
 * Default install: ~/.claude.json (next to ~/.claude). When CLAUDE_CONFIG_DIR is
 * set, Claude keeps it inside that dir as .claude.json.
 */
export function claudeJsonPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) {
    return path.join(override.trim(), '.claude.json');
  }
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Official Claude Code credential file holding `claudeAiOauth` (+ mcpOAuth).
 * Windows and Linux always use the dotted name, including under CLAUDE_CONFIG_DIR.
 * An undotted sibling can be left behind by older third-party tooling; it is not a
 * second provider store and must never redirect or block live authentication.
 */
export function credentialsPath(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

/** Unsupported undotted sibling retained only for non-destructive diagnostics. */
export function undottedClaudeCredentialsPath(): string {
  return path.join(claudeConfigDir(), 'credentials.json');
}

/** The switcher's own data home (profiles, backups, logs, import/export). */
export function dataDir(): string {
  const override = process.env.CLAUDE_SWITCH_HOME;
  return override && override.trim() ? override.trim() : path.join(os.homedir(), '.claude-switch');
}

/** Codex's shared local state. Only auth.json is switched; config/history stay shared. */
export function codexHome(): string {
  const override = process.env.CODEX_HOME;
  return override && override.trim() ? override.trim() : path.join(os.homedir(), '.codex');
}

export function codexAuthPath(home = codexHome()): string {
  return path.join(home, 'auth.json');
}

export function codexProfilesPath(): string {
  return path.join(dataDir(), 'codex-profiles.json');
}

export function codexCredentialsRoot(): string {
  return path.join(dataDir(), 'credentials', 'codex');
}

export function claudeCredentialsRoot(): string {
  return path.join(dataDir(), 'credentials', 'claude');
}

export function claudeProfileCredentialsPath(profileId: string): string {
  return path.join(claudeCredentialsRoot(), profileId, 'credentials.json');
}

export function codexProfileHome(profileId: string): string {
  return path.join(codexCredentialsRoot(), profileId);
}
export function profilesPath(): string {
  return path.join(dataDir(), 'profiles.json');
}
export function backupsDir(): string {
  return path.join(dataDir(), 'backups');
}
export function logFile(): string {
  return path.join(dataDir(), 'logs', 'switch.log');
}
export function importDir(): string {
  return path.join(dataDir(), 'import');
}
export function exportDir(): string {
  return path.join(dataDir(), 'exports');
}

/** Where the switcher stores captured Claude Desktop session bundles (one subdir per profile). */
export function desktopStoreDir(): string {
  return path.join(dataDir(), 'desktop');
}

/**
 * Claude Desktop's own userData directory (its session/config lives here — a
 * different structure from Claude Code CLI). Tries the classic name first, then
 * the newer "-3p" build.
 */
export function desktopUserDataDir(): string | null {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
        : path.join(os.homedir(), '.config');
  const candidates = ['Claude', 'Claude-3p']
    .map((name) => path.join(base, name))
    .filter((dir) => fs.existsSync(dir));
  if (candidates.length < 2) return candidates[0] ?? null;
  const plausible = candidates.filter((dir) => DESKTOP_BUNDLE_ENTRIES.some((entry) => fs.existsSync(path.join(dir, entry))));
  if (plausible.length === 1) return plausible[0];
  throw new Error(`Ambiguous Claude Desktop data stores: ${candidates.join(' and ')}. Close Desktop and remove/rename the stale store before capture or switching.`);
}

/**
 * The session-identifying entries inside Desktop's userData dir that we snapshot/restore
 * as one bundle. Everything else (logs, MCP config, window position, telemetry id) is
 * left untouched.
 */
export const DESKTOP_BUNDLE_ENTRIES = [
  'config.json',
  'Local State',
  path.join('Network', 'Cookies'),
  path.join('Network', 'Cookies-journal'),
  'Local Storage',
  'Session Storage',
  'IndexedDB',
] as const;

export function ensureDataDirs(): void {
  fs.mkdirSync(path.join(dataDir(), 'logs'), { recursive: true });
  fs.mkdirSync(backupsDir(), { recursive: true });
  fs.mkdirSync(importDir(), { recursive: true });
  fs.mkdirSync(exportDir(), { recursive: true });
  fs.mkdirSync(desktopStoreDir(), { recursive: true });
  fs.mkdirSync(claudeCredentialsRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexCredentialsRoot(), { recursive: true, mode: 0o700 });
}

/** Locate the `claude` executable for version detection / identity priming. */
export function findClaudeExe(): string {
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', bin),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', bin),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return bin; // rely on PATH
}
