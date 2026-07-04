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
 * Path to the credentials file holding `claudeAiOauth` (+ mcpOAuth).
 * Prefers the dotted `.credentials.json`; falls back to legacy `credentials.json`.
 */
export function credentialsPath(): string {
  const dir = claudeConfigDir();
  const dotted = path.join(dir, '.credentials.json');
  const plain = path.join(dir, 'credentials.json');
  if (fs.existsSync(dotted)) return dotted;
  if (fs.existsSync(plain)) return plain;
  return dotted; // default write target
}

/** The switcher's own data home (profiles, backups, logs, import/export). */
export function dataDir(): string {
  return path.join(os.homedir(), '.claude-switch');
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

export function ensureDataDirs(): void {
  fs.mkdirSync(path.join(dataDir(), 'logs'), { recursive: true });
  fs.mkdirSync(backupsDir(), { recursive: true });
  fs.mkdirSync(importDir(), { recursive: true });
  fs.mkdirSync(exportDir(), { recursive: true });
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
