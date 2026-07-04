// Append-only logger. Tokens are always redacted (prefix + length only).
import fs from 'node:fs';
import { logFile, ensureDataDirs } from './paths';

function nowIso(): string {
  return new Date().toISOString();
}

/** Redact anything that looks like a secret token. */
export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (/^(sk-ant-|pha_|phr_)/.test(v) || /^[A-Za-z0-9_\-]{40,}$/.test(v)) {
      return `<redacted len=${v.length} prefix=${v.slice(0, 6)}>`;
    }
  }
  return v;
}

const SECRET_KEY = /token|secret|refresh|access|password|verifier|authorization|bearer|code_verifier/i;

function redactObject(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    out[k] = SECRET_KEY.test(k) ? redactValue(v) : v;
  }
  return out;
}

let initialized = false;
function ensure(): void {
  if (!initialized) {
    try {
      ensureDataDirs();
    } catch {
      /* ignore */
    }
    initialized = true;
  }
}

type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, action: string, details?: Record<string, unknown>): void {
  ensure();
  const safe = redactObject(details);
  const suffix = safe && Object.keys(safe).length ? ' ' + JSON.stringify(safe) : '';
  const line = `${nowIso()} [${level}] ${action}${suffix}\n`;
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    /* logging must never crash the app */
  }
}

export const logger = {
  info: (action: string, details?: Record<string, unknown>) => write('INFO', action, details),
  warn: (action: string, details?: Record<string, unknown>) => write('WARN', action, details),
  error: (action: string, err?: unknown, details?: Record<string, unknown>) => {
    const errInfo =
      err instanceof Error ? { message: err.message, stack: err.stack } : err != null ? { value: String(err) } : undefined;
    write('ERROR', action, { ...details, ...(errInfo ? { error: errInfo } : {}) });
  },
};
