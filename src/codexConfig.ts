import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import { withFileLockSync } from './locks';
import { logger } from './logger';
import { backupsDir, codexHome } from './paths';

export type CodexCredentialStorePrevious = 'missing' | 'file' | 'auto' | 'keyring' | 'other';

export interface CodexCredentialStoreProjection {
  content: string;
  changed: boolean;
  previous: CodexCredentialStorePrevious;
}

export interface CodexCredentialStoreConfiguration extends CodexCredentialStoreProjection {
  configPath: string;
  backupPath?: string;
}

const CREDENTIAL_KEY = 'cli_auth_credentials_store';
const ROOT_KEY = /^\s*(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=/;
const TABLE_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;

function tomlCommentStart(value: string): number {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote === 'double') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"') quote = 'double';
    else if (char === "'") quote = 'single';
    else if (char === '#') return index;
  }
  return -1;
}

function normalizedPrevious(value: string): CodexCredentialStorePrevious {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'file' || normalized === 'auto' || normalized === 'keyring') return normalized;
  return 'other';
}

/**
 * Project exactly one top-level Codex credential-store key without parsing or rewriting
 * unrelated TOML. Unknown/ambiguous syntax fails closed instead of risking user config.
 */
export function projectCodexFileCredentialStore(text: string): CodexCredentialStoreProjection {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = bom ? text.slice(1) : text;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = /(?:\r\n|\n)$/.test(source);
  const body = source.replace(/(?:\r\n|\n)$/, '');
  const lines = body ? body.split(/\r?\n/) : [];
  const firstTable = lines.findIndex((line) => TABLE_HEADER.test(line));
  const rootEnd = firstTable >= 0 ? firstTable : lines.length;
  const assignments = lines
    .slice(0, rootEnd)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => ROOT_KEY.test(line));

  if (assignments.length > 1) {
    throw new Error(`Codex config contains multiple top-level ${CREDENTIAL_KEY} assignments; nothing was changed.`);
  }

  let previous: CodexCredentialStorePrevious = 'missing';
  let changed = false;
  if (assignments.length === 1) {
    const assignment = assignments[0];
    const equalsAt = assignment.line.indexOf('=');
    const rhs = assignment.line.slice(equalsAt + 1);
    const commentAt = tomlCommentStart(rhs);
    const valueText = (commentAt >= 0 ? rhs.slice(0, commentAt) : rhs).trim();
    const quoted = valueText.match(/^(?:"([^"\\]*)"|'([^']*)')$/);
    if (!quoted) {
      throw new Error(`Codex ${CREDENTIAL_KEY} must be a quoted TOML string; nothing was changed.`);
    }
    const value = quoted[1] ?? quoted[2] ?? '';
    previous = normalizedPrevious(value);
    if (value !== 'file') {
      const indentation = assignment.line.match(/^\s*/)?.[0] ?? '';
      const comment = commentAt >= 0 ? rhs.slice(commentAt).trimStart() : '';
      lines[assignment.index] = `${indentation}${CREDENTIAL_KEY} = "file"${comment ? ` ${comment}` : ''}`;
      changed = true;
    }
  } else {
    let insertAt = rootEnd;
    while (insertAt > 0 && !lines[insertAt - 1].trim()) insertAt--;
    lines.splice(insertAt, 0, `${CREDENTIAL_KEY} = "file"`);
    changed = true;
  }

  const projectedBody = lines.join(eol);
  const content = `${bom}${projectedBody}${hasFinalNewline || !text ? eol : ''}`;
  return { content, changed, previous };
}

/** Atomically configure Codex for deterministic auth.json switching and retain a backup. */
export function configureCodexFileCredentialStore(home = codexHome()): CodexCredentialStoreConfiguration {
  return withFileLockSync('codex-config', () => {
    const configPath = path.join(home, 'config.toml');
    let original = '';
    let existed = false;
    try {
      original = fs.readFileSync(configPath, 'utf8');
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Codex config.toml could not be read; nothing was changed.', { cause: error });
      }
    }

    const projection = projectCodexFileCredentialStore(original);
    if (!projection.changed) return { ...projection, configPath };

    // Refuse to overwrite a provider/editor update that raced our projection.
    if (existed && fs.readFileSync(configPath, 'utf8') !== original) {
      throw new Error('Codex config.toml changed while setup was preparing; retry without losing either version.');
    }

    ensurePrivateDir(home);
    let backupPath: string | undefined;
    if (existed) {
      const backupRoot = path.join(backupsDir(), 'codex-config');
      ensurePrivateDir(backupRoot);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = path.join(backupRoot, `${stamp}-${crypto.randomUUID()}.toml`);
      atomicWriteFile(backupPath, original);
    }
    atomicWriteFile(configPath, projection.content);
    if (fs.readFileSync(configPath, 'utf8') !== projection.content) {
      throw new Error('Codex config.toml verification failed after atomic replacement.');
    }
    logger.info('codex config: explicit file credential store configured', {
      previous: projection.previous,
      backupCreated: !!backupPath,
    });
    return { ...projection, configPath, backupPath };
  });
}
