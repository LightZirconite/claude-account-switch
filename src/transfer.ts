import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import {
  ensureDataDirs,
  exportDir,
  importDir,
  processedImportDir,
  providerImportDir,
} from './paths';
import type { ProviderId } from './types';

export interface ImportedProfileReceipt {
  id: string;
  label: string;
}

export interface ImportSourceDisposition {
  moved: string[];
  retained: string[];
  errors: string[];
  receiptPath: string | null;
}

function timestampSlug(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * Normalize one path pasted or dragged into a terminal. Explorer/PowerShell commonly
 * surrounds paths containing spaces with quotes or prefixes a quoted path with `&`.
 */
export function normalizeImportPath(raw: string): string {
  let value = raw.replace(/[\r\n\0]/g, '').trim();
  if (/^&\s+/.test(value)) value = value.replace(/^&\s+/, '').trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) value = value.slice(1, -1).trim();
  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Keep the original value so the caller can report a normal path-not-found error.
    }
  }
  return value;
}

/** Return the exact importable files represented by a file or top-level directory. */
export function discoverCodexImportFiles(target: string): string[] {
  const normalized = normalizeImportPath(target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return [];
  }
  if (stat.isFile()) return [path.resolve(normalized)];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(normalized, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:auth\.json|.+\.codexswitch\.json)$/i.test(entry.name))
    .map((entry) => path.resolve(normalized, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function managedInboxSource(provider: ProviderId, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  if (isInside(resolved, providerImportDir(provider))) return true;

  // Keep backward compatibility with the old shared inbox, but only for files placed
  // directly at its root. Never consume processed evidence or another provider's tree.
  const relative = path.relative(path.resolve(importDir()), resolved);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

function privateFileBestEffort(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function uniqueDestination(dir: string, basename: string): string {
  let target = path.join(dir, basename);
  if (!fs.existsSync(target)) return target;
  const extension = path.extname(basename);
  const stem = basename.slice(0, basename.length - extension.length);
  let index = 2;
  while (fs.existsSync(target)) target = path.join(dir, `${stem}-${index++}${extension}`);
  return target;
}

/**
 * Move only app-inbox sources after every represented account has committed. Arbitrary
 * files selected elsewhere are deliberately retained: importing must never silently
 * delete a USB/shared-folder/source-machine credential file.
 */
export function archiveImportedSources(
  provider: ProviderId,
  sources: string[],
  profiles: ImportedProfileReceipt[],
): ImportSourceDisposition {
  ensureDataDirs();
  const uniqueSources = [...new Set(sources.map((source) => path.resolve(source)))];
  const managed = uniqueSources.filter((source) => managedInboxSource(provider, source));
  const retained = uniqueSources.filter((source) => !managedInboxSource(provider, source));
  if (!managed.length) return { moved: [], retained, errors: [], receiptPath: null };

  const batchDir = path.join(processedImportDir(provider), `${timestampSlug()}-${crypto.randomUUID().slice(0, 8)}`);
  ensurePrivateDir(batchDir);
  const moved: string[] = [];
  const errors: string[] = [];
  const receiptSources: Array<{
    originalPath: string;
    archivedName: string;
    sha256: string;
  }> = [];

  for (const source of managed) {
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('source is not a regular, non-symbolic file');
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      const destination = uniqueDestination(batchDir, path.basename(source));
      fs.renameSync(source, destination);
      moved.push(destination);
      receiptSources.push({
        originalPath: source,
        archivedName: path.basename(destination),
        sha256,
      });
      try {
        privateFileBestEffort(destination);
      } catch (error) {
        errors.push(`${path.basename(destination)} permissions: ${String((error as Error).message ?? error)}`);
      }
    } catch (error) {
      retained.push(source);
      errors.push(`${path.basename(source)}: ${String((error as Error).message ?? error)}`);
    }
  }

  let receiptPath: string | null = null;
  if (moved.length) {
    receiptPath = path.join(batchDir, 'import-receipt.json');
    try {
      atomicWriteFile(receiptPath, `${JSON.stringify({
        kind: 'claude-codex-account-switch/import-receipt',
        version: 1,
        provider,
        importedAt: Date.now(),
        profiles: profiles.map(({ id, label }) => ({ id, label })),
        sources: receiptSources,
      }, null, 2)}\n`);
    } catch (error) {
      errors.push(`receipt: ${String((error as Error).message ?? error)}`);
      receiptPath = null;
    }
  }

  return { moved, retained: [...new Set(retained)], errors, receiptPath };
}

/** Timestamped exports never overwrite a prior recovery artifact. */
export function uniqueExportPath(stem: string, extension: string, now = new Date()): string {
  ensureDataDirs();
  const safeStem = stem.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 48) || 'accounts';
  const safeExtension = extension.startsWith('.') ? extension : `.${extension}`;
  const base = `${timestampSlug(now)}-${safeStem}`;
  let file = path.join(exportDir(), `${base}${safeExtension}`);
  let index = 2;
  while (fs.existsSync(file)) file = path.join(exportDir(), `${base}-${index++}${safeExtension}`);
  return file;
}

export function importDispositionSummary(disposition: ImportSourceDisposition): string {
  if (disposition.moved.length) {
    return disposition.errors.length
      ? `Imported; ${disposition.moved.length} inbox file(s) archived, ${disposition.errors.length} cleanup warning(s).`
      : `Imported; ${disposition.moved.length} inbox file(s) moved to processed evidence.`;
  }
  if (disposition.retained.length) return 'Imported; the externally selected source was left unchanged.';
  return 'Imported successfully.';
}
