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
import { logger, redactText } from './logger';
import { withFileLock, withFileLockSync } from './locks';
import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import {
  CodexAppServerShutdownError,
  claimCodexAppServerHome,
  clearCodexLoginHelperMarker,
  codexLoginHelperRecoveryState,
  inspectCodexHome,
  loginCodexHome,
  throwIfCodexLoginCancelled,
  withCodexAppServerHomeLockSync,
  writeCodexLoginHelperMarker,
  type CodexInspection,
} from './codexAppServer';
import {
  MIN_USABLE_HEADROOM_PERCENT,
  selectBestNow,
  type BestNowDecision,
} from './scheduling';
import { sanitizePlanType } from './providerMetadata';
import type { CodexAuthFile, CodexProfile, CodexProfilesStore, CodexUsageInfo, ProfileTombstone } from './types';

const STORE_VERSION = 1;
const ABANDONED_PENDING_AGE_MS = 15 * 60_000;

/**
 * Stable across metadata/profile recreation and opaque on disk. Every writer of a
 * managed ChatGPT refresh-token chain must use this exact lock name.
 */
export function codexCredentialLockName(accountId: string): string {
  const identity = crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 32);
  return `codex-account-${identity}`;
}

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
  const validProfile = (p: unknown): p is CodexProfile => {
    if (!p || typeof p !== 'object') return false;
    const candidate = p as Partial<CodexProfile>;
    return candidate.provider === 'codex'
      && typeof candidate.id === 'string' && !!candidate.id.trim()
      && typeof candidate.accountId === 'string' && !!candidate.accountId.trim()
      && typeof candidate.label === 'string'
      && typeof candidate.email === 'string'
      && typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt);
  };
  // A partially valid array is evidence of corruption, not permission to silently erase
  // the malformed rows on the next save.
  if (!raw.profiles.every(validProfile)) return null;
  const profiles = raw.profiles;
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length
    || new Set(profiles.map((profile) => profile.accountId)).size !== profiles.length) return null;
  if (raw.tombstones !== undefined && !Array.isArray(raw.tombstones)) return null;
  const tombstones = raw.tombstones ?? [];
  if (!tombstones.every((tombstone) => tombstone?.provider === 'codex'
    && typeof tombstone.id === 'string'
    && typeof tombstone.deletedAt === 'number'
    && Number.isFinite(tombstone.deletedAt))) return null;
  const requestedActiveId = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : null;
  return {
    version: STORE_VERSION,
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    activeProfileId: profiles.some((profile) => profile.id === requestedActiveId) ? requestedActiveId : null,
    profiles,
    tombstones,
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

function readStoreFile(file: string): CodexProfilesStore | null {
  try {
    const store = parseStore(fs.readFileSync(file, 'utf8'));
    if (!store) return null;
    filterArchivedProfiles(store);
    return store;
  } catch {
    return null;
  }
}

function readStoreFileUnfiltered(file: string): CodexProfilesStore | null {
  try {
    return parseStore(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function codexArchiveMarker(profileId: string): string {
  return path.join(codexProfileHome(profileId), '.archived.json');
}

function archiveMarkerTimestamp(profileId: string): number | null {
  const marker = codexArchiveMarker(profileId);
  try {
    const stat = fs.statSync(marker);
    let value: unknown;
    try {
      value = (JSON.parse(fs.readFileSync(marker, 'utf8')) as { archivedAt?: unknown }).archivedAt;
    } catch {
      /* A damaged marker is still an authoritative archive marker. */
    }
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : stat.mtimeMs || Date.now();
  } catch {
    return null;
  }
}

/**
 * A per-home archive marker is the last line of defence against an old sidecar,
 * snapshot, or stale writer resurrecting an intentionally archived account.
 */
function filterArchivedProfiles(store: CodexProfilesStore): number {
  const archived = store.profiles.flatMap((profile) => {
    const archivedAt = archiveMarkerTimestamp(profile.id);
    return archivedAt === null ? [] : [{ profile, archivedAt }];
  });
  if (!archived.length) return 0;

  const archivedIds = new Set(archived.map(({ profile }) => profile.id));
  for (const { profile, archivedAt } of archived) {
    const tombstone = store.tombstones.find((candidate) => candidate.provider === 'codex' && candidate.id === profile.id);
    if (tombstone) {
      tombstone.deletedAt = Math.max(tombstone.deletedAt, archivedAt);
      tombstone.restoredAt = undefined;
      tombstone.archivedProfile ??= { ...profile };
    } else {
      store.tombstones.push({
        id: profile.id,
        provider: 'codex',
        deletedAt: archivedAt,
        archivedProfile: { ...profile },
      });
    }
  }
  store.profiles = store.profiles.filter((profile) => !archivedIds.has(profile.id));
  if (store.activeProfileId && archivedIds.has(store.activeProfileId)) store.activeProfileId = null;
  return archived.length;
}

function assertCodexWorkerMutationDeadline(): void {
  const deadline = Number(process.env.CLAUDE_SWITCH_CODEX_MUTATION_DEADLINE_AT);
  if (Number.isFinite(deadline) && deadline > 0 && Date.now() >= deadline) {
    throw new Error('Codex switch transaction deadline elapsed before mutation.');
  }
}

function recoverOrphanedCredentialHomes(store: CodexProfilesStore): number {
  let recovered = 0;
  try {
    for (const entry of fs.readdirSync(codexCredentialsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('pending-')) continue;
      if (fs.existsSync(codexArchiveMarker(entry.name))) continue;
      const auth = readCodexAuth(path.join(codexCredentialsRoot(), entry.name));
      if (!auth || store.profiles.some((profile) => profile.id === entry.name || profile.accountId === auth.tokens.account_id)) continue;
      const deleted = store.tombstones.some((tombstone) => tombstone.provider === 'codex'
        && tombstone.archivedProfile?.provider === 'codex'
        && tombstone.archivedProfile.accountId === auth.tokens.account_id
        && (!tombstone.restoredAt || tombstone.deletedAt > tombstone.restoredAt));
      if (deleted) continue;
      const meta = metadataFromAuth(auth);
      store.profiles.push({
        id: entry.name,
        provider: 'codex',
        accountId: meta.accountId,
        email: meta.email,
        label: meta.email,
        planType: meta.planType,
        planObservedAt: meta.planType ? Date.now() : undefined,
        planSource: meta.planType ? 'oauth-token' : undefined,
        createdAt: fs.statSync(path.join(codexCredentialsRoot(), entry.name)).birthtimeMs || Date.now(),
        updatedAt: Date.now(),
        needsReauth: false,
      });
      recovered++;
    }
  } catch (error) {
    logger.warn('codex orphan credential scan failed', { error: String(error) });
  }
  return recovered;
}

function ensureArchiveMarkers(store: CodexProfilesStore): void {
  for (const tombstone of store.tombstones) {
    if (tombstone.provider !== 'codex' || tombstone.restoredAt && tombstone.restoredAt >= tombstone.deletedAt) continue;
    if (!fs.existsSync(codexAuthPath(codexProfileHome(tombstone.id))) || fs.existsSync(codexArchiveMarker(tombstone.id))) continue;
    try {
      atomicWriteFile(codexArchiveMarker(tombstone.id), `${JSON.stringify({
        kind: 'claude-codex-account-switch/codex-profile-archive',
        version: 1,
        profileId: tombstone.id,
        accountId: tombstone.archivedProfile?.provider === 'codex' ? tombstone.archivedProfile.accountId : undefined,
        archivedAt: tombstone.deletedAt,
      }, null, 2)}\n`);
    } catch (error) {
      logger.warn('codex archive marker migration failed', { profileId: tombstone.id, error: String(error) });
    }
  }
}

function snapshotsDir(): string {
  return path.join(backupsDir(), 'codex-profiles');
}

function newestSnapshot(): CodexProfilesStore | null {
  try {
    const files = fs.readdirSync(snapshotsDir())
      .filter((file) => file.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of files) {
      const store = readStoreFile(path.join(snapshotsDir(), file));
      if (store) return store;
    }
  } catch {
    /* none */
  }
  return null;
}

function readRecoverableStore(): { store: CodexProfilesStore | null; source: 'main' | 'sidecar' | 'snapshot' | 'none' } {
  const main = readStoreFile(codexProfilesPath());
  if (main) return { store: main, source: 'main' };
  const sidecar = readStoreFile(sidecarPath());
  if (sidecar) return { store: sidecar, source: 'sidecar' };
  const snapshot = newestSnapshot();
  if (snapshot) return { store: snapshot, source: 'snapshot' };
  return { store: null, source: 'none' };
}

function hasCodexEvidence(): boolean {
  for (const file of [codexProfilesPath(), sidecarPath()]) {
    try {
      if (fs.statSync(file).size > 0) return true;
    } catch {
      /* missing */
    }
  }
  try {
    return fs.readdirSync(codexCredentialsRoot(), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && !entry.name.startsWith('pending-'));
  } catch {
    return false;
  }
}

function quarantineCorruptStoreFiles(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const file of [codexProfilesPath(), sidecarPath()]) {
    try {
      if (!fs.existsSync(file) || readStoreFile(file)) continue;
      fs.renameSync(file, `${file}.corrupt-${stamp}`);
    } catch {
      /* recovery copy remains authoritative */
    }
  }
}

export function loadCodexStore(): CodexProfilesStore {
  const recovered = readRecoverableStore();
  if (recovered.store) {
    ensureArchiveMarkers(recovered.store);
    const orphanCount = recoverOrphanedCredentialHomes(recovered.store);
    if (recovered.source !== 'main') {
      quarantineCorruptStoreFiles();
      logger.warn(`codex profiles recovered from ${recovered.source}`, { count: recovered.store.profiles.length });
      saveCodexStore(recovered.store);
    } else if (orphanCount) {
      logger.warn('codex profiles recovered from orphaned credential homes', { count: orphanCount });
      saveCodexStore(recovered.store);
    }
    return recovered.store;
  }
  const emergency = emptyStore();
  const orphanCount = recoverOrphanedCredentialHomes(emergency);
  if (orphanCount) {
    return withFileLockSync('codex-profiles-store', () => {
      const rechecked = readRecoverableStore().store;
      if (rechecked) return rechecked;
      emergency.revision = 1;
      const content = `${JSON.stringify(emergency, null, 2)}\n`;
      quarantineCorruptStoreFiles();
      atomicWriteFile(codexProfilesPath(), content);
      atomicWriteFile(sidecarPath(), content);
      logger.warn('codex metadata rebuilt from durable credential homes', { count: orphanCount });
      return emergency;
    });
  }
  if (hasCodexEvidence()) logger.error('codex metadata is damaged; credentials were preserved and mutations will fail closed');
  return emptyStore();
}

export function listPendingCodexHomes(): Array<{ name: string; updatedAt: number }> {
  try {
    return fs.readdirSync(codexCredentialsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('pending-'))
      .map((entry) => {
        const source = path.join(codexCredentialsRoot(), entry.name);
        return { name: entry.name, updatedAt: fs.statSync(source).mtimeMs };
      });
  } catch {
    return [];
  }
}

/** Preserve abandoned login sandboxes for diagnostics instead of leaving them active. */
export function recoverAbandonedCodexHomes(minAgeMs = ABANDONED_PENDING_AGE_MS): string[] {
  ensureDataDirs();
  const recovered: string[] = [];
  for (const pending of listPendingCodexHomes()) {
    if (Date.now() - pending.updatedAt < minAgeMs) continue;
    const source = path.join(codexCredentialsRoot(), pending.name);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupsDir(), 'codex-abandoned', `${stamp}-${pending.name}`);
    try {
      withCodexAppServerHomeLockSync(source, () => {
        const helperState = codexLoginHelperRecoveryState(source);
        if (helperState === 'alive' || helperState === 'unproven') {
          logger.warn('codex abandoned login recovery deferred because helper shutdown is unproven', {
            name: pending.name,
            helperState,
          });
          return;
        }
        ensurePrivateDir(path.dirname(destination));
        fs.renameSync(source, destination);
        atomicWriteFile(path.join(destination, 'abandoned.json'), `${JSON.stringify({
          kind: 'claude-codex-account-switch/codex-abandoned-login',
          version: 1,
          archivedAt: Date.now(),
          reason: 'startup-recovery',
        }, null, 2)}\n`);
        recovered.push(destination);
      });
    } catch (error) {
      logger.warn('codex abandoned login recovery failed', { name: pending.name, error: String(error) });
    }
  }
  return recovered;
}

function archivePendingCodexHome(home: string, pendingName: string, reason: 'cancelled' | 'failed'): string | null {
  if (!fs.existsSync(home)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupsDir(), 'codex-abandoned', `${stamp}-${pendingName}`);
  try {
    return withCodexAppServerHomeLockSync(home, () => {
      const helperState = codexLoginHelperRecoveryState(home);
      if (helperState === 'alive' || helperState === 'unproven') {
        logger.warn('codex login sandbox archive deferred because helper shutdown is unproven', {
          pendingName,
          helperState,
        });
        return null;
      }
      ensurePrivateDir(path.dirname(destination));
      fs.renameSync(home, destination);
      atomicWriteFile(path.join(destination, 'abandoned.json'), `${JSON.stringify({
        kind: 'claude-codex-account-switch/codex-abandoned-login',
        version: 1,
        archivedAt: Date.now(),
        reason,
      }, null, 2)}\n`);
      logger.warn('codex login sandbox archived', { reason, destination });
      return destination;
    });
  } catch (error) {
    // Never delete the pending home as a fallback. Startup recovery can try again.
    logger.error('codex login sandbox could not be archived; pending home retained', error, { pendingName });
    return null;
  }
}

export type AbandonedCodexLoginReason = 'cancelled' | 'failed' | 'startup-recovery';

interface AbandonedCodexLoginManifest {
  kind: 'claude-codex-account-switch/codex-abandoned-login';
  version: 1;
  archivedAt: number;
  reason: AbandonedCodexLoginReason;
  recoveredAt?: number;
  recoveredProfileId?: string;
}

export interface AbandonedCodexLoginArchive {
  name: string;
  directory: string;
  manifestStatus: 'valid' | 'missing' | 'invalid';
  reason: AbandonedCodexLoginReason | null;
  archivedAt: number | null;
  recoveredAt: number | null;
  recoveredProfileId: string | null;
  authStatus: CodexAuthReadState['status'];
  accountId: string | null;
  recoverable: boolean;
}

function parseAbandonedCodexManifest(file: string): {
  status: AbandonedCodexLoginArchive['manifestStatus'];
  manifest: AbandonedCodexLoginManifest | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid',
      manifest: null,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid', manifest: null };
  const manifest = value as Partial<AbandonedCodexLoginManifest>;
  const reasons: AbandonedCodexLoginReason[] = ['cancelled', 'failed', 'startup-recovery'];
  const hasRecovery = manifest.recoveredAt !== undefined || manifest.recoveredProfileId !== undefined;
  if (manifest.kind !== 'claude-codex-account-switch/codex-abandoned-login'
    || manifest.version !== 1
    || typeof manifest.archivedAt !== 'number'
    || !Number.isFinite(manifest.archivedAt)
    || manifest.archivedAt <= 0
    || !reasons.includes(manifest.reason as AbandonedCodexLoginReason)
    || (hasRecovery && (typeof manifest.recoveredAt !== 'number'
      || !Number.isFinite(manifest.recoveredAt)
      || manifest.recoveredAt <= 0
      || typeof manifest.recoveredProfileId !== 'string'
      || !manifest.recoveredProfileId.trim()))) {
    return { status: 'invalid', manifest: null };
  }
  return { status: 'valid', manifest: manifest as AbandonedCodexLoginManifest };
}

/**
 * Inventory every preserved abandoned login directory. Invalid evidence remains visible
 * but fails closed: only a strict v1 manifest plus a validated ChatGPT auth.json can be
 * selected for explicit recovery.
 */
export function listAbandonedCodexLoginArchives(): AbandonedCodexLoginArchive[] {
  const root = path.join(backupsDir(), 'codex-abandoned');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Could not safely inspect preserved Codex abandoned-login archives.', { cause: error });
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry): AbandonedCodexLoginArchive => {
      const directory = path.join(root, entry.name);
      const parsed = parseAbandonedCodexManifest(path.join(directory, 'abandoned.json'));
      const auth = readCodexAuthState(directory);
      const recoveredAt = parsed.manifest?.recoveredAt ?? null;
      return {
        name: entry.name,
        directory,
        manifestStatus: parsed.status,
        reason: parsed.manifest?.reason ?? null,
        archivedAt: parsed.manifest?.archivedAt ?? null,
        recoveredAt,
        recoveredProfileId: parsed.manifest?.recoveredProfileId ?? null,
        authStatus: auth.status,
        accountId: auth.status === 'valid' ? auth.auth.tokens.account_id : null,
        recoverable: parsed.status === 'valid' && auth.status === 'valid' && recoveredAt === null,
      };
    })
    .sort((a, b) => (b.archivedAt ?? -1) - (a.archivedAt ?? -1) || b.name.localeCompare(a.name));
}

export interface AbandonedCodexLoginRecovery {
  store: CodexProfilesStore;
  profile: CodexProfile;
  archive: AbandonedCodexLoginArchive;
  archiveMarkedRecovered: boolean;
}

/**
 * Explicitly recover the newest strict abandoned login as a parked profile. The source
 * archive is never moved or deleted. Existing credentials win unless the normal portable
 * import CAS rules prove this archive is identical or belongs to a new account.
 */
export async function recoverLatestAbandonedCodexLogin(): Promise<AbandonedCodexLoginRecovery | null> {
  return withFileLock('codex-abandoned-recovery', async () => {
    const candidate = listAbandonedCodexLoginArchives().find((archive) => archive.recoverable);
    if (!candidate) return null;
    const observedState = readCodexAuthState(candidate.directory);
    if (observedState.status !== 'valid') {
      throw new Error('The selected abandoned Codex login changed before recovery. Nothing was imported.');
    }
    const accountId = observedState.auth.tokens.account_id;
    return withFileLock(codexCredentialLockName(accountId), async () => {
      const current = listAbandonedCodexLoginArchives()
        .find((archive) => archive.directory === candidate.directory);
      if (!current?.recoverable || current.accountId !== accountId
        || current.archivedAt === null || current.reason === null) {
        throw new Error('The selected abandoned Codex login changed while recovery was waiting. Nothing was imported.');
      }
      const latestState = readCodexAuthState(current.directory);
      if (latestState.status !== 'valid' || !sameCodexCredential(observedState.auth, latestState.auth)) {
        throw new Error('The selected abandoned Codex credentials changed while recovery was waiting. Nothing was imported.');
      }
      assertImportDoesNotDowngrade(latestState.auth);
      const recovered = upsertAuth(latestState.auth);
      let archiveMarkedRecovered = false;
      try {
        atomicWriteFile(path.join(current.directory, 'abandoned.json'), `${JSON.stringify({
          kind: 'claude-codex-account-switch/codex-abandoned-login',
          version: 1,
          archivedAt: current.archivedAt,
          reason: current.reason,
          recoveredAt: Date.now(),
          recoveredProfileId: recovered.profile.id,
        } satisfies AbandonedCodexLoginManifest, null, 2)}\n`);
        archiveMarkedRecovered = true;
      } catch (error) {
        // Canonical credentials and metadata have already committed. Keep the source
        // untouched and report the partial marker outcome instead of claiming failure.
        logger.warn('Codex abandoned login recovered but its evidence marker could not be updated', {
          directory: current.directory,
          profileId: recovered.profile.id,
          error: String(error),
        });
      }
      return {
        store: recovered.store,
        profile: recovered.profile,
        archive: current,
        archiveMarkedRecovered,
      };
    });
  });
}

function mergeTombstones(a: ProfileTombstone[], b: ProfileTombstone[]): ProfileTombstone[] {
  const map = new Map<string, ProfileTombstone>();
  for (const t of [...a, ...b]) {
    const previous = map.get(t.id);
    const previousEventAt = previous ? Math.max(previous.deletedAt, previous.restoredAt ?? 0) : 0;
    const eventAt = Math.max(t.deletedAt, t.restoredAt ?? 0);
    if (!previous || previousEventAt < eventAt
      || (previousEventAt === eventAt && (previous.restoredAt ?? 0) < (t.restoredAt ?? 0))) map.set(t.id, t);
  }
  return [...map.values()];
}

function mergeStores(incoming: CodexProfilesStore, disk: CodexProfilesStore | null): CodexProfilesStore {
  filterArchivedProfiles(incoming);
  if (!disk) return { ...incoming, revision: incoming.revision + 1 };
  const tombstones = mergeTombstones(disk.tombstones, incoming.tombstones);
  const deleted = new Set(tombstones
    .filter((t) => !t.restoredAt || t.deletedAt > t.restoredAt)
    .map((t) => t.id));
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
      current.planObservedAt = old.planObservedAt;
      current.planSource = old.planSource;
      current.needsReauth = old.needsReauth;
      current.updatedAt = old.updatedAt;
    }
  }
  const activeProfileId = profiles.some((p) => p.id === incoming.activeProfileId)
    ? incoming.activeProfileId
    : profiles.some((p) => p.id === disk.activeProfileId)
      ? disk.activeProfileId
      : null;
  const merged = {
    version: STORE_VERSION,
    revision: Math.max(incoming.revision, disk.revision) + 1,
    activeProfileId,
    profiles,
    tombstones,
  };
  filterArchivedProfiles(merged);
  return merged;
}

function snapshotStore(previousText: string): void {
  try {
    const dir = snapshotsDir();
    ensurePrivateDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    atomicWriteFile(path.join(dir, `profiles-${stamp}.json`), previousText);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    while (files.length > 40) fs.rmSync(path.join(dir, files.shift()!), { force: true });
  } catch {
    logger.warn('codex profile snapshot failed');
  }
}

function accountSetSignature(store: CodexProfilesStore): string {
  return JSON.stringify(store.profiles
    .map((profile) => [profile.id, profile.accountId, profile.label, profile.email])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function saveCodexStore(store: CodexProfilesStore): CodexProfilesStore {
  return withFileLockSync('codex-profiles-store', () => {
    assertCodexWorkerMutationDeadline();
    ensureDataDirs();
    let previousText: string | null = null;
    try {
      previousText = fs.readFileSync(codexProfilesPath(), 'utf8');
    } catch {
      /* first save */
    }
    const recovered = readRecoverableStore();
    const disk = recovered.store;
    if (!disk && hasCodexEvidence()) {
      throw new Error('Codex profile metadata is damaged and no safe snapshot could be recovered. Mutation aborted; auth homes remain untouched.');
    }
    const merged = mergeStores(store, disk);
    const content = `${JSON.stringify(merged, null, 2)}\n`;
    if (previousText) {
      const previousStore = parseStore(previousText);
      if (previousStore && accountSetSignature(previousStore) !== accountSetSignature(merged)) snapshotStore(previousText);
    }
    atomicWriteFile(codexProfilesPath(), content);
    atomicWriteFile(sidecarPath(), content);
    Object.assign(store, merged);
    return store;
  });
}

export function mutateCodexStore(mutator: (store: CodexProfilesStore) => void): CodexProfilesStore {
  return withFileLockSync('codex-profiles-store', () => {
    assertCodexWorkerMutationDeadline();
    ensureDataDirs();
    const recovered = readRecoverableStore();
    if (!recovered.store && hasCodexEvidence()) {
      throw new Error('Codex profile metadata is damaged and no safe snapshot could be recovered. Mutation aborted; auth homes remain untouched.');
    }
    const store = recovered.store ?? emptyStore();
    const beforeSignature = accountSetSignature(store);
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
    if (previous && beforeSignature !== accountSetSignature(store)) snapshotStore(previous);
    atomicWriteFile(codexProfilesPath(), content);
    atomicWriteFile(sidecarPath(), content);
    return store;
  });
}

export function validateCodexAuth(value: unknown): CodexAuthFile {
  if (!value || typeof value !== 'object') throw new Error('Codex auth must be a JSON object.');
  const auth = value as CodexAuthFile;
  if (auth.auth_mode !== 'chatgpt') throw new Error('Only reusable Codex ChatGPT credentials are supported.');
  const tokens = auth.tokens;
  for (const field of ['account_id', 'id_token', 'access_token', 'refresh_token'] as const) {
    if (typeof tokens?.[field] !== 'string' || !tokens[field].trim()) {
      throw new Error(`Codex auth is missing a non-empty tokens.${field}.`);
    }
  }
  const claimAccountIds = [auth.tokens.id_token, auth.tokens.access_token]
    .map(decodeJwt)
    .map((claims) => claims?.['https://api.openai.com/auth'])
    .filter((claims): claims is Record<string, unknown> => !!claims && typeof claims === 'object')
    .map((claims) => claims.chatgpt_account_id)
    .filter((accountId): accountId is string => typeof accountId === 'string' && !!accountId.trim());
  if (claimAccountIds.some((accountId) => accountId !== auth.tokens.account_id)) {
    throw new Error('Codex auth tokens do not match tokens.account_id.');
  }
  return auth;
}

export type CodexAuthReadState =
  | { status: 'missing' }
  | { status: 'valid'; auth: CodexAuthFile }
  | { status: 'corrupt'; error: Error };

export function readCodexAuthState(home: string): CodexAuthReadState {
  let text: string;
  try {
    text = fs.readFileSync(codexAuthPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'corrupt', error: new Error('Codex auth.json could not be read.', { cause: error }) };
  }
  try {
    return { status: 'valid', auth: validateCodexAuth(JSON.parse(text)) };
  } catch (error) {
    return {
      status: 'corrupt',
      error: new Error('Codex auth.json is malformed or not a reusable ChatGPT credential.', { cause: error }),
    };
  }
}

export function readCodexAuth(home: string): CodexAuthFile | null {
  const state = readCodexAuthState(home);
  return state.status === 'valid' ? state.auth : null;
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

function sameCodexCredential(a: CodexAuthFile, b: CodexAuthFile): boolean {
  return a.tokens.account_id === b.tokens.account_id
    && a.tokens.id_token === b.tokens.id_token
    && a.tokens.access_token === b.tokens.access_token
    && a.tokens.refresh_token === b.tokens.refresh_token;
}

function assertImportDoesNotDowngrade(auth: CodexAuthFile): void {
  const store = loadCodexStore();
  const existingProfile = store.profiles.find((profile) => profile.accountId === auth.tokens.account_id)
    ?? store.tombstones.find((tombstone) => tombstone.archivedProfile?.provider === 'codex'
      && tombstone.archivedProfile.accountId === auth.tokens.account_id)?.archivedProfile;
  if (!existingProfile || existingProfile.provider !== 'codex') return;
  const existingAuth = readCodexAuth(codexProfileHome(existingProfile.id));
  if (!existingAuth || sameCodexCredential(existingAuth, auth)) return;
  // JWT payloads and last_refresh in a portable file are attacker-controlled and are
  // not proof that a different rotating credential chain is newer. Existing logins may
  // only be replaced by the official add/re-login flow, which validates in isolation.
  throw new Error(
    'Refusing to replace an existing Codex login from an import. Re-authenticate that account through the official add flow instead.',
  );
}

function metadataFromAuth(auth: CodexAuthFile): { accountId: string; email: string; planType?: string } {
  const idPayload = decodeJwt(auth.tokens.id_token);
  const accessPayload = decodeJwt(auth.tokens.access_token);
  const authClaims = accessPayload?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  return {
    accountId: auth.tokens.account_id,
    email: typeof idPayload?.email === 'string' ? idPayload.email : '(unknown ChatGPT account)',
    planType: sanitizePlanType(
      typeof authClaims?.chatgpt_plan_type === 'string' ? authClaims.chatgpt_plan_type : undefined,
    ),
  };
}

export interface CodexPlanResolution {
  planType?: string;
  source?: CodexProfile['planSource'];
}

/**
 * Resolve the effective Codex entitlement without letting a lagging account/read
 * projection hide a newer plan returned by the quota backend. Stored metadata remains
 * a stronger fallback than the OAuth JWT because that JWT can predate a plan change.
 */
export function resolveCodexPlan(
  inspection?: Pick<CodexInspection, 'account' | 'rateLimits'>,
  previousPlan?: string,
  tokenPlan?: string,
): CodexPlanResolution {
  const directQuotaPlan = sanitizePlanType(inspection?.rateLimits?.rateLimits?.planType);
  const bucketPlans = Object.values(inspection?.rateLimits?.rateLimitsByLimitId ?? {});
  const primaryBucketPlan = sanitizePlanType(
    bucketPlans.find((bucket) => bucket.limitId === 'codex')?.planType
      ?? bucketPlans.find((bucket) => bucket.planType)?.planType,
  );
  const quotaPlan = directQuotaPlan ?? primaryBucketPlan;
  if (quotaPlan) return { planType: quotaPlan, source: 'codex-rate-limits' };

  const accountPlan = sanitizePlanType(inspection?.account?.planType);
  if (accountPlan) return { planType: accountPlan, source: 'codex-account' };

  const storedPlan = sanitizePlanType(previousPlan);
  if (storedPlan) return { planType: storedPlan };

  const oauthPlan = sanitizePlanType(tokenPlan);
  return oauthPlan ? { planType: oauthPlan, source: 'oauth-token' } : {};
}

function applyResolvedCodexPlan(
  profile: CodexProfile,
  inspection: Pick<CodexInspection, 'account' | 'rateLimits'> | undefined,
  tokenPlan?: string,
): void {
  const resolution = resolveCodexPlan(inspection, profile.planType, tokenPlan);
  if (!resolution.planType) return;
  profile.planType = resolution.planType;
  if (resolution.source) {
    profile.planSource = resolution.source;
    profile.planObservedAt = Date.now();
  }
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
    spendControlReached: result.spendControlReached ?? null,
  };
}

function writeProfileAuth(profileId: string, auth: CodexAuthFile): void {
  assertCodexWorkerMutationDeadline();
  validateCodexAuth(auth);
  const home = codexProfileHome(profileId);
  ensurePrivateDir(home);
  const leaseId = claimCodexAppServerHome(home);
  try {
    atomicWriteFile(codexAuthPath(home), `${JSON.stringify(auth, null, 2)}\n`);
  } finally {
    clearCodexLoginHelperMarker(home, leaseId);
  }
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
  options: { allowArchivedRestore?: boolean } = {},
): { store: CodexProfilesStore; profile: CodexProfile } {
  validateCodexAuth(auth);
  const meta = metadataFromAuth(auth);
  let selected!: CodexProfile;
  const store = mutateCodexStore((current) => {
    let existing = current.profiles.find((p) => p.accountId === meta.accountId);
    if (!existing) {
      const archived = current.tombstones.find((t) => t.provider === 'codex'
        && t.archivedProfile?.provider === 'codex'
        && t.archivedProfile.accountId === meta.accountId
        && (!t.restoredAt || t.deletedAt > t.restoredAt));
      if (archived?.archivedProfile?.provider === 'codex') {
        if (!options.allowArchivedRestore) {
          throw new Error('This Codex account is archived. Restore it explicitly with z before replacing its credentials.');
        }
        existing = { ...archived.archivedProfile };
        current.profiles.push(existing);
        archived.restoredAt = Date.now();
      }
    }
    if (existing) {
      existing.email = inspection?.account?.email || meta.email;
      applyResolvedCodexPlan(existing, inspection, meta.planType);
      if (label) existing.label = label;
      // readCodexAuth already proves that this is a managed ChatGPT credential.
      // account/read metadata can lag the completed login notification.
      existing.needsReauth = false;
      existing.updatedAt = Date.now();
      if (inspection) existing.usage = usageFromInspection(inspection, existing.usage);
      selected = existing;
    } else {
      const id = crypto.randomUUID();
      selected = {
        id,
        provider: 'codex',
        accountId: meta.accountId,
        email: inspection?.account?.email || meta.email,
        label: label || inspection?.account?.email || meta.email,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        needsReauth: false,
        usage: inspection ? usageFromInspection(inspection) : undefined,
      };
      applyResolvedCodexPlan(selected, inspection, meta.planType);
      current.profiles.push(selected);
    }
    // Credentials are written while the store lock is held and before metadata is
    // committed. A disk error therefore cannot leave a profile row without auth.json.
    writeProfileAuth(selected.id, auth);
    for (const tombstone of current.tombstones) {
      if (tombstone.id === selected.id) tombstone.restoredAt = Date.now();
    }
  });
  assertCodexWorkerMutationDeadline();
  fs.rmSync(codexArchiveMarker(selected.id), { force: true });
  return { store, profile: selected };
}

/** Reconcile while the caller already owns `codex-live-auth`. */
export async function reconcileLiveCodexUnlocked(
  forceTokenRefresh = false,
  options: {
    inspect?: (refreshToken: boolean) => Promise<CodexInspection>;
    credentialLockHeldForAccountId?: string;
  } = {},
): Promise<{ store: CodexProfilesStore; profile: CodexProfile | null }> {
  // Observe the provider's effective credential store first. Forcing `file` here can
  // hide a live keyring account and make its duplicate look parked, creating two owners
  // of one rotating refresh chain.
  const inspect = options.inspect
    ?? ((refreshToken: boolean) => inspectCodexHome(codexHome(), refreshToken, { forceFileCredentials: false }));
  let inspection = await inspect(false);
  if (inspection.credentialStore?.trim().toLowerCase() !== 'file') {
    throw new Error(
      `Codex live reconciliation requires cli_auth_credentials_store="file"; the effective store is ${inspection.credentialStore ?? 'unresolved'}. No account was associated by email alone.`,
    );
  }
  if (forceTokenRefresh) {
    inspection = await inspect(true);
  }
  // Read after inspection because account/read(refreshToken=true) may rotate auth.json.
  const authState = readCodexAuthState(codexHome());
  if (authState.status === 'corrupt') throw authState.error;
  const auth = authState.status === 'valid' ? authState.auth : null;
  if (inspection.account?.type !== 'chatgpt') {
    if (auth) {
      throw new Error(
        'Codex auth.json is present but the official account projection is unavailable. Active-account maintenance was aborted before any parked refresh.',
      );
    }
    const current = loadCodexStore();
    const store = current.activeProfileId
      ? mutateCodexStore((fresh) => { fresh.activeProfileId = null; })
      : current;
    return { store, profile: null };
  }
  if (!auth) {
    throw new Error(
      `Codex is logged in through ${inspection.credentialStore ?? 'an unresolved credential store'}, but no reusable auth.json is available. Parked-account refresh was aborted.`,
    );
  }
  const fileIdentity = metadataFromAuth(auth).email.trim().toLowerCase();
  const effectiveIdentity = inspection.account.email?.trim().toLowerCase();
  // The official app-server permits a null email (notably for some enterprise
  // accounts). With an explicitly file-backed effective store, auth.json's validated
  // account_id remains the durable identity. Compare emails only when both exist.
  if (effectiveIdentity && !/^\(unknown/i.test(fileIdentity) && fileIdentity !== effectiveIdentity) {
    throw new Error('Codex effective credentials could not be proven to match the file-backed account.');
  }
  const archived = loadCodexStore().tombstones.find((tombstone) =>
    tombstone.provider === 'codex'
      && tombstone.archivedProfile?.provider === 'codex'
      && tombstone.archivedProfile.accountId === auth.tokens.account_id
      && (!tombstone.restoredAt || tombstone.deletedAt > tombstone.restoredAt));
  if (archived) {
    const current = loadCodexStore();
    const store = current.activeProfileId
      ? mutateCodexStore((fresh) => { fresh.activeProfileId = null; })
      : current;
    logger.warn('codex live account is archived; explicit restore required', { profileId: archived.id });
    return { store, profile: null };
  }
  const commit = (latestAuth: CodexAuthFile) => {
    const result = upsertAuth(latestAuth, inspection);
    result.store = mutateCodexStore((store) => {
      store.activeProfileId = result.profile.id;
      const profile = store.profiles.find((p) => p.id === result.profile.id);
      if (!profile) throw new Error('The reconciled Codex profile disappeared before the active commit.');
      profile.lastUsedAt = Date.now();
    });
    return result;
  };
  if (options.credentialLockHeldForAccountId === auth.tokens.account_id) return commit(auth);
  return withFileLock(codexCredentialLockName(auth.tokens.account_id), async () => {
    // account/read may rotate auth.json while we wait for another managed mutation.
    // Re-read under the account lock so an older observation is never copied back.
    const latestState = readCodexAuthState(codexHome());
    if (latestState.status === 'corrupt') throw latestState.error;
    if (latestState.status !== 'valid' || latestState.auth.tokens.account_id !== auth.tokens.account_id) {
      throw new Error('Codex live credentials changed while reconciliation was waiting; no saved profile was overwritten.');
    }
    return commit(latestState.auth);
  });
}

/** Serialize effective account reads, optional rotation, auth copy, and active commit. */
export async function reconcileLiveCodex(
  forceTokenRefresh = false,
  options: { inspect?: (refreshToken: boolean) => Promise<CodexInspection> } = {},
): Promise<{ store: CodexProfilesStore; profile: CodexProfile | null }> {
  return withFileLock('codex-live-auth', () => reconcileLiveCodexUnlocked(forceTokenRefresh, options));
}

export async function addCodexAccount(
  onAuthUrl: (url: string) => void | Promise<void>,
  signal?: AbortSignal,
  options: { login?: typeof loginCodexHome } = {},
): Promise<{ store: CodexProfilesStore; profile: CodexProfile }> {
  ensureDataDirs();
  recoverAbandonedCodexHomes();
  const tempId = `pending-${crypto.randomUUID()}`;
  const home = codexProfileHome(tempId);
  let committed = false;
  try {
    const inspection = await (options.login ?? loginCodexHome)(home, onAuthUrl, signal);
    // The app-server can finish its own cleanup after the account projection is
    // available. Escape must still win during that final await boundary.
    throwIfCodexLoginCancelled(signal);
    const auth = readCodexAuth(home);
    if (!auth) throw new Error('Codex login completed without a reusable ChatGPT auth.json.');
    // The file is created by the official ChatGPT login flow and rejects API-key
    // mode. It is a stronger and more durable signal than a transient account/read
    // projection immediately following the callback.
    throwIfCodexLoginCancelled(signal);
    const result = await withFileLock(codexCredentialLockName(auth.tokens.account_id), async () => {
      // Escape must also win while a concurrent rotation/import is releasing the account.
      throwIfCodexLoginCancelled(signal);
      return upsertAuth(auth, inspection, undefined, { allowArchivedRestore: true });
    });
    committed = true;
    return result;
  } catch (error) {
    if (error instanceof CodexAppServerShutdownError) {
      try {
        writeCodexLoginHelperMarker(home, error.pid);
      } catch (markerError) {
        logger.error('codex shutdown-uncertain marker could not be refreshed; pending home still retained', markerError, { tempId });
      }
      logger.error('codex login helper did not exit; pending home retained in place', error, { tempId });
    } else {
      archivePendingCodexHome(home, tempId, signal?.aborted ? 'cancelled' : 'failed');
    }
    throw error;
  } finally {
    // Only a fully committed canonical auth home + metadata row permits cleanup.
    if (committed) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch (error) {
        logger.warn('committed Codex login sandbox cleanup deferred', { tempId, error: String(error) });
      }
    }
  }
}

export async function refreshCodexProfile(
  profileId: string,
  options: { forceTokenRefresh?: boolean } = {},
): Promise<CodexProfilesStore> {
  const observed = loadCodexStore().profiles.find((profile) => profile.id === profileId);
  if (!observed) throw new Error('Codex profile not found.');
  return withFileLock(codexCredentialLockName(observed.accountId), async () => {
    const current = loadCodexStore();
    const profile = current.profiles.find((p) => p.id === profileId);
    if (!profile || profile.accountId !== observed.accountId) throw new Error('Codex profile changed while waiting for its credential lock.');
    const forceTokenRefresh = options.forceTokenRefresh ?? true;
    // A switch/reconciliation commits the active marker before releasing this same
    // account lock. Never rotate an isolated duplicate after it became live.
    if (current.activeProfileId === profileId && forceTokenRefresh) {
      throw new Error('Refusing to refresh the isolated copy of the active Codex account.');
    }
    try {
      // Manual maintenance forces the official managed ChatGPT refresh. Cursor preview
      // passes false and therefore reads quotas without rotating a parked credential.
      const inspection = await inspectCodexHome(codexProfileHome(profileId), forceTokenRefresh);
      const refreshedAuth = readCodexAuth(codexProfileHome(profileId));
      if (!refreshedAuth || refreshedAuth.tokens.account_id !== profile.accountId) {
        throw new Error('ChatGPT login is no longer available.');
      }
      return mutateCodexStore((store) => {
        const target = store.profiles.find((p) => p.id === profileId);
        if (!target) return;
        target.email = inspection.account?.email || target.email;
        applyResolvedCodexPlan(target, inspection);
        target.usage = usageFromInspection(inspection, target.usage);
        target.needsReauth = false;
        target.updatedAt = Date.now();
      });
    } catch (e) {
      return mutateCodexStore((store) => {
        const target = store.profiles.find((p) => p.id === profileId);
        if (!target) return;
        // A read-only preview can fail because its access token is merely expired; only
        // a failed official forced refresh proves that this saved login needs attention.
        if (forceTokenRefresh && /auth|login|unauthorized|401/i.test(String(e))) target.needsReauth = true;
        const safeError = redactText(e);
        target.usage = target.usage
          ? { ...target.usage, status: 'stale', error: safeError }
          : { fetchedAt: Date.now(), status: 'error', error: safeError };
      });
    }
  });
}

export async function refreshAllCodexProfiles(
  options: {
    onlyStale?: boolean;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number, profile: CodexProfile) => void;
  } = {},
): Promise<CodexProfilesStore> {
  let store = loadCodexStore();
  let liveProfileId: string | null = null;
  try {
    // The official live client alone owns its rotating token chain. Scheduled/manual
    // maintenance only snapshots it; it never performs a switcher-side live rotation.
    const reconciled = await reconcileLiveCodex(false);
    store = reconciled.store;
    liveProfileId = reconciled.profile?.id ?? null;
  } catch (e) {
    logger.error('codex maintenance aborted because live reconciliation failed', e);
    throw new Error(
      `Codex usage refresh aborted before parked credentials were touched: ${String((e as Error).message ?? e)}`,
      { cause: e },
    );
  }
  // The global live account is maintained through its own CODEX_HOME above. Refreshing
  // its isolated duplicate would create two owners for one rotating refresh-token chain.
  const now = Date.now();
  const targets = [...store.profiles].filter((profile) => {
    if (profile.id === liveProfileId) return false;
    if (!options.onlyStale) return true;
    return codexUsageNeedsRefresh(profile, now);
  });
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (!options.signal?.aborted) {
      const index = nextIndex++;
      const profile = targets[index];
      if (!profile) return;
      await refreshCodexProfile(profile.id);
      completed++;
      options.onProgress?.(completed, targets.length, profile);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
  if (options.signal?.aborted) throw new Error('Codex quota refresh cancelled.');
  return loadCodexStore();
}

export function renameCodexProfile(id: string, label: string): CodexProfilesStore {
  return mutateCodexStore((store) => {
    const profile = store.profiles.find((p) => p.id === id);
    if (!profile) return;
    profile.label = label.trim() || profile.label;
    profile.updatedAt = Date.now();
  });
}

async function assertCodexProfileCanBeArchivedUnlocked(
  id: string,
  inspect: () => Promise<CodexInspection> = () => inspectCodexHome(codexHome(), false, { forceFileCredentials: false }),
): Promise<CodexProfile> {
  const store = loadCodexStore();
  const profile = store.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error('Codex profile not found.');
  if (store.activeProfileId === id) throw new Error('Cannot archive the active Codex account.');
  const inspection = await inspect();
  const state = readCodexAuthState(codexHome());
  if (state.status === 'corrupt') throw state.error;
  if (inspection.account?.type === 'chatgpt'
    && inspection.credentialStore?.trim().toLowerCase() !== 'file') {
    throw new Error('Cannot prove which Codex profile is live while the effective credential store is not explicitly file-backed.');
  }
  if (inspection.account?.type === 'chatgpt' && state.status !== 'valid') {
    throw new Error('Codex reports a live ChatGPT session but its account id cannot be proven from auth.json.');
  }
  if (state.status === 'valid' && state.auth.tokens.account_id === profile.accountId) {
    throw new Error('Cannot archive the Codex account that is still live. Switch or log out first.');
  }
  return profile;
}

function deleteCodexProfileUnlocked(id: string): CodexProfilesStore {
  let archiveMarkerWritten = false;
  let deletionEventAt: number | null = null;
  let store: CodexProfilesStore;
  try {
    store = mutateCodexStore((current) => {
      const profile = current.profiles.find((candidate) => candidate.id === id);
      if (!profile) return;
      if (current.activeProfileId === id) throw new Error('Cannot delete the active Codex account.');
      const liveState = readCodexAuthState(codexHome());
      if (liveState.status === 'corrupt') throw liveState.error;
      if (liveState.status === 'valid' && liveState.auth.tokens.account_id === profile.accountId) {
        throw new Error('Cannot archive the Codex account that is still live. Switch or log out first.');
      }
      deletionEventAt = Date.now();
      atomicWriteFile(codexArchiveMarker(id), `${JSON.stringify({
        kind: 'claude-codex-account-switch/codex-profile-archive',
        version: 1,
        profileId: id,
        accountId: profile.accountId,
        archivedAt: deletionEventAt,
      }, null, 2)}\n`);
      archiveMarkerWritten = true;
      current.profiles = current.profiles.filter((p) => p.id !== id);
      current.tombstones = [
        ...current.tombstones.filter((t) => t.id !== id),
        { id, provider: 'codex', deletedAt: deletionEventAt, archivedProfile: { ...profile } },
      ];
      logger.info('codex profile archived', { email: profile.email });
    });
  } catch (error) {
    // mutateCodexStore writes the primary before its sidecar. If the primary commit
    // succeeded but the sidecar failed, the marker must survive so an old sidecar or
    // snapshot can never resurrect the archived profile.
    const primary = readStoreFileUnfiltered(codexProfilesPath());
    const primaryCommitted = deletionEventAt !== null
      && !!primary
      && !primary.profiles.some((profile) => profile.id === id)
      && primary.tombstones.some((tombstone) => tombstone.id === id && tombstone.deletedAt >= deletionEventAt!);
    // Remove the marker only when a readable primary conclusively proves that deletion
    // did not commit. An unreadable primary is ambiguous and must fail closed.
    if (archiveMarkerWritten && primary && !primaryCommitted) fs.rmSync(codexArchiveMarker(id), { force: true });
    if (archiveMarkerWritten && (!primary || primaryCommitted)) {
      logger.warn('codex archive marker retained after an ambiguous or partial metadata commit', { profileId: id });
    }
    throw error;
  }
  try {
    const source = codexProfileHome(id);
    if (fs.existsSync(source)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destination = path.join(backupsDir(), 'codex-deleted', `${stamp}-${id}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.cpSync(source, destination, { recursive: true });
    }
  } catch (e) {
    logger.warn('codex deleted credential backup failed', { error: String(e) });
  }
  return store;
}

/** Proof and deletion are one live/account-locked transaction; no switch can enter between them. */
export async function archiveCodexProfile(
  id: string,
  options: { inspect?: () => Promise<CodexInspection> } = {},
): Promise<CodexProfilesStore> {
  return withFileLock('codex-live-auth', async () => {
    const inspect = options.inspect
      ?? (() => inspectCodexHome(codexHome(), false, { forceFileCredentials: false }));
    const observed = await assertCodexProfileCanBeArchivedUnlocked(id, inspect);
    return withFileLock(codexCredentialLockName(observed.accountId), async () => {
      await assertCodexProfileCanBeArchivedUnlocked(id, inspect);
      return deleteCodexProfileUnlocked(id);
    });
  });
}

export interface DeletedCodexProfileRestore {
  store: CodexProfilesStore;
  profile: CodexProfile | null;
}

/** Restore the most recently archived Codex profile without making it active. */
export function restoreLatestDeletedCodexProfileWithResult(): DeletedCodexProfileRestore {
  let restoredId: string | undefined;
  const result = mutateCodexStore((store) => {
    const tombstone = [...store.tombstones]
      .filter((t) => t.provider === 'codex' && t.archivedProfile?.provider === 'codex'
        && (!t.restoredAt || t.deletedAt > t.restoredAt))
      .sort((a, b) => b.deletedAt - a.deletedAt)[0];
    if (!tombstone?.archivedProfile || tombstone.archivedProfile.provider !== 'codex') return;
    if (!store.profiles.some((profile) => profile.id === tombstone.id)) {
      store.profiles.push({
        ...tombstone.archivedProfile,
        needsReauth: !readCodexAuth(codexProfileHome(tombstone.id)) || tombstone.archivedProfile.needsReauth,
        updatedAt: Date.now(),
      });
    }
    tombstone.restoredAt = Date.now();
    restoredId = tombstone.id;
    logger.info('codex archived profile restored', { email: tombstone.archivedProfile.email });
  });
  if (restoredId) fs.rmSync(codexArchiveMarker(restoredId), { force: true });
  return {
    store: result,
    profile: restoredId ? result.profiles.find((profile) => profile.id === restoredId) ?? null : null,
  };
}

export function restoreLatestDeletedCodexProfile(): CodexProfilesStore {
  return restoreLatestDeletedCodexProfileWithResult().store;
}

export type LatestCodexRecovery =
  | { source: 'tombstone'; store: CodexProfilesStore; profile: CodexProfile }
  | ({ source: 'abandoned' } & AbandonedCodexLoginRecovery)
  | { source: 'none'; store: CodexProfilesStore };

/** `z` semantics: normal voluntary-deletion tombstones always take precedence. */
export async function restoreLatestCodexRecovery(): Promise<LatestCodexRecovery> {
  const deleted = restoreLatestDeletedCodexProfileWithResult();
  if (deleted.profile) return { source: 'tombstone', store: deleted.store, profile: deleted.profile };
  const abandoned = await recoverLatestAbandonedCodexLogin();
  if (abandoned) return { source: 'abandoned', ...abandoned };
  return { source: 'none', store: deleted.store };
}

export function setActiveCodexProfile(id: string): CodexProfilesStore {
  return mutateCodexStore((store) => {
    const profile = store.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Cannot activate a missing or archived Codex profile.');
    profile.lastUsedAt = Date.now();
    profile.updatedAt = Date.now();
    store.activeProfileId = id;
  });
}

export interface EffectiveCodexQuotaProjection {
  primary: { usedPercent: number; resetsAt: number; windowDurationMins: number | null } | null;
  secondary: { usedPercent: number; resetsAt: number; windowDurationMins: number | null } | null;
  additional: Array<{ name: string; usedPercent: number; resetsAt: number }>;
  primaryComplete: boolean;
  secondaryComplete: boolean;
  additionalComplete: boolean;
}

function hasElapsedCodexQuotaWindow(profile: CodexProfile, nowMs: number): boolean {
  const buckets = profile.usage?.buckets && Object.keys(profile.usage.buckets).length
    ? Object.values(profile.usage.buckets)
    : profile.usage?.bucket
      ? [profile.usage.bucket]
      : [];
  return buckets.some((bucket) => [bucket.primary, bucket.secondary, bucket.individualLimit
    ? {
        usedPercent: 100 - bucket.individualLimit.remainingPercent,
        resetsAt: bucket.individualLimit.resetsAt,
      }
    : null].some((window) =>
    !!window && window.usedPercent > 0 && window.resetsAt > 0 && window.resetsAt * 1000 <= nowMs));
}

/** Shared stale/reset test used by Best Now refresh so elapsed windows never stay cached. */
export function codexUsageNeedsRefresh(profile: CodexProfile, nowMs = Date.now()): boolean {
  const quota = effectiveCodexQuota(profile);
  return profile.usage?.status !== 'ok'
    || nowMs - profile.usage.fetchedAt > 10 * 60_000
    || !quota.primaryComplete
    || !quota.secondaryComplete
    || !quota.additionalComplete
    || hasElapsedCodexQuotaWindow(profile, nowMs);
}

/** One conservative quota projection shared by Best Now, `l`, doctor and the TUI. */
export function effectiveCodexQuota(profile: CodexProfile): EffectiveCodexQuotaProjection {
  const buckets = profile.usage?.buckets && Object.keys(profile.usage.buckets).length
    ? Object.values(profile.usage.buckets)
    : profile.usage?.bucket
      ? [profile.usage.bucket]
      : [];
  const combine = (kind: 'primary' | 'secondary') => {
    const windows = buckets
      .map((bucket) => {
        const window = bucket[kind];
        if (!window) return null;
        // Official app-server semantics: a non-null reached type is a backend-classified
        // reached state. Its exact class is intentionally opaque, so fail closed across
        // every applicable window instead of selecting an account known to be blocked.
        return bucket.rateLimitReachedType
          ? { ...window, usedPercent: 100 }
          : window;
      })
      .filter((window): window is NonNullable<typeof window> => !!window);
    if (!windows.length) return null;
    const usedPercent = Math.max(...windows.map((window) => window.usedPercent));
    const constraining = windows.filter((window) => window.usedPercent === usedPercent);
    const reserveThreshold = 100 - MIN_USABLE_HEADROOM_PERCENT;
    const reserveBlockers = windows.filter((window) => window.usedPercent >= reserveThreshold);
    const resetWindows = reserveBlockers.length ? reserveBlockers : constraining;
    const hasUnknownBlockingReset = reserveBlockers.some((window) => window.resetsAt <= 0);
    const durations = [...new Set(windows
      .map((window) => window.windowDurationMins)
      .filter((duration) => Number.isFinite(duration) && duration > 0))];
    return {
      usedPercent,
      // Every independent bucket must keep the reserve. If several buckets block use,
      // capacity is unavailable until the last known blocker resets; an unknown blocker
      // remains unknown rather than advertising an unsafe optimistic recovery time.
      resetsAt: hasUnknownBlockingReset
        ? 0
        : Math.max(...resetWindows.map((window) => window.resetsAt > 0 ? window.resetsAt : 0)),
      windowDurationMins: durations.length === 1 ? durations[0] : null,
    };
  };
  const additional = buckets.flatMap((bucket) => {
    const monthly = bucket.individualLimit;
    const reached = !!bucket.rateLimitReachedType;
    const result: Array<{ name: string; usedPercent: number; resetsAt: number }> = [];
    if (monthly
      && Number.isFinite(monthly.remainingPercent)
      && Number.isFinite(monthly.resetsAt)) {
      result.push({
        name: bucket.limitName ? `${bucket.limitName} monthly` : 'Monthly limit',
        usedPercent: reached
          ? 100
          : Math.max(0, Math.min(100, 100 - monthly.remainingPercent)),
        resetsAt: monthly.resetsAt > 0 ? monthly.resetsAt : 0,
      });
    }
    if (reached && !bucket.primary && !bucket.secondary && !monthly) {
      result.push({ name: 'Backend limit', usedPercent: 100, resetsAt: 0 });
    }
    return result;
  });
  if (profile.usage?.spendControlReached) {
    additional.push({ name: 'Workspace spend control', usedPercent: 100, resetsAt: 0 });
  }
  return {
    primary: combine('primary'),
    secondary: combine('secondary'),
    additional,
    primaryComplete: buckets.length > 0
      && buckets.every((bucket) => Object.prototype.hasOwnProperty.call(bucket, 'primary')),
    secondaryComplete: buckets.length > 0
      && buckets.every((bucket) => Object.prototype.hasOwnProperty.call(bucket, 'secondary')),
    additionalComplete: buckets.length > 0
      && buckets.every((bucket) => Object.prototype.hasOwnProperty.call(bucket, 'individualLimit')),
  };
}

export function leastLoadedCodex(profiles: CodexProfile[]): CodexProfile | null {
  const scored = profiles
    .map((profile) => {
      const quota = effectiveCodexQuota(profile);
      const utilization = Math.max(
        quota.primary?.usedPercent ?? -1,
        quota.secondary?.usedPercent ?? -1,
        ...quota.additional.map((window) => window.usedPercent),
      );
      return { profile, utilization };
    })
    .filter((item) => item.utilization >= 0)
    .sort((a, b) => a.utilization - b.utilization);
  return scored[0]?.profile ?? null;
}

/** Reset-aware Best Now adapter for Codex's epoch-second quota representation. */
export function bestNowCodex(
  profiles: CodexProfile[],
  activeProfileId: string | null,
  now = Date.now(),
): BestNowDecision<CodexProfile> {
  return selectBestNow(profiles.map((profile) => {
    const quota = effectiveCodexQuota(profile);
    const primary = quota.primary
      ? { usedPercent: quota.primary.usedPercent, resetsAt: quota.primary.resetsAt > 0 ? quota.primary.resetsAt * 1000 : null }
      : null;
    const secondary = quota.secondary
      ? { usedPercent: quota.secondary.usedPercent, resetsAt: quota.secondary.resetsAt > 0 ? quota.secondary.resetsAt * 1000 : null }
      : null;
    return {
      id: profile.id,
      account: profile,
      eligible: !profile.needsReauth,
      authorizationStatus: profile.needsReauth ? 'reauth-required' as const : 'valid' as const,
      isActive: profile.id === activeProfileId,
      primary,
      secondary,
      additional: quota.additional.map((window) => ({
        name: window.name,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt > 0 ? window.resetsAt * 1000 : null,
      })),
      metadata: {
        status: profile.usage?.status ?? 'never',
        fetchedAt: profile.usage?.fetchedAt,
        primaryComplete: quota.primaryComplete && quota.additionalComplete,
        secondaryComplete: quota.secondaryComplete,
      },
    };
  }), now);
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

export interface CodexExportOptions {
  /** Kept injectable to avoid a codexProfiles <-> codexSwitch module cycle. */
  processInventory?: () => Array<{ pid: number }>;
  /** Test seam; production uses the official Codex app-server projection. */
  inspect?: (refreshToken: boolean) => Promise<CodexInspection>;
}

function assertCodexExportQuiescent(processInventory?: () => Array<{ pid: number }>): void {
  if (!processInventory) {
    throw new Error('Codex export was refused because process safety could not be established.');
  }
  let running: Array<{ pid: number }>;
  try {
    running = processInventory();
  } catch (error) {
    throw new Error(
      `Codex export was refused because process safety could not be established: ${String((error as Error).message ?? error)}`,
      { cause: error },
    );
  }
  if (running.length) {
    throw new Error(
      `Close Codex before exporting credentials (process ${running.map((process) => process.pid).join(', ')}). No secrets were written.`,
    );
  }
}

async function withCodexExportCredentialLocks<T>(
  lockNames: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const [next, ...remaining] = lockNames;
  if (!next) return operation();
  return withFileLock(next, () => withCodexExportCredentialLocks(remaining, operation));
}

function codexExportLockSet(profiles: CodexProfile[]): string[] {
  return [...new Set(profiles.map((profile) => codexCredentialLockName(profile.accountId)))].sort();
}

function sameCodexExportLockSet(profiles: CodexProfile[], expected: string[]): boolean {
  const current = codexExportLockSet(profiles);
  return current.length === expected.length && current.every((lock, index) => lock === expected[index]);
}

export async function exportCodexProfile(
  profile: Pick<CodexProfile, 'id'>,
  options: CodexExportOptions = {},
): Promise<string> {
  assertCodexExportQuiescent(options.processInventory);
  return withFileLock('codex-live-auth', async () => {
    assertCodexExportQuiescent(options.processInventory);
    await reconcileLiveCodexUnlocked(false, { inspect: options.inspect });
    const observed = loadCodexStore().profiles.find((candidate) => candidate.id === profile.id);
    if (!observed) throw new Error('The selected Codex profile no longer exists. Nothing was exported.');
    const lockName = codexCredentialLockName(observed.accountId);
    return withCodexExportCredentialLocks([lockName], async () => {
      assertCodexExportQuiescent(options.processInventory);
      const current = loadCodexStore().profiles.find((candidate) => candidate.id === profile.id);
      if (!current || codexCredentialLockName(current.accountId) !== lockName) {
        throw new Error('The selected Codex credential identity changed while export was waiting. Retry the export.');
      }
      ensureDataDirs();
      const safe = current.label.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'codex-account';
      const file = path.join(exportDir(), `${safe}.codexswitch.json`);
      atomicWriteFile(file, `${JSON.stringify(portable(current), null, 2)}\n`);
      return file;
    });
  });
}

export async function exportAllCodexProfiles(
  _callerSnapshot: CodexProfilesStore = loadCodexStore(),
  options: CodexExportOptions = {},
): Promise<string> {
  assertCodexExportQuiescent(options.processInventory);
  return withFileLock('codex-live-auth', async () => {
    assertCodexExportQuiescent(options.processInventory);
    await reconcileLiveCodexUnlocked(false, { inspect: options.inspect });
    const observed = loadCodexStore();
    const lockNames = codexExportLockSet(observed.profiles);
    return withCodexExportCredentialLocks(lockNames, async () => {
      assertCodexExportQuiescent(options.processInventory);
      const current = loadCodexStore();
      if (!sameCodexExportLockSet(current.profiles, lockNames)) {
        throw new Error('The Codex account set changed while export was waiting. Retry the export.');
      }
      ensureDataDirs();
      const data: PortableCodexAll = {
        kind: 'claude-codex-account-switch/export-all',
        version: 2,
        provider: 'codex',
        exportedAt: Date.now(),
        accounts: current.profiles.map(portable),
      };
      const file = path.join(exportDir(), 'all-codex-accounts.codexswitch.json');
      atomicWriteFile(file, `${JSON.stringify(data, null, 2)}\n`);
      return file;
    });
  });
}

async function importRecord(record: PortableCodexProfile): Promise<CodexProfile> {
  if (record.provider !== 'codex' || !record.auth) throw new Error('Not a Codex account export.');
  const auth = validateCodexAuth(record.auth);
  if (record.accountId && record.accountId !== auth.tokens.account_id) {
    throw new Error('Codex export metadata does not match its credential account id.');
  }
  return withFileLock(codexCredentialLockName(auth.tokens.account_id), async () => {
    assertImportDoesNotDowngrade(auth);
    return upsertAuth(auth, undefined, record.label).profile;
  });
}

export async function importCodexFromPath(target: string): Promise<CodexProfile[]> {
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).map((name) => path.join(target, name)).filter((file) => /(?:auth\.json|\.codexswitch\.json)$/i.test(file))
    : [target];
  const imported: CodexProfile[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PortableCodexProfile | PortableCodexAll | CodexAuthFile;
    if ((raw as PortableCodexAll).kind === 'claude-codex-account-switch/export-all') {
      for (const record of (raw as PortableCodexAll).accounts) imported.push(await importRecord(record));
    } else if ((raw as PortableCodexProfile).kind === 'claude-codex-account-switch/export') {
      imported.push(await importRecord(raw as PortableCodexProfile));
    } else {
      let auth: CodexAuthFile;
      try {
        auth = validateCodexAuth(raw);
      } catch (error) {
        throw new Error(`${file} is not a reusable Codex ChatGPT auth export: ${String((error as Error).message ?? error)}`);
      }
      imported.push(await withFileLock(codexCredentialLockName(auth.tokens.account_id), async () => {
        assertImportDoesNotDowngrade(auth);
        return upsertAuth(auth).profile;
      }));
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
