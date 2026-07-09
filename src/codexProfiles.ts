import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  backupsDir,
  codexAuthPath,
  codexCredentialsRoot,
  codexHome,
  codexProfileHome,
  codexProfilesPath,
  ensureDataDirs,
  exportDir,
  importDir,
} from './paths';
import { logger } from './logger';
import { withFileLock, withFileLockSync } from './locks';
import { inspectCodexHome, loginCodexHome, type CodexInspection } from './codexAppServer';
import type { CodexAuthFile, CodexProfile, CodexProfilesStore, CodexUsageInfo, ProfileTombstone } from './types';

const STORE_VERSION = 1;
let writeSeq = 0;

interface PortableCodexProfile {
  kind: 'claude-codex-account-switch/export';
  version: 2;
  provider: 'codex';
  exportedAt: number;
  label: string;
  email: string;
  accountId: string;
  planType?: string;
  auth: CodexAuthFile;
}

interface PortableCodexAll {
  kind: 'claude-codex-account-switch/export-all';
  version: 2;
  provider: 'codex';
  exportedAt: number;
  accounts: PortableCodexProfile[];
}

function emptyStore(): CodexProfilesStore {
  return { version: STORE_VERSION, revision: 0, activeProfileId: null, profiles: [], tombstones: [] };
}

function normalizeStore(value: unknown): CodexProfilesStore | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<CodexProfilesStore>;
  if (!Array.isArray(raw.profiles)) return null;
  const profiles = raw.profiles.filter((p): p is CodexProfile => {
    return !!p && p.provider === 'codex' && typeof p.id === 'string' && typeof p.accountId === 'string';
  });
  return {
    version: STORE_VERSION,
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : null,
    profiles,
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.filter((t) => t?.provider === 'codex') : [],
  };
}

function parseStore(text: string): CodexProfilesStore | null {
  try {
    return normalizeStore(JSON.parse(text));
  } catch {
    return null;
  }
}

function sidecarPath(): string {
  return `${codexProfilesPath()}.bak`;
}

function atomicWrite(target: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${writeSeq++}`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode });
  try {
    fs.renameSync(temp, target);
  } catch {
    fs.copyFileSync(temp, target);
    fs.rmSync(temp, { force: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(target, mode);
}

function readStoreFile(file: string): CodexProfilesStore | null {
  try {
    return parseStore(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadCodexStore(): CodexProfilesStore {
  const main = readStoreFile(codexProfilesPath());
  if (main) return main;
  const backup = readStoreFile(sidecarPath());
  if (backup) {
    logger.warn('codex profiles recovered from sidecar', { count: backup.profiles.length });
    saveCodexStore(backup);
    return backup;
  }
  return emptyStore();
}

function mergeTombstones(a: ProfileTombstone[], b: ProfileTombstone[]): ProfileTombstone[] {
  const map = new Map<string, ProfileTombstone>();
  for (const t of [...a, ...b]) {
    const previous = map.get(t.id);
    if (!previous || previous.deletedAt < t.deletedAt) map.set(t.id, t);
  }
  return [...map.values()];
}

function mergeStores(incoming: CodexProfilesStore, disk: CodexProfilesStore | null): CodexProfilesStore {
  if (!disk) return { ...incoming, revision: incoming.revision + 1 };
  const tombstones = mergeTombstones(disk.tombstones, incoming.tombstones);
  const deleted = new Set(tombstones.map((t) => t.id));
  const profiles = incoming.profiles.filter((p) => !deleted.has(p.id));
  for (const old of disk.profiles) {
    if (deleted.has(old.id)) continue;
    const current = profiles.find((p) => p.id === old.id || p.accountId === old.accountId);
    if (!current) {
      profiles.push(old);
      logger.warn('codex store prevented profile loss', { email: old.email });
      continue;
    }
    if ((old.usage?.fetchedAt ?? 0) > (current.usage?.fetchedAt ?? 0)) current.usage = old.usage;
    if ((old.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
      current.label = old.label;
      current.email = old.email;
      current.planType = old.planType;
      current.needsReauth = old.needsReauth;
      current.updatedAt = old.updatedAt;
    }
  }
  const activeProfileId = profiles.some((p) => p.id === incoming.activeProfileId)
    ? incoming.activeProfileId
    : profiles.some((p) => p.id === disk.activeProfileId)
      ? disk.activeProfileId
      : null;
  return {
    version: STORE_VERSION,
    revision: Math.max(incoming.revision, disk.revision) + 1,
    activeProfileId,
    profiles,
    tombstones,
  };
}

function snapshotStore(previousText: string): void {
  try {
    const dir = path.join(backupsDir(), 'codex-profiles');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    atomicWrite(path.join(dir, `profiles-${stamp}.json`), previousText);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    while (files.length > 40) fs.rmSync(path.join(dir, files.shift()!), { force: true });
  } catch {
    logger.warn('codex profile snapshot failed');
  }
}

export function saveCodexStore(store: CodexProfilesStore): CodexProfilesStore {
  return withFileLockSync('codex-profiles-store', () => {
    ensureDataDirs();
    let previousText: string | null = null;
    try {
      previousText = fs.readFileSync(codexProfilesPath(), 'utf8');
    } catch {
      /* first save */
    }
    const disk = previousText ? parseStore(previousText) : null;
    const merged = mergeStores(store, disk);
    const content = `${JSON.stringify(merged, null, 2)}\n`;
    if (previousText && previousText !== content) snapshotStore(previousText);
    atomicWrite(codexProfilesPath(), content);
    atomicWrite(sidecarPath(), content);
    Object.assign(store, merged);
    return store;
  });
}

export function mutateCodexStore(mutator: (store: CodexProfilesStore) => void): CodexProfilesStore {
  return withFileLockSync('codex-profiles-store', () => {
    const store = readStoreFile(codexProfilesPath()) ?? readStoreFile(sidecarPath()) ?? emptyStore();
    mutator(store);
    store.version = STORE_VERSION;
    store.revision++;
    const content = `${JSON.stringify(store, null, 2)}\n`;
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(codexProfilesPath(), 'utf8');
    } catch {
      /* first save */
    }
    if (previous && previous !== content) snapshotStore(previous);
    atomicWrite(codexProfilesPath(), content);
    atomicWrite(sidecarPath(), content);
    return store;
  });
}

export function readCodexAuth(home: string): CodexAuthFile | null {
  try {
    const value = JSON.parse(fs.readFileSync(codexAuthPath(home), 'utf8')) as CodexAuthFile;
    if (
      value?.auth_mode !== 'chatgpt'
      || !value.tokens
      || typeof value.tokens.account_id !== 'string'
      || !value.tokens.account_id.trim()
      || typeof value.tokens.access_token !== 'string'
      || typeof value.tokens.refresh_token !== 'string'
      || !value.tokens.refresh_token.trim()
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function metadataFromAuth(auth: CodexAuthFile): { accountId: string; email: string; planType?: string } {
  const idPayload = decodeJwt(auth.tokens.id_token);
  const accessPayload = decodeJwt(auth.tokens.access_token);
  const authClaims = accessPayload?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  return {
    accountId: auth.tokens.account_id,
    email: typeof idPayload?.email === 'string' ? idPayload.email : '(unknown ChatGPT account)',
    planType: typeof authClaims?.chatgpt_plan_type === 'string' ? authClaims.chatgpt_plan_type : undefined,
  };
}

function usageFromInspection(inspection: CodexInspection, previous?: CodexUsageInfo): CodexUsageInfo {
  const now = Date.now();
  const result = inspection.rateLimits;
  if (!result?.rateLimits) {
    return previous
      ? { ...previous, status: 'stale', error: 'Codex did not return rate limits.' }
      : { fetchedAt: now, status: 'error', error: 'Codex did not return rate limits.' };
  }
  return {
    fetchedAt: now,
    status: 'ok',
    bucket: result.rateLimits,
    buckets: result.rateLimitsByLimitId,
    resetCredits: result.rateLimitResetCredits?.availableCount ?? null,
  };
}

function writeProfileAuth(profileId: string, auth: CodexAuthFile): void {
  const home = codexProfileHome(profileId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  atomicWrite(codexAuthPath(home), `${JSON.stringify(auth, null, 2)}\n`);
}

export function writeCodexProfileAuth(profileId: string, auth: CodexAuthFile): void {
  writeProfileAuth(profileId, auth);
}

export function syncCodexProfileAuthFromHome(profileId: string, sourceHome: string): void {
  const auth = readCodexAuth(sourceHome);
  if (!auth) throw new Error('Source Codex auth.json is not a reusable ChatGPT login.');
  writeProfileAuth(profileId, auth);
}

function upsertAuth(
  auth: CodexAuthFile,
  inspection?: CodexInspection,
  label?: string,
): { store: CodexProfilesStore; profile: CodexProfile } {
  const meta = metadataFromAuth(auth);
  let selected!: CodexProfile;
  const store = mutateCodexStore((current) => {
    const existing = current.profiles.find((p) => p.accountId === meta.accountId);
    if (existing) {
      existing.email = inspection?.account?.email || meta.email;
      existing.planType = inspection?.account?.planType || meta.planType;
      if (label) existing.label = label;
      if (inspection?.account?.type === 'chatgpt') existing.needsReauth = false;
      existing.updatedAt = Date.now();
      if (inspection?.account?.type === 'chatgpt') existing.usage = usageFromInspection(inspection, existing.usage);
      selected = existing;
    } else {
      const id = crypto.randomUUID();
      selected = {
        id,
        provider: 'codex',
        accountId: meta.accountId,
        email: inspection?.account?.email || meta.email,
        label: label || inspection?.account?.email || meta.email,
        planType: inspection?.account?.planType || meta.planType,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        usage: inspection ? usageFromInspection(inspection) : undefined,
      };
      current.profiles.push(selected);
    }
    // Credentials are written while the store lock is held and before metadata is
    // committed. A disk error therefore cannot leave a profile row without auth.json.
    writeProfileAuth(selected.id, auth);
    current.tombstones = current.tombstones.filter((t) => t.id !== selected.id);
  });
  return { store, profile: selected };
}

export async function reconcileLiveCodex(
  forceTokenRefresh = false,
): Promise<{ store: CodexProfilesStore; profile: CodexProfile | null }> {
  let inspection: CodexInspection | undefined;
  try {
    inspection = await inspectCodexHome(codexHome(), forceTokenRefresh);
  } catch (e) {
    logger.warn('codex live inspection failed', { error: String(e) });
  }
  // Read after inspection because account/read(refreshToken=true) may rotate auth.json.
  const auth = readCodexAuth(codexHome());
  if (!auth) return { store: loadCodexStore(), profile: null };
  const result = upsertAuth(auth, inspection);
  result.store = mutateCodexStore((store) => {
    store.activeProfileId = result.profile.id;
    const profile = store.profiles.find((p) => p.id === result.profile.id);
    if (profile) profile.lastUsedAt = Date.now();
  });
  return result;
}

export async function addCodexAccount(onAuthUrl: (url: string) => void): Promise<{ store: CodexProfilesStore; profile: CodexProfile }> {
  ensureDataDirs();
  const tempId = `pending-${crypto.randomUUID()}`;
  const home = codexProfileHome(tempId);
  try {
    const inspection = await loginCodexHome(home, onAuthUrl);
    if (inspection.account?.type !== 'chatgpt') throw new Error('Only ChatGPT Codex accounts are supported.');
    const auth = readCodexAuth(home);
    if (!auth) throw new Error('Codex login completed without a reusable ChatGPT auth.json.');
    return upsertAuth(auth, inspection);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function refreshCodexProfile(profileId: string): Promise<CodexProfilesStore> {
  return withFileLock(`codex-account-${profileId}`, async () => {
    const profile = loadCodexStore().profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Codex profile not found.');
    try {
      // Officially force the managed ChatGPT refresh so the rotated auth.json is
      // durable inside this account envelope before the account lock is released.
      const inspection = await inspectCodexHome(codexProfileHome(profileId), true);
      if (inspection.account?.type !== 'chatgpt') throw new Error('ChatGPT login is no longer available.');
      return mutateCodexStore((store) => {
        const target = store.profiles.find((p) => p.id === profileId);
        if (!target) return;
        target.email = inspection.account?.email || target.email;
        target.planType = inspection.account?.planType || target.planType;
        target.usage = usageFromInspection(inspection, target.usage);
        target.needsReauth = false;
        target.updatedAt = Date.now();
      });
    } catch (e) {
      return mutateCodexStore((store) => {
        const target = store.profiles.find((p) => p.id === profileId);
        if (!target) return;
        if (/auth|login|unauthorized|401/i.test(String(e))) target.needsReauth = true;
        target.usage = target.usage
          ? { ...target.usage, status: 'stale', error: String(e) }
          : { fetchedAt: Date.now(), status: 'error', error: String(e) };
      });
    }
  });
}

export async function refreshAllCodexProfiles(
  options: { refreshLiveActive?: boolean } = {},
): Promise<CodexProfilesStore> {
  let store = loadCodexStore();
  let liveProfileId: string | null = null;
  try {
    const reconciled = await reconcileLiveCodex(options.refreshLiveActive ?? false);
    store = reconciled.store;
    liveProfileId = reconciled.profile?.id ?? null;
  } catch (e) {
    logger.warn('codex live account could not be reconciled before maintenance', { error: String(e) });
  }
  // The global live account is maintained through its own CODEX_HOME above. Refreshing
  // its isolated duplicate would create two owners for one rotating refresh-token chain.
  for (const profile of [...store.profiles]) {
    if (profile.id === liveProfileId) continue;
    store = await refreshCodexProfile(profile.id);
  }
  return store;
}

export function renameCodexProfile(id: string, label: string): CodexProfilesStore {
  return mutateCodexStore((store) => {
    const profile = store.profiles.find((p) => p.id === id);
    if (!profile) return;
    profile.label = label.trim() || profile.label;
    profile.updatedAt = Date.now();
  });
}

export function deleteCodexProfile(id: string): CodexProfilesStore {
  const store = mutateCodexStore((current) => {
    current.profiles = current.profiles.filter((p) => p.id !== id);
    current.tombstones = [...current.tombstones.filter((t) => t.id !== id), { id, provider: 'codex', deletedAt: Date.now() }];
    if (current.activeProfileId === id) current.activeProfileId = null;
  });
  try {
    const source = codexProfileHome(id);
    if (fs.existsSync(source)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destination = path.join(backupsDir(), 'codex-deleted', `${stamp}-${id}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.renameSync(source, destination);
    }
  } catch (e) {
    logger.warn('codex deleted credential backup failed', { error: String(e) });
  }
  return store;
}

export function setActiveCodexProfile(id: string): CodexProfilesStore {
  return mutateCodexStore((store) => {
    const profile = store.profiles.find((p) => p.id === id);
    if (!profile) return;
    profile.lastUsedAt = Date.now();
    profile.updatedAt = Date.now();
    store.activeProfileId = id;
  });
}

export function leastLoadedCodex(profiles: CodexProfile[]): CodexProfile | null {
  const scored = profiles
    .map((profile) => {
      const bucket = profile.usage?.bucket;
      const utilization = Math.max(bucket?.primary?.usedPercent ?? -1, bucket?.secondary?.usedPercent ?? -1);
      return { profile, utilization };
    })
    .filter((item) => item.utilization >= 0)
    .sort((a, b) => a.utilization - b.utilization);
  return scored[0]?.profile ?? null;
}

function portable(profile: CodexProfile): PortableCodexProfile {
  const auth = readCodexAuth(codexProfileHome(profile.id));
  if (!auth) throw new Error(`Codex credentials are missing for ${profile.label}.`);
  return {
    kind: 'claude-codex-account-switch/export',
    version: 2,
    provider: 'codex',
    exportedAt: Date.now(),
    label: profile.label,
    email: profile.email,
    accountId: profile.accountId,
    planType: profile.planType,
    auth,
  };
}

export function exportCodexProfile(profile: CodexProfile): string {
  ensureDataDirs();
  const safe = profile.label.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'codex-account';
  const file = path.join(exportDir(), `${safe}.codexswitch.json`);
  atomicWrite(file, `${JSON.stringify(portable(profile), null, 2)}\n`);
  return file;
}

export function exportAllCodexProfiles(store = loadCodexStore()): string {
  ensureDataDirs();
  const data: PortableCodexAll = {
    kind: 'claude-codex-account-switch/export-all',
    version: 2,
    provider: 'codex',
    exportedAt: Date.now(),
    accounts: store.profiles.map(portable),
  };
  const file = path.join(exportDir(), 'all-codex-accounts.codexswitch.json');
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function importRecord(record: PortableCodexProfile): CodexProfile {
  if (record.provider !== 'codex' || !record.auth) throw new Error('Not a Codex account export.');
  return upsertAuth(record.auth, undefined, record.label).profile;
}

export function importCodexFromPath(target: string): CodexProfile[] {
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).map((name) => path.join(target, name)).filter((file) => /(?:auth\.json|\.codexswitch\.json)$/i.test(file))
    : [target];
  const imported: CodexProfile[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PortableCodexProfile | PortableCodexAll | CodexAuthFile;
    if ((raw as PortableCodexAll).kind === 'claude-codex-account-switch/export-all') {
      for (const record of (raw as PortableCodexAll).accounts) imported.push(importRecord(record));
    } else if ((raw as PortableCodexProfile).kind === 'claude-codex-account-switch/export') {
      imported.push(importRecord(raw as PortableCodexProfile));
    } else {
      const auth = raw as CodexAuthFile;
      if (!auth.tokens?.account_id) throw new Error(`${file} is not a Codex auth export.`);
      imported.push(upsertAuth(auth).profile);
    }
  }
  return imported;
}

export function scanCodexImportDir(): string[] {
  ensureDataDirs();
  return fs.readdirSync(importDir())
    .filter((name) => /(?:auth\.json|\.codexswitch\.json)$/i.test(name))
    .map((name) => path.join(importDir(), name));
}

export function codexCredentialRootForDoctor(): string {
  return codexCredentialsRoot();
}
