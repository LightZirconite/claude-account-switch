// Append-only logger. Secrets and URL query values are recursively redacted.
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from './atomicFile';
import { logFile } from './paths';

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_REDACTION_DEPTH = 10;
const SECRET_KEY = /token|secret|password|verifier|authorization|bearer|credential|private.?key|api.?key|cookie/i;
const DIRECT_SECRET_KEY = /^(?:access|refresh|code|state)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const KNOWN_TOKEN = /\b(?:sk-ant-|sk-|pha_|phr_)[A-Za-z0-9._-]+\b/gi;
const JWT = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g;
const LONG_SECRET = /\b[A-Za-z0-9_-]{40,}\b/g;
const SECRET_ASSIGNMENT = /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier|code|state)=([^&\s]+)/gi;
const JSON_SECRET_ASSIGNMENT = /((?:\\?")(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier|authorization|code|state)(?:\\?")\s*:\s*(?:\\?"))(.*?)(\\?")/gi;

function redactedSecret(value: unknown): string {
  if (typeof value === 'string') return `<redacted len=${value.length}>`;
  if (Buffer.isBuffer(value)) return `<redacted len=${value.length}>`;
  return '<redacted>';
}

function redactUrl(raw: string): string {
  const trailingMatch = raw.match(/[),.;\]]+$/);
  const trailing = trailingMatch?.[0] ?? '';
  const core = trailing ? raw.slice(0, -trailing.length) : raw;
  const queryAt = core.indexOf('?');
  const fragmentAt = core.indexOf('#');
  const candidates = [queryAt, fragmentAt].filter((index) => index >= 0);
  if (!candidates.length) return raw;
  const cut = Math.min(...candidates);
  const marker = queryAt >= 0 && queryAt === cut ? '?<redacted>' : '#<redacted>';
  return `${core.slice(0, cut)}${marker}${trailing}`;
}

function redactString(value: string): string {
  const exactSecret = /^(?:sk-ant-|sk-|pha_|phr_)/i.test(value)
    || /^[A-Za-z0-9_-]{40,}$/.test(value)
    || /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/.test(value);
  if (exactSecret) return redactedSecret(value);
  return value
    .replace(URL_PATTERN, redactUrl)
    .replace(BEARER, (match) => `Bearer ${redactedSecret(match.slice(7))}`)
    .replace(KNOWN_TOKEN, (match) => redactedSecret(match))
    .replace(JWT, (match) => redactedSecret(match))
    .replace(LONG_SECRET, (match) => redactedSecret(match))
    .replace(JSON_SECRET_ASSIGNMENT, (_match, prefix: string, secret: string, suffix: string) => `${prefix}${redactedSecret(secret)}${suffix}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string, secret: string) => `${key}=${redactedSecret(secret)}`);
}

function isSecretKey(key: string, value: unknown): boolean {
  return SECRET_KEY.test(key) || (DIRECT_SECRET_KEY.test(key) && typeof value === 'string');
}

function redactRecursive(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (Buffer.isBuffer(value)) return `<buffer len=${value.length}>`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactString(value.toString());
  if (depth >= MAX_REDACTION_DEPTH) return '<max-depth>';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '<circular>';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactRecursive(entry, seen, depth + 1));
    }
    if (value instanceof Error) {
      return redactRecursive({
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: value.cause,
      }, seen, depth + 1);
    }

    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      let entry: unknown;
      try {
        entry = (value as Record<string, unknown>)[key];
      } catch {
        out[key] = '<unavailable>';
        continue;
      }
      out[key] = isSecretKey(key, entry)
        ? redactedSecret(entry)
        : redactRecursive(entry, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Recursively redact secret fields, embedded tokens, and URL query/fragment values. */
export function redactValue(value: unknown): unknown {
  try {
    return redactRecursive(value, new WeakSet<object>(), 0);
  } catch {
    return '<unavailable>';
  }
}

/** Produce a single safe human-readable error line for persisted status/UI output. */
export function redactText(value: unknown): string {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : String(value);
  return redactString(text);
}

function redactObject(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return redactValue(details) as Record<string, unknown>;
}

type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, action: string, details?: Record<string, unknown>): void {
  try {
    const file = logFile();
    ensurePrivateDir(path.dirname(file));
    const safeAction = redactString(action);
    const safe = redactObject(details);
    const suffix = safe && Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
    const line = `${nowIso()} [${level}] ${safeAction}${suffix}\n`;

    // Replacing the entire log atomically would race other switcher processes. A single
    // O_APPEND write keeps each record intact while preserving append-only semantics.
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* logging must never crash the app */
  }
}

export const logger = {
  info: (action: string, details?: Record<string, unknown>) => write('INFO', action, details),
  warn: (action: string, details?: Record<string, unknown>) => write('WARN', action, details),
  error: (action: string, err?: unknown, details?: Record<string, unknown>) => {
    const errInfo = err != null ? redactValue(err) : undefined;
    write('ERROR', action, { ...details, ...(errInfo ? { error: errInfo } : {}) });
  },
};
