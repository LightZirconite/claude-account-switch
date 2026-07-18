// The profiles store: saved accounts kept in ~/.claude-switch/profiles.json (plain JSON).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findNodeAtLocation, getNodeValue, parseTree, type ParseError } from 'jsonc-parser';
import {
  claudeCredentialsRoot,
  claudeProfileCredentialsPath,
  profilesPath,
  ensureDataDirs,
  exportDir,
  importDir,
  backupsDir,
  desktopStoreDir,
  DESKTOP_BUNDLE_ENTRIES,
  findClaudeExe,
} from './paths';
import { getLiveAccount, readLiveAccountUnlocked, updateLiveCredentials } from './claudeStore';
import { snapshotLiveDesktopInto, newDesktopProfileId, validateDesktopProfileSnapshot } from './desktopStore';
import { logger } from './logger';
import { withFileLock, withFileLockSync } from './locks';
import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import { DEFAULT_SCOPES, primeIdentity, supportsIsolatedClaudeAuth, type PrimedIdentity } from './oauth';
import { findClaudeProcesses, type ProcInfo } from './processes';
import { readClaudeAuthStatusSync, type ClaudeAuthStatus } from './claudeStatus';
import {
  hasCliAuth,
  hasRefreshableOauth,
  type ClaudeAiOauth,
  type LiveAccount,
  type OauthAccount,
  type PortableExport,
  type PortableExportAll,
  type Profile,
  type ProfilesStore,
} from './types';

/** Path of the last-known-good sidecar kept next to profiles.json. */
function lastGoodPath(): string {
  return profilesPath() + '.bak';
}

const STORE_VERSION = 3;

type ClaudeRecoveryProfile = Pick<Profile, 'id' | 'provider' | 'label' | 'email' | 'createdAt'>
  & Partial<Pick<Profile,
    'accountUuid'
    | 'organizationUuid'
    | 'organizationUuidRoot'
    | 'organizationType'
    | 'subscriptionType'
    | 'planObservedAt'
    | 'planSource'
    | 'oauthAccount'
    | 'userID'
    | 'desktopSnapshotDir'
    | 'desktopCapturedAt'
    | 'lastUsedAt'>>;

interface ClaudeCredentialEnvelope {
  kind: 'claude-codex-account-switch/claude-credentials';
  version: 1 | 2;
  provider: 'claude';
  profileId: string;
  updatedAt: number;
  claudeAiOauth: ClaudeAiOauth;
  /** Secret-free identity copy used only when metadata and snapshots are unavailable. */
  profile?: ClaudeRecoveryProfile;
}

interface ClaudeArchiveMarker {
  kind: 'claude-codex-account-switch/claude-profile-archive';
  version: 1;
  profileId: string;
  archivedAt: number;
  archivedProfile?: Omit<Profile, 'claudeAiOauth'>;
}

function withoutClaudeSecret(profile: Profile): Omit<Profile, 'claudeAiOauth'> {
  const { claudeAiOauth: _secret, ...metadata } = profile;
  return metadata;
}

function recoveryProfile(profile: Profile): ClaudeRecoveryProfile {
  const projection: ClaudeRecoveryProfile = {
    id: profile.id,
    provider: 'claude',
    label: profile.label,
    email: profile.email,
    createdAt: profile.createdAt,
  };
  const optionalKeys: Array<keyof Omit<ClaudeRecoveryProfile, 'id' | 'provider' | 'label' | 'email' | 'createdAt'>> = [
    'accountUuid',
    'organizationUuid',
    'organizationUuidRoot',
    'organizationType',
    'subscriptionType',
    'planObservedAt',
    'planSource',
    'oauthAccount',
    'userID',
    'desktopSnapshotDir',
    'desktopCapturedAt',
    'lastUsedAt',
  ];
  for (const key of optionalKeys) {
    const value = profile[key];
    if (value !== undefined) (projection as Record<string, unknown>)[key] = value;
  }
  return projection;
}

function claudeArchiveMarker(profileId: string): string {
  return path.join(path.dirname(claudeProfileCredentialsPath(profileId)), '.archived.json');
}

function claudeArchiveRestorePendingMarker(profileId: string): string {
  return path.join(path.dirname(claudeProfileCredentialsPath(profileId)), '.archive-restore-pending.json');
}

function claudeCredentialGenerationsDir(profileId: string): string {
  return path.join(path.dirname(claudeProfileCredentialsPath(profileId)), 'generations');
}

const MAX_CLAUDE_CREDENTIAL_GENERATIONS = 24;

function isClaudeCredentialBlock(value: unknown): value is ClaudeAiOauth {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return 'accessToken' in record || 'refreshToken' in record || 'expiresAt' in record || 'refreshTokenExpiresAt' in record;
}

function readCredentialEnvelope(profileId: string): ClaudeCredentialEnvelope | null {
  const candidates: ClaudeCredentialEnvelope[] = [];
  const files = [claudeProfileCredentialsPath(profileId), `${claudeProfileCredentialsPath(profileId)}.bak`];
  try {
    const generations = fs.readdirSync(claudeCredentialGenerationsDir(profileId), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^generation-[a-f0-9-]+\.json$/i.test(entry.name))
      .map((entry) => path.join(claudeCredentialGenerationsDir(profileId), entry.name));
    files.push(...generations);
  } catch {
    /* no append-only generation journal yet */
  }
  for (const file of files) {
    try {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCredentialEnvelope;
      if (
        envelope?.kind === 'claude-codex-account-switch/claude-credentials'
        && envelope.provider === 'claude'
        && envelope.profileId === profileId
        && isClaudeCredentialBlock(envelope.claudeAiOauth)
      ) {
        envelope.updatedAt = Number.isFinite(envelope.updatedAt) ? envelope.updatedAt : 0;
        candidates.push(envelope);
      }
    } catch {
      /* try the mirrored envelope */
    }
  }
  return candidates.sort((a, b) =>
    Number(hasRefreshableOauth(b.claudeAiOauth)) - Number(hasRefreshableOauth(a.claudeAiOauth))
    || b.updatedAt - a.updatedAt)[0] ?? null;
}

function credentialMirrorsMatch(profile: Profile): boolean {
  const expectedOauth = JSON.stringify(profile.claudeAiOauth);
  const expectedMetadata = JSON.stringify(recoveryProfile(profile));
  return [claudeProfileCredentialsPath(profile.id), `${claudeProfileCredentialsPath(profile.id)}.bak`]
    .every((file) => {
      try {
        const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCredentialEnvelope;
        return envelope.version >= 2
          && envelope.profileId === profile.id
          && envelope.profile?.id === profile.id
          && JSON.stringify(envelope.profile) === expectedMetadata
          && JSON.stringify(envelope.claudeAiOauth) === expectedOauth;
      } catch {
        return false;
      }
    });
}

/**
 * Bound invalid predecessor history after the newest chain has at least one canonical
 * copy. Provider rotations invalidate old refresh tokens, so retaining the latest 24
 * strict envelopes is ample recovery depth without making lifetime/many-account loads
 * scan an ever-growing number of tiny files.
 */
function pruneClaudeCredentialGenerations(profileId: string): void {
  const dir = claudeCredentialGenerationsDir(profileId);
  let generations: Array<{ file: string; updatedAt: number }>;
  try {
    generations = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^generation-[a-f0-9-]+\.json$/i.test(entry.name))
      .flatMap((entry) => {
        const file = path.join(dir, entry.name);
        try {
          const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCredentialEnvelope;
          return envelope?.kind === 'claude-codex-account-switch/claude-credentials'
            && envelope.provider === 'claude'
            && envelope.profileId === profileId
            && Number.isFinite(envelope.updatedAt)
            && isClaudeCredentialBlock(envelope.claudeAiOauth)
            ? [{ file, updatedAt: envelope.updatedAt }]
            : [];
        } catch {
          // Unknown/corrupt evidence is never removed automatically.
          return [];
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || b.file.localeCompare(a.file));
  } catch {
    return;
  }
  for (const generation of generations.slice(MAX_CLAUDE_CREDENTIAL_GENERATIONS)) {
    try {
      fs.rmSync(generation.file, { force: true });
    } catch (error) {
      logger.warn('old Claude credential generation could not be pruned', {
        profileId,
        error: String(error),
      });
    }
  }
}

function hydrateCredentialEnvelopes(store: ProfilesStore): void {
  for (const profile of store.profiles) {
    const envelope = readCredentialEnvelope(profile.id);
    // Once extracted, the independently durable envelope is authoritative over any
    // stale inline v1 token carried by an old metadata snapshot.
    if (envelope) profile.claudeAiOauth = envelope.claudeAiOauth;
  }
}

/** Parse + normalize store text, or null if it isn't a usable store. */
function parseStore(text: string): ProfilesStore | null {
  try {
    const s = JSON.parse(text) as ProfilesStore;
    if (!s || typeof s !== 'object' || !Array.isArray(s.profiles)) return null;
    if (!s.profiles.every((profile) => profile && typeof profile === 'object'
      && typeof profile.id === 'string' && !!profile.id.trim())) return null;
    if (new Set(s.profiles.map((profile) => profile.id)).size !== s.profiles.length) return null;
    if (typeof s.version !== 'number') s.version = 1;
    s.revision = Number.isFinite(s.revision) ? s.revision : 0;
    if (s.tombstones !== undefined && !Array.isArray(s.tombstones)) return null;
    s.tombstones = s.tombstones ?? [];
    if (!s.tombstones.every((tombstone) => tombstone?.provider === 'claude'
      && typeof tombstone.id === 'string'
      && typeof tombstone.deletedAt === 'number'
      && Number.isFinite(tombstone.deletedAt))) return null;
    delete (s as ProfilesStore & { closeClaudeOnSwitch?: boolean }).closeClaudeOnSwitch;
    for (const tombstone of s.tombstones) {
      if (tombstone.archivedProfile?.provider === 'claude') {
        delete (tombstone.archivedProfile as Partial<Profile>).claudeAiOauth;
      }
    }
    for (const p of s.profiles) {
      p.provider = 'claude';
      p.email = typeof p.email === 'string' ? p.email : '(unknown)';
      p.label = typeof p.label === 'string' && p.label.trim() ? p.label : p.email || p.id;
      p.createdAt = Number.isFinite(p.createdAt) ? p.createdAt : Date.now();
      p.updatedAt = Number.isFinite(p.updatedAt) ? p.updatedAt : p.createdAt;
    }
    const requestedClaudeActive = s.activeProfileIds?.claude ?? s.activeProfileId ?? null;
    const requestedCodexActive = s.activeProfileIds?.codex ?? null;
    s.activeProfileId = s.profiles.some((profile) => profile.id === requestedClaudeActive)
      ? requestedClaudeActive
      : null;
    s.activeProfileIds = { claude: s.activeProfileId, codex: requestedCodexActive };
    hydrateCredentialEnvelopes(s);
    enforceClaudeArchiveMarkers(s);
    recoverMissingProfilesFromCredentialEnvelopes(s);
    deduplicateExactCredentialChains(s);
    return s;
  } catch {
    return null;
  }
}

/** Largest recent v1 snapshot. This recovers rows lost by stale pre-v2 processes. */
function bestLegacyBackup(): ProfilesStore | null {
  try {
    const dir = path.join(backupsDir(), 'profiles');
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => parseStore(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter((s): s is ProfilesStore => !!s);
    return candidates.sort((a, b) => b.profiles.length - a.profiles.length || (b.revision ?? 0) - (a.revision ?? 0))[0] ?? null;
  } catch {
    return null;
  }
}

function migrateLegacyStore(store: ProfilesStore): { store: ProfilesStore; changed: boolean } {
  if (store.version >= 2) return { store, changed: store.version < STORE_VERSION };
  const backup = bestLegacyBackup();
  if (backup) {
    for (const candidate of backup.profiles) {
      if (!store.profiles.some((p) => sameAccount(p, candidate))) {
        store.profiles.push(candidate);
        logger.warn('migration recovered missing legacy profile', { email: candidate.email });
      }
    }
  }
  store.version = STORE_VERSION;
  store.revision = (store.revision ?? 0) + 1;
  store.tombstones = store.tombstones ?? [];
  store.activeProfileIds = { claude: store.activeProfileId, codex: null };
  return { store, changed: true };
}

/** Newest snapshot in backups/profiles/ that parses and still has ≥1 account. */
function newestUsableBackup(): ProfilesStore | null {
  try {
    const dir = path.join(backupsDir(), 'profiles');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files) {
      const s = parseStore(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s && s.profiles.length) return s;
    }
  } catch {
    /* none */
  }
  return null;
}

function readRecoverableStore(): ProfilesStore | null {
  for (const file of [profilesPath(), lastGoodPath()]) {
    try {
      const parsed = parseStore(fs.readFileSync(file, 'utf8'));
      if (parsed) return parsed;
    } catch {
      /* continue with the next recovery source */
    }
  }
  return newestUsableBackup();
}

function hasStoreOrCredentialEvidence(): boolean {
  for (const file of [profilesPath(), lastGoodPath()]) {
    try {
      if (fs.statSync(file).size > 0) return true;
    } catch {
      /* missing */
    }
  }
  try {
    if (fs.readdirSync(claudeCredentialsRoot(), { withFileTypes: true })
      .some((entry) => entry.isDirectory() || entry.isFile())
    ) return true;
  } catch {
    /* no Claude credential evidence */
  }
  return durableDesktopProfiles().length > 0;
}

function credentialEnvelopeProfileIds(): string[] {
  try {
    return fs.readdirSync(claudeCredentialsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !!readCredentialEnvelope(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function orphanedClaudeCredentialIds(store: ProfilesStore): string[] {
  const known = new Set([
    ...store.profiles.map((profile) => profile.id),
    ...(store.tombstones ?? []).map((tombstone) => tombstone.id),
  ]);
  return credentialEnvelopeProfileIds().filter((id) => !known.has(id));
}

export function orphanedClaudeDesktopIds(store: ProfilesStore): string[] {
  const known = new Set([
    ...store.profiles.map((profile) => profile.id),
    ...(store.tombstones ?? []).map((tombstone) => tombstone.id),
  ]);
  return durableDesktopProfiles().map((profile) => profile.id).filter((id) => !known.has(id));
}

function readClaudeArchiveMarkerFile(
  profileId: string,
  file: string,
  phase: 'archived' | 'restore-pending',
): ClaudeArchiveMarker | null {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeArchiveMarker;
    if (marker?.kind !== 'claude-codex-account-switch/claude-profile-archive'
      || marker.version !== 1
      || marker.profileId !== profileId
      || !Number.isFinite(marker.archivedAt)) throw new Error('invalid Claude archive marker');
    return marker;
  } catch (error) {
    // Marker existence is the deletion commit point. A truncated marker must remain
    // authoritative; otherwise a stale profiles.json sidecar could resurrect the row.
    try {
      const stat = fs.statSync(file);
      logger.warn('damaged Claude archive marker remains authoritative', { profileId, phase });
      return {
        kind: 'claude-codex-account-switch/claude-profile-archive',
        version: 1,
        profileId,
        archivedAt: stat.mtimeMs || Date.now(),
      };
    } catch {
      return null;
    }
  }
}

function readClaudeArchiveMarker(profileId: string): ClaudeArchiveMarker | null {
  return readClaudeArchiveMarkerFile(profileId, claudeArchiveMarker(profileId), 'archived');
}

function readClaudeArchiveRestorePendingMarker(profileId: string): ClaudeArchiveMarker | null {
  return readClaudeArchiveMarkerFile(
    profileId,
    claudeArchiveRestorePendingMarker(profileId),
    'restore-pending',
  );
}

function archiveMarkerProfileIds(): string[] {
  try {
    return fs.readdirSync(claudeCredentialsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && (!!readClaudeArchiveMarker(entry.name) || !!readClaudeArchiveRestorePendingMarker(entry.name)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function writeClaudeArchiveMarker(
  profileId: string,
  archivedAt: number,
  archivedProfile?: Omit<Profile, 'claudeAiOauth'>,
): void {
  const marker: ClaudeArchiveMarker = {
    kind: 'claude-codex-account-switch/claude-profile-archive',
    version: 1,
    profileId,
    archivedAt,
    ...(archivedProfile ? { archivedProfile } : {}),
  };
  atomicWriteFile(claudeArchiveMarker(profileId), `${JSON.stringify(marker, null, 2)}\n`);
  // If this is a fresh voluntary deletion after a previously interrupted restore,
  // the new authoritative archive marker wins before the obsolete pending phase is
  // removed.
  fs.rmSync(claudeArchiveRestorePendingMarker(profileId), { force: true });
}

/** Move an archive marker into a recoverable two-phase restore state before metadata changes. */
function beginClaudeArchiveRestore(profileId: string): void {
  const archivedPath = claudeArchiveMarker(profileId);
  const pendingPath = claudeArchiveRestorePendingMarker(profileId);
  const pending = readClaudeArchiveRestorePendingMarker(profileId);
  if (!pending) {
    if (!readClaudeArchiveMarker(profileId)) {
      throw new Error('The Claude archive marker is missing; explicit restore aborted without changing metadata.');
    }
    fs.renameSync(archivedPath, pendingPath);
  } else if (fs.existsSync(archivedPath)) {
    // A previous attempt may have crashed after publishing the pending phase but
    // before removing a duplicate legacy marker. Keep the validated pending record.
    fs.rmSync(archivedPath, { force: true });
  }
}

/** Make deletion markers authoritative over stale metadata sources and snapshots. */
function enforceClaudeArchiveMarkers(store: ProfilesStore): void {
  // Parsing a sidecar/snapshot must remain read-only. In particular, an old tombstone
  // must never recreate a marker that an explicit restore already removed. New markers
  // are created only by archiveClaudeProfile(), the voluntary-deletion commit point.
  for (const id of archiveMarkerProfileIds()) {
    const archivedMarker = readClaudeArchiveMarker(id);
    const restorePendingMarker = readClaudeArchiveRestorePendingMarker(id);
    const marker = archivedMarker ?? restorePendingMarker;
    if (!marker) continue;
    const staleProfile = store.profiles.find((profile) => profile.id === id);
    const existing = (store.tombstones ?? []).find((tombstone) => tombstone.id === id);
    const restoreCommitted = !archivedMarker
      && !!restorePendingMarker
      && !!staleProfile
      && !!existing?.restoredAt
      && existing.restoredAt >= existing.deletedAt;
    // profiles.json is one atomic commit record for the row + restoredAt transition.
    // If it proves the restore committed, a leftover pending marker from a sidecar or
    // cleanup crash must not hide the recovered account. Otherwise the marker still
    // suppresses stale pre-deletion snapshots and leaves the tombstone retryable.
    if (restoreCommitted) continue;
    if (!existing || Math.max(existing.deletedAt, existing.restoredAt ?? 0) < marker.archivedAt) {
      const archivedProfile = marker.archivedProfile ?? (staleProfile ? withoutClaudeSecret(staleProfile) : undefined);
      store.tombstones = [
        ...(store.tombstones ?? []).filter((tombstone) => tombstone.id !== id),
        { id, provider: 'claude', deletedAt: marker.archivedAt, ...(archivedProfile ? { archivedProfile } : {}) },
      ];
    }
    store.profiles = store.profiles.filter((profile) => profile.id !== id);
    if (store.activeProfileId === id) store.activeProfileId = null;
    if (store.activeProfileIds?.claude === id) store.activeProfileIds.claude = null;
  }
}

function emptyStore(): ProfilesStore {
  return {
    version: STORE_VERSION,
    revision: 0,
    activeProfileId: null,
    activeProfileIds: { claude: null, codex: null },
    tombstones: [],
    profiles: [],
  };
}

function durableDesktopProfiles(): Profile[] {
  const profiles: Profile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(desktopStoreDir(), { withFileTypes: true });
  } catch {
    return profiles;
  }
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() || fs.existsSync(claudeArchiveMarker(entry.name))) continue;
      const dir = path.join(desktopStoreDir(), entry.name);
      let capturedAt: number;
      try {
        capturedAt = validateDesktopProfileSnapshot(dir, entry.name).capturedAt;
      } catch (validationError) {
        // A v1 bundle has no cryptographic manifest and is therefore never eligible
        // for application. Keep it as metadata recovery evidence so an upgrade cannot
        // make a Desktop-only account disappear; the switch path will ask for a safe
        // v2 recapture before touching live Desktop data.
        const legacy = JSON.parse(fs.readFileSync(path.join(dir, '.bundle.json'), 'utf8')) as {
          kind?: unknown;
          version?: unknown;
          profileId?: unknown;
          capturedAt?: unknown;
          entries?: unknown;
        };
        const legacyEntries = Array.isArray(legacy.entries)
          ? legacy.entries.filter((item): item is string => typeof item === 'string' && DESKTOP_BUNDLE_ENTRIES.includes(item))
          : [];
        if (legacy.kind !== 'claude-codex-account-switch/claude-desktop-bundle'
          || legacy.version !== 1
          || legacy.profileId !== entry.name
          || !Number.isFinite(legacy.capturedAt)
          || !legacyEntries.length
          || !legacyEntries.every((item) => fs.existsSync(path.join(dir, item)))) throw validationError;
        capturedAt = legacy.capturedAt as number;
        logger.warn('legacy Desktop bundle retained as recovery evidence; recapture required before switching', { profileId: entry.name });
      }
      profiles.push({
        id: entry.name,
        provider: 'claude',
        label: `Desktop account ${entry.name.slice(0, 8)}`,
        email: '(desktop account)',
        createdAt: capturedAt,
        updatedAt: capturedAt,
        desktopSnapshotDir: dir,
        desktopCapturedAt: capturedAt,
      });
    } catch {
      /* skip one corrupt/incomplete bundle and continue recovering the others */
    }
  }
  return profiles;
}

function reconstructStoreFromDurableProfiles(): ProfilesStore | null {
  const byId = new Map<string, Profile>();
  for (const id of credentialEnvelopeProfileIds()) {
    if (fs.existsSync(claudeArchiveMarker(id))) continue;
    const envelope = readCredentialEnvelope(id);
    const metadata = envelope?.profile;
    if (!envelope || !metadata || metadata.provider !== 'claude' || metadata.id !== id) continue;
    byId.set(id, { ...metadata, claudeAiOauth: envelope.claudeAiOauth, updatedAt: Date.now() });
  }
  for (const desktop of durableDesktopProfiles()) {
    const existing = byId.get(desktop.id);
    byId.set(desktop.id, existing
      ? {
          ...existing,
          desktopSnapshotDir: desktop.desktopSnapshotDir,
          desktopCapturedAt: desktop.desktopCapturedAt,
        }
      : desktop);
  }
  const profiles = [...byId.values()];
  if (!profiles.length) return null;
  return { ...emptyStore(), revision: 1, profiles };
}

/** Recover committed additions that reached their envelope but not a stale sidecar. */
function recoverMissingProfilesFromCredentialEnvelopes(store: ProfilesStore): void {
  const deleted = new Set((store.tombstones ?? [])
    .filter((tombstone) => tombstone.deletedAt > (tombstone.restoredAt ?? 0))
    .map((tombstone) => tombstone.id));
  for (const id of credentialEnvelopeProfileIds()) {
    if (store.profiles.some((profile) => profile.id === id)
      || deleted.has(id)
      || fs.existsSync(claudeArchiveMarker(id))) continue;
    const envelope = readCredentialEnvelope(id);
    const metadata = envelope?.profile;
    if (!envelope || !metadata || metadata.provider !== 'claude' || metadata.id !== id) continue;
    store.profiles.push({ ...metadata, claudeAiOauth: envelope.claudeAiOauth, updatedAt: envelope.updatedAt });
    logger.warn('recovered Claude profile metadata from credential envelope', { profileId: id });
  }
  for (const desktop of durableDesktopProfiles()) {
    if (deleted.has(desktop.id) || fs.existsSync(claudeArchiveMarker(desktop.id))) continue;
    const existing = store.profiles.find((profile) => profile.id === desktop.id);
    if (existing) {
      existing.desktopSnapshotDir ??= desktop.desktopSnapshotDir;
      existing.desktopCapturedAt ??= desktop.desktopCapturedAt;
      continue;
    }
    store.profiles.push(desktop);
    logger.warn('recovered Claude Desktop-only profile from bundle manifest', { profileId: desktop.id });
  }
}

function identityQuality(profile: Profile, activeProfileId: string | null): number {
  return (profile.id === activeProfileId ? 100 : 0)
    + (profile.accountUuid && !profile.accountUuid.startsWith('imported:') ? 20 : 0)
    + (isStableEmailIdentity(profile.email) ? 10 : 0)
    + (profile.desktopSnapshotDir ? 2 : 0);
}

/** Collapse duplicate rows that demonstrably carry the exact same rotating chain. */
function deduplicateExactCredentialChains(store: ProfilesStore): void {
  const byRefresh = new Map<string, Profile[]>();
  for (const profile of store.profiles) {
    const token = profile.claudeAiOauth?.refreshToken?.trim();
    if (!token) continue;
    const group = byRefresh.get(token) ?? [];
    group.push(profile);
    byRefresh.set(token, group);
  }
  for (const group of byRefresh.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => identityQuality(b, store.activeProfileId) - identityQuality(a, store.activeProfileId)
      || a.createdAt - b.createdAt
      || a.id.localeCompare(b.id));
    const winner = ordered[0];
    for (const duplicate of ordered.slice(1)) {
      if (!winner.desktopSnapshotDir && duplicate.desktopSnapshotDir) {
        winner.desktopSnapshotDir = duplicate.desktopSnapshotDir;
        winner.desktopCapturedAt = duplicate.desktopCapturedAt;
      }
      if (store.activeProfileId === duplicate.id) store.activeProfileId = winner.id;
      store.profiles = store.profiles.filter((profile) => profile.id !== duplicate.id);
      if (!(store.tombstones ?? []).some((tombstone) => tombstone.id === duplicate.id)) {
        store.tombstones = [
          ...(store.tombstones ?? []),
          {
            id: duplicate.id,
            provider: 'claude',
            deletedAt: Math.max(duplicate.updatedAt ?? duplicate.createdAt, winner.updatedAt ?? winner.createdAt),
          },
        ];
      }
      logger.warn('collapsed duplicate Claude profile sharing the same credential chain', { keptProfileId: winner.id, removedProfileId: duplicate.id });
    }
  }
  if (store.activeProfileIds) store.activeProfileIds.claude = store.activeProfileId;
}

export function assertNoAmbiguousClaudeCredentialOwners(store: ProfilesStore): void {
  const identities = new Map<string, string[]>();
  for (const profile of store.profiles) {
    const accountId = profile.accountUuid || profile.oauthAccount?.accountUuid;
    if (!accountId || accountId.startsWith('imported:')) continue;
    const group = identities.get(accountId) ?? [];
    group.push(profile.id);
    identities.set(accountId, group);
  }
  const ambiguous = [...identities.values()].filter((ids) => ids.length > 1);
  if (ambiguous.length) {
    throw new Error(`Found ${ambiguous.length} Claude account identity collision(s). Token rotation was aborted until the duplicate profiles are resolved.`);
  }
}

/** Move a corrupt profiles.json aside for forensics (never silently overwrite it). */
function setCorruptAside(file = profilesPath()): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, `${file}.corrupt-${stamp}-${crypto.randomUUID().slice(0, 8)}`);
  } catch {
    /* ignore */
  }
}

/**
 * Load the store, NEVER destroying accounts. A corrupt/partial profiles.json (power cut,
 * antivirus lock, disk hiccup) used to fall through to an empty store — and the next save
 * would then overwrite the recoverable file, wiping every login. Now we recover, in order,
 * from: the last-known-good sidecar, then the newest account-set backup. A truly corrupt &
 * unrecoverable file is moved aside (kept), never overwritten in place.
 */
export function loadStore(): ProfilesStore {
  let mainText: string | null = null;
  try {
    mainText = fs.readFileSync(profilesPath(), 'utf8');
  } catch {
    mainText = null; // missing/unreadable — decide below (fresh install vs. lost main file)
  }

  if (mainText != null) {
    const s = parseStore(mainText);
    if (s) {
      const migrated = migrateLegacyStore(s);
      if (migrated.changed || mainText.includes('"claudeAiOauth"') || mainText.includes('"closeClaudeOnSwitch"')) saveStore(migrated.store);
      return migrated.store;
    }
    logger.error('profiles.json is corrupt — attempting recovery', undefined, { path: profilesPath() });
  }

  // 1) last-known-good sidecar (freshest tokens — written on every save)
  try {
    const s = parseStore(fs.readFileSync(lastGoodPath(), 'utf8'));
    if (s && (s.profiles.length || mainText == null)) {
      if (mainText != null) setCorruptAside();
      logger.warn('recovered profiles from last-known-good sidecar', { count: s.profiles.length });
      saveStore(s);
      return migrateLegacyStore(s).store;
    }
  } catch {
    /* no sidecar */
  }

  // 2) newest usable account-set backup
  const backup = newestUsableBackup();
  if (backup) {
    if (mainText != null) setCorruptAside();
    logger.warn('recovered profiles from backup snapshot', { count: backup.profiles.length });
    saveStore(backup);
    return migrateLegacyStore(backup).store;
  }

  // 3) Emergency reconstruction from the independently mirrored v2 credential
  // envelopes. saveStore() intentionally refuses to overwrite corrupt evidence, so
  // quarantine that evidence and commit both metadata copies under the store lock.
  const reconstructed = reconstructStoreFromDurableProfiles();
  if (reconstructed) {
    return withFileLockSync('profiles-store', () => {
      const concurrent = readRecoverableStore();
      if (concurrent) return migrateLegacyStore(concurrent).store;
      ensureDataDirs();
      for (const file of [profilesPath(), lastGoodPath()]) {
        try {
          if (fs.statSync(file).size > 0) setCorruptAside(file);
        } catch {
          /* missing recovery source */
        }
      }
      persistCredentialEnvelopes(reconstructed);
      const content = serializeStore(reconstructed);
      atomicWriteFile(profilesPath(), content);
      atomicWriteFile(lastGoodPath(), content);
      logger.warn('reconstructed Claude metadata from credential envelopes', { count: reconstructed.profiles.length });
      return reconstructed;
    });
  }

  // 4) Nothing to recover — if the main file was non-empty garbage, keep it aside.
  if (mainText != null && mainText.trim()) {
    logger.error('profiles.json corrupt and unrecoverable — kept aside, starting empty');
    setCorruptAside();
  }
  return emptyStore();
}

/** A signature of the account *set* (not tokens/usage) to detect real changes. */
function accountsSignature(store: ProfilesStore): string {
  return JSON.stringify(
    store.profiles
      .map((p) => [p.id, p.label, p.email, p.accountUuid])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function isStableEmailIdentity(email?: string): boolean {
  const normalized = email?.trim().toLowerCase() ?? '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    && !/^\((?:unknown|imported|new account|desktop account)\)/i.test(normalized);
}

function accountKey(p: Profile): string {
  return (p.accountUuid || (isStableEmailIdentity(p.email) ? p.email : p.id)).trim().toLowerCase();
}

function sameAccount(a: Profile, b: Profile): boolean {
  return a.id === b.id || (!!a.accountUuid && a.accountUuid === b.accountUuid) || accountKey(a) === accountKey(b);
}

function copyCredentials(from: Profile, to: Profile): void {
  to.email = from.email;
  to.accountUuid = from.accountUuid;
  to.organizationUuid = from.organizationUuid;
  to.organizationUuidRoot = from.organizationUuidRoot;
  to.organizationType = from.organizationType;
  to.subscriptionType = from.subscriptionType;
  to.planObservedAt = from.planObservedAt;
  to.planSource = from.planSource;
  to.claudeAiOauth = from.claudeAiOauth;
  to.oauthAccount = from.oauthAccount;
  to.userID = from.userID;
  to.needsReauth = from.needsReauth;
}

function mergeWithDisk(next: ProfilesStore): ProfilesStore {
  const current = readRecoverableStore();
  if (!current) {
    if (hasStoreOrCredentialEvidence()) {
      throw new Error('Claude profile metadata is damaged and no safe snapshot could be recovered. Existing credentials were preserved; run doctor before writing.');
    }
    return next;
  }
  const knownIncoming = new Set([
    ...current.profiles.map((profile) => profile.id),
    ...next.profiles.map((profile) => profile.id),
    ...(current.tombstones ?? []).map((tombstone) => tombstone.id),
    ...(next.tombstones ?? []).map((tombstone) => tombstone.id),
  ]);
  const orphans = credentialEnvelopeProfileIds().filter((id) => !knownIncoming.has(id));
  if (orphans.length) {
    throw new Error(`Found ${orphans.length} untracked Claude credential envelope(s). Save aborted so recovery data cannot be hidden.`);
  }

  const tombstones = new Map<string, NonNullable<ProfilesStore['tombstones']>[number]>();
  for (const t of [...(current.tombstones ?? []), ...(next.tombstones ?? [])]) {
    const old = tombstones.get(t.id);
    const oldEventAt = old ? Math.max(old.deletedAt, old.restoredAt ?? 0) : 0;
    const eventAt = Math.max(t.deletedAt, t.restoredAt ?? 0);
    if (!old || oldEventAt < eventAt
      || (oldEventAt === eventAt && (old.restoredAt ?? 0) < (t.restoredAt ?? 0))) tombstones.set(t.id, t);
  }
  next.tombstones = [...tombstones.values()];
  const deleted = new Set([...tombstones.values()]
    .filter((t) => !t.restoredAt || t.deletedAt > t.restoredAt)
    .map((t) => t.id));
  next.profiles = next.profiles.filter((p) => !deleted.has(p.id));

  for (const diskProfile of current.profiles) {
    if (deleted.has(diskProfile.id)) continue;
    const incoming = next.profiles.find((p) => sameAccount(p, diskProfile));
    if (!incoming) {
      next.profiles.push(diskProfile);
      logger.warn('profiles save prevented account loss', { email: diskProfile.email });
      continue;
    }

    const diskOauth = diskProfile.claudeAiOauth;
    const incomingOauth = incoming.claudeAiOauth;
    const diskRefresh = diskOauth?.refreshToken?.trim() || '';
    const incomingRefresh = incomingOauth?.refreshToken?.trim() || '';

    if (diskRefresh && diskRefresh === incomingRefresh) {
      incoming.needsReauth = !!(diskProfile.needsReauth || incoming.needsReauth);
    }

    if (hasRefreshableOauth(diskOauth) && !hasRefreshableOauth(incomingOauth)) {
      copyCredentials(diskProfile, incoming);
      logger.warn('profiles save preserved refreshable credentials over invalid incoming copy', { email: incoming.email });
      continue;
    }

    if (
      hasRefreshableOauth(diskOauth) &&
      hasRefreshableOauth(incomingOauth) &&
      diskRefresh &&
      incomingRefresh &&
      diskRefresh !== incomingRefresh
    ) {
      copyCredentials(diskProfile, incoming);
      logger.warn('profiles save preserved the authoritative durable token over a conflicting snapshot', { email: incoming.email });
    }

    if ((diskProfile.usage?.fetchedAt ?? 0) > (incoming.usage?.fetchedAt ?? 0)) {
      incoming.usage = diskProfile.usage;
    }
  }

  const incomingActive = next.profiles.find((p) => p.id === next.activeProfileId);
  const diskActive = current.profiles.find((p) => p.id === current.activeProfileId);
  if (!incomingActive || ((diskActive?.lastUsedAt ?? 0) > (incomingActive.lastUsedAt ?? 0))) {
    next.activeProfileId = current.activeProfileId;
  }
  next.activeProfileIds = {
    claude: next.activeProfileId,
    codex: next.activeProfileIds?.codex ?? current.activeProfileIds?.codex ?? null,
  };
  next.version = STORE_VERSION;
  next.revision = Math.max(next.revision ?? 0, current.revision ?? 0) + 1;

  return next;
}

/**
 * Before overwriting profiles.json, snapshot the PREVIOUS version whenever the set of
 * accounts changed (add / delete / rename). This guarantees an account can never be
 * lost, even by an accidental delete. Usage/token-only updates don't create backups.
 */
function backupProfilesIfChanged(next: ProfilesStore): void {
  try {
    if (!fs.existsSync(profilesPath())) return;
    const prevText = fs.readFileSync(profilesPath(), 'utf8');
    let prev: ProfilesStore;
    try {
      prev = JSON.parse(prevText);
    } catch {
      return;
    }
    if (accountsSignature(prev) === accountsSignature(next)) return;
    const dir = path.join(backupsDir(), 'profiles');
    ensurePrivateDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    atomicWriteFile(path.join(dir, `profiles-${stamp}.json`), prevText);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    while (files.length > 40) {
      const f = files.shift()!;
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* ignore */
      }
    }
    logger.info('profiles snapshot backed up (accounts changed)', { dir });
  } catch {
    logger.warn('profiles backup failed');
  }
}

function credentialEnvelopeState(profile: Profile): string {
  return JSON.stringify({ credentials: profile.claudeAiOauth, profile: recoveryProfile(profile) });
}

function persistCredentialEnvelopes(store: ProfilesStore, previousStates?: ReadonlyMap<string, string>): void {
  for (const profile of store.profiles) {
    if (previousStates?.get(profile.id) === credentialEnvelopeState(profile)) continue;
    persistProfileCredentials(profile);
  }
}

function clearArchiveMarkersForCommittedProfiles(store: ProfilesStore): void {
  for (const profile of store.profiles) {
    fs.rmSync(claudeArchiveMarker(profile.id), { force: true });
    fs.rmSync(claudeArchiveRestorePendingMarker(profile.id), { force: true });
  }
}

/**
 * Persist a single rotating OAuth chain before any broader metadata write. This is
 * intentionally exported for the refresh path: after an OAuth server rotates a refresh
 * token, losing the process must never leave only the now-invalid predecessor on disk.
 */
export function persistProfileCredentials(
  profile: Profile,
  options: { expectedPreviousRefreshToken?: string } = {},
): void {
  if (!isClaudeCredentialBlock(profile.claudeAiOauth)) return;
  const previous = readCredentialEnvelope(profile.id);
  const incomingOauth = profile.claudeAiOauth;
  const previousRefresh = previous?.claudeAiOauth.refreshToken?.trim();
  const expectedPreviousRefreshToken = options.expectedPreviousRefreshToken?.trim();
  let effectiveOauth = incomingOauth;
  if (previous && JSON.stringify(previous.claudeAiOauth) !== JSON.stringify(incomingOauth)) {
    if (!expectedPreviousRefreshToken) {
      // Metadata writers may have hydrated an older generation before a concurrent
      // provider refresh committed. The durable journal is authoritative; never let a
      // rename/usage update resurrect the invalid predecessor.
      effectiveOauth = previous.claudeAiOauth;
      profile.claudeAiOauth = effectiveOauth;
      logger.warn('preserved newer durable Claude credential during stale metadata write', { profileId: profile.id });
    } else if (!previousRefresh || previousRefresh !== expectedPreviousRefreshToken) {
      throw new Error('Claude credential promotion lost its compare-and-swap race; the newer durable generation was preserved.');
    }
  } else if (expectedPreviousRefreshToken && previousRefresh && previousRefresh !== expectedPreviousRefreshToken) {
    throw new Error('Claude credential promotion predecessor no longer matches the durable generation.');
  }
  if (previous
    && JSON.stringify(previous.claudeAiOauth) === JSON.stringify(effectiveOauth)
    && credentialMirrorsMatch(profile)) return;
  const profileMetadata = recoveryProfile(profile);
  const envelope: ClaudeCredentialEnvelope = {
    kind: 'claude-codex-account-switch/claude-credentials',
    version: 2,
    provider: 'claude',
    profileId: profile.id,
    updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
    claudeAiOauth: effectiveOauth,
    profile: profileMetadata,
  };
  const content = JSON.stringify(envelope, null, 2) + '\n';
  const credentialChanged = !previous
    || JSON.stringify(previous.claudeAiOauth) !== JSON.stringify(effectiveOauth);
  if (credentialChanged) {
    // Append the provider-issued generation before replacing either canonical mirror.
    // A crash at any later point still leaves readCredentialEnvelope() able to recover
    // the newest chain, while the predecessor remains in its own immutable generation.
    ensurePrivateDir(claudeCredentialGenerationsDir(profile.id));
    if (previous) {
      const previousContent = `${JSON.stringify(previous, null, 2)}\n`;
      const previousName = `generation-${previous.updatedAt}-${crypto
        .createHash('sha256')
        .update(previous.claudeAiOauth.refreshToken ?? previousContent)
        .digest('hex')
        .slice(0, 16)}.json`;
      const previousFile = path.join(claudeCredentialGenerationsDir(profile.id), previousName);
      if (!fs.existsSync(previousFile)) atomicWriteFile(previousFile, previousContent);
    }
    const generationName = `generation-${envelope.updatedAt}-${crypto.randomUUID()}.json`;
    atomicWriteFile(path.join(claudeCredentialGenerationsDir(profile.id), generationName), content);
  }
  const target = claudeProfileCredentialsPath(profile.id);
  // The canonical file is authoritative. The mirror is a second independently
  // parseable copy; readCredentialEnvelope chooses the newest valid generation.
  const failures: unknown[] = [];
  let copies = 0;
  for (const file of [target, `${target}.bak`]) {
    try {
      atomicWriteFile(file, content);
      copies++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (copies === 0) {
    throw new AggregateError(failures, `Could not durably persist rotated credentials for ${profile.label}.`);
  }
  if (failures.length) {
    logger.warn('credential envelope mirror write failed; one durable copy remains', { profileId: profile.id });
  }
  if (credentialChanged) pruneClaudeCredentialGenerations(profile.id);
}

function serializeStore(store: ProfilesStore): string {
  const metadata = {
    ...store,
    profiles: store.profiles.map((profile) => {
      if (!isClaudeCredentialBlock(profile.claudeAiOauth)) return profile;
      const { claudeAiOauth: _secret, ...rest } = profile;
      return rest;
    }),
  };
  return JSON.stringify(metadata, null, 2) + '\n';
}

export function saveStore(store: ProfilesStore): void {
  withFileLockSync('profiles-store', () => {
    ensureDataDirs();
    const merged = mergeWithDisk(store);
    store.profiles = merged.profiles;
    store.activeProfileId = merged.activeProfileId;
    store.activeProfileIds = merged.activeProfileIds;
    store.revision = merged.revision;
    store.tombstones = merged.tombstones;
    store.version = STORE_VERSION;
    backupProfilesIfChanged(store);
    persistCredentialEnvelopes(store);
    const content = serializeStore(store);
    atomicWriteFile(profilesPath(), content);
    // Mirror the SAME known-valid content to the last-known-good sidecar. profiles.json and
    // its .bak are written back-to-back, so an interrupted write can corrupt at most one of
    // them — loadStore can always recover from the other, with the freshest tokens.
    try {
      atomicWriteFile(lastGoodPath(), content);
      clearArchiveMarkersForCommittedProfiles(store);
    } catch {
      /* sidecar is best-effort */
    }
  });
}

/**
 * Apply a targeted mutation to the freshest on-disk store while holding its lock.
 * Callers that only change one profile should use this instead of saving a UI snapshot
 * that may predate a concurrent token rotation, rename, import, or deletion.
 */
export function mutateStore(mutator: (store: ProfilesStore) => void): ProfilesStore {
  return withFileLockSync('profiles-store', () => {
    ensureDataDirs();
    const current = readRecoverableStore();
    if (!current && hasStoreOrCredentialEvidence()) {
      throw new Error('Claude profile metadata is damaged and no safe snapshot could be recovered. Mutation aborted; credentials remain untouched.');
    }
    const store = current ? migrateLegacyStore(current).store : emptyStore();
    const orphanIds = orphanedClaudeCredentialIds(store);
    if (orphanIds.length) {
      throw new Error(`Found ${orphanIds.length} untracked Claude credential envelope(s). Mutation aborted; run doctor and recover metadata first.`);
    }

    const previousEnvelopeStates = new Map(store.profiles.map((profile) => [profile.id, credentialEnvelopeState(profile)]));
    mutator(store);
    store.version = STORE_VERSION;
    store.revision = (store.revision ?? 0) + 1;
    store.tombstones = store.tombstones ?? [];
    store.activeProfileIds = {
      claude: store.activeProfileId,
      codex: store.activeProfileIds?.codex ?? null,
    };
    backupProfilesIfChanged(store);
    persistCredentialEnvelopes(store, previousEnvelopeStates);
    const content = serializeStore(store);
    atomicWriteFile(profilesPath(), content);
    atomicWriteFile(lastGoodPath(), content);
    clearArchiveMarkersForCommittedProfiles(store);
    return store;
  });
}

/**
 * Commit metadata derived from the two live Claude auth files while holding the same
 * lock as switch/restore. Lock order is always live-auth then profiles-store.
 */
export function mutateStoreWithLiveAccount(
  mutator: (store: ProfilesStore, live: LiveAccount) => void,
): ProfilesStore {
  return withFileLockSync('claude-live-auth', () => {
    const live = readLiveAccountUnlocked();
    return mutateStore((store) => mutator(store, live));
  });
}

/**
 * The OAuth token's `subscriptionType` isn't always populated (e.g. right after the
 * official isolated add-account flow). Fall back to deriving the plan from
 * `organizationType`, which Claude always sets (e.g. "claude_pro" -> "pro",
 * "claude_max" -> "max").
 */
export function subscriptionOf(oauth: ClaudeAiOauth | null, organizationType?: string): string | undefined {
  const direct = oauth?.subscriptionType as string | undefined;
  if (direct) return direct;
  if (organizationType) {
    const m = organizationType.match(/claude_(\w+)/i);
    if (m) return m[1].toLowerCase();
    return organizationType;
  }
  return undefined;
}

export interface LiveProfileFields {
  email: string;
  accountUuid: string;
  organizationUuid: string;
  organizationUuidRoot?: string;
  organizationType?: string;
  subscriptionType?: string;
  planObservedAt?: number;
  planSource?: Profile['planSource'];
  claudeAiOauth: ClaudeAiOauth;
  oauthAccount: OauthAccount;
  userID?: string;
}

/** A stable, non-reversible identity used only until Claude reports the real account. */
export function syntheticClaudeAccountId(oauth: ClaudeAiOauth): string {
  return `pending:${crypto
    .createHash('sha256')
    .update(`${oauth.accessToken}\0${oauth.refreshToken}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Commit a just-issued rotating chain before running any identity probe. OAuth codes
 * are one-shot, so this checkpoint deliberately creates a recoverable pending row and
 * its two credential envelopes before the caller performs further provider work.
 */
export function checkpointClaudeAuthorization(
  claudeAiOauth: ClaudeAiOauth,
): { store: ProfilesStore; profile: Profile } {
  if (!hasRefreshableOauth(claudeAiOauth)) {
    throw new Error('Claude authorization did not return a reusable refresh token.');
  }
  const accountUuid = syntheticClaudeAccountId(claudeAiOauth);
  let saved: Profile | undefined;
  const store = mutateStore((fresh) => {
    saved = fresh.profiles.find((profile) =>
      profile.claudeAiOauth?.refreshToken === claudeAiOauth.refreshToken);
    if (!saved) {
      saved = makeProfile({
        email: '(authorization pending)',
        accountUuid,
        organizationUuid: '',
        subscriptionType: subscriptionOf(claudeAiOauth),
        claudeAiOauth,
        oauthAccount: { accountUuid: '' },
      }, 'Pending Claude authorization');
      fresh.profiles.push(saved);
    } else {
      saved.claudeAiOauth = claudeAiOauth;
      saved.updatedAt = Date.now();
    }
    // This is not an expired credential. The flag prevents switching until the
    // account-scoped identity has also been captured and can be validated post-write.
    saved.needsReauth = true;
  });
  if (!saved) throw new Error('Claude authorization checkpoint did not commit a profile.');
  return { store, profile: saved };
}

/** Complete a checkpoint while the provider's isolated credential home still exists. */
export function finalizeClaudeAuthorization(
  pendingProfileId: string,
  fields: LiveProfileFields,
  label?: string,
): { store: ProfilesStore; profile: Profile } {
  let selected: Profile | undefined;
  const store = mutateStore((fresh) => {
    const pending = fresh.profiles.find((profile) => profile.id === pendingProfileId);
    if (!pending) throw new Error('The durable Claude authorization checkpoint is missing.');
    const realAccountId = fields.accountUuid && !fields.accountUuid.startsWith('pending:')
      ? fields.accountUuid
      : fields.oauthAccount.accountUuid;
    const existing = realAccountId
      ? fresh.profiles.find((profile) => profile.id !== pending.id
        && (profile.accountUuid === realAccountId || profile.oauthAccount?.accountUuid === realAccountId))
      : undefined;

    selected = existing ?? pending;
    const selectedPreviousRefresh = selected.claudeAiOauth?.refreshToken?.trim();
    if (selectedPreviousRefresh
      && selectedPreviousRefresh !== fields.claudeAiOauth.refreshToken.trim()) {
      // A provider-validated login/identity probe is an explicit credential promotion.
      // Journal the new chain with a CAS against the exact durable predecessor before
      // metadata or the superseded pending row can be changed.
      persistProfileCredentials({
        ...selected,
        ...fields,
        id: selected.id,
        provider: 'claude',
        label: selected.label,
        createdAt: selected.createdAt,
        updatedAt: Date.now(),
      }, { expectedPreviousRefreshToken: selectedPreviousRefresh });
    }
    copyFieldsInto(selected, fields);
    if (label) selected.label = label;
    else if (selected === pending
      && (selected.label === 'Pending Claude authorization'
        || selected.label === 'Unresolved live Claude authorization')) {
      selected.label = fields.oauthAccount.displayName || fields.email;
    }
    const identityResolved = !!fields.oauthAccount.accountUuid?.trim();
    selected.needsReauth = !identityResolved;

    if (existing) {
      // The checkpoint was a re-authorization of an already-known account. Keep its
      // canonical id, and archive the superseded pending envelope without presenting it
      // as a user-restorable deleted account.
      const archivedAt = Date.now();
      writeClaudeArchiveMarker(pending.id, archivedAt);
      fresh.profiles = fresh.profiles.filter((profile) => profile.id !== pending.id);
      fresh.tombstones = [
        ...(fresh.tombstones ?? []).filter((tombstone) => tombstone.id !== pending.id),
        { id: pending.id, provider: 'claude', deletedAt: archivedAt },
      ];
    }
  });
  if (!selected) throw new Error('Claude authorization finalization did not commit a profile.');
  return { store, profile: selected };
}

/** Read the current live account into profile fields (or null if not logged in). */
function profileFieldsFromLive(live: LiveAccount): LiveProfileFields | null {
  if (!live.oauthAccount) return null;
  if (!hasRefreshableOauth(live.claudeAiOauth)) {
    logger.warn('reconcile: live Claude Code OAuth block is missing refreshable tokens');
    return null;
  }
  const oa = live.oauthAccount;
  return {
    email: oa.emailAddress ?? '(unknown)',
    accountUuid: oa.accountUuid,
    organizationUuid: oa.organizationUuid ?? live.organizationUuidRoot ?? '',
    organizationUuidRoot: live.organizationUuidRoot,
    organizationType: oa.organizationType,
    subscriptionType: subscriptionOf(live.claudeAiOauth, oa.organizationType),
    planObservedAt: Date.now(),
    planSource: 'oauth-token',
    claudeAiOauth: live.claudeAiOauth,
    oauthAccount: oa,
    userID: live.userID,
  };
}

export function liveProfileFields(): LiveProfileFields | null {
  return profileFieldsFromLive(getLiveAccount());
}

export function makeProfile(fields: LiveProfileFields, label?: string): Profile {
  if (!hasRefreshableOauth(fields.claudeAiOauth)) {
    throw new Error('Refusing to create profile with invalid Claude Code OAuth credentials.');
  }
  return {
    id: crypto.randomUUID(),
    provider: 'claude',
    label: label ?? fields.oauthAccount.displayName ?? fields.email,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...fields,
  };
}

/** Overwrite a profile's credential fields from the given fields (keeps id/label/timestamps). */
export function copyFieldsInto(profile: Profile, fields: LiveProfileFields): Profile {
  if (!hasRefreshableOauth(fields.claudeAiOauth)) {
    throw new Error('Refusing to copy invalid Claude Code OAuth credentials into profile.');
  }
  profile.email = fields.email;
  profile.accountUuid = fields.accountUuid;
  profile.organizationUuid = fields.organizationUuid;
  profile.organizationUuidRoot = fields.organizationUuidRoot;
  profile.organizationType = fields.organizationType;
  profile.subscriptionType = fields.subscriptionType;
  if (fields.subscriptionType) {
    profile.planObservedAt = fields.planObservedAt ?? Date.now();
    profile.planSource = fields.planSource ?? 'oauth-token';
  }
  profile.claudeAiOauth = fields.claudeAiOauth;
  profile.oauthAccount = fields.oauthAccount;
  profile.userID = fields.userID;
  profile.updatedAt = Date.now();
  return profile;
}

export function findByAccountUuid(store: ProfilesStore, accountUuid?: string): Profile | undefined {
  if (!accountUuid) return undefined;
  return store.profiles.find((p) => p.accountUuid === accountUuid);
}

export function findByEmail(store: ProfilesStore, email?: string): Profile | undefined {
  const key = email?.trim().toLowerCase();
  if (!key || !isStableEmailIdentity(key)) return undefined;
  return store.profiles.find((p) => p.email.trim().toLowerCase() === key);
}

/**
 * Capture Claude Desktop's currently-live (already logged-in) session as a profile.
 * Merges into an existing profile with the same email if one exists, so one person
 * ends up as one row carrying both a CLI and a Desktop capability.
 */
export function captureDesktopAccount(
  store: ProfilesStore,
  label: string,
  email: string,
  options: {
    linkProfileId?: string;
    replaceExistingSnapshot?: boolean;
    /** Deterministic test seam; production always uses the live OS process guard. */
    assertClaudeClosed?: () => void;
  } = {},
): Profile {
  // Email is manually typed and therefore cannot prove that the opaque Desktop session
  // belongs to a Claude Code credential. Default to an independent row. Linking is an
  // explicit, id-based operation and replacing a previous capture requires an additional
  // opt-in so a typo can never destroy or combine two account generations.
  const linked = options.linkProfileId
    ? store.profiles.find((candidate) => candidate.id === options.linkProfileId)
    : undefined;
  if (options.linkProfileId && !linked) throw new Error('The Claude profile selected for Desktop linking no longer exists.');
  if (linked?.desktopSnapshotDir && !options.replaceExistingSnapshot) {
    throw new Error(`Claude profile "${linked.label}" already has a Desktop snapshot. Explicit replacement confirmation is required.`);
  }
  const profile: Profile = linked ?? {
    id: newDesktopProfileId(),
    provider: 'claude',
    label: label || email || 'Desktop account',
    email: email || label || '(desktop account)',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const dir = snapshotLiveDesktopInto(profile.id, { assertClaudeClosed: options.assertClaudeClosed });
  profile.desktopSnapshotDir = dir;
  profile.desktopCapturedAt = Date.now();
  profile.updatedAt = Date.now();
  if (label) profile.label = label;
  if (!linked) store.profiles.push(profile);
  logger.info(linked ? 'desktop: explicitly linked to existing profile' : 'desktop: captured independent profile', {
    profileId: profile.id,
  });
  return profile;
}

export function getActive(store: ProfilesStore): Profile | undefined {
  return store.profiles.find((p) => p.id === store.activeProfileId);
}

/**
 * Make the store agree with what's actually live on disk:
 * - snapshot latest tokens into the matching profile (captures rotated refresh tokens)
 * - or create a new profile for the live account if unknown
 * - mark it active. Returns the reconciled store (mutated) and whether it changed.
 */
function reconcileWithLiveSnapshot(store: ProfilesStore, live: LiveAccount): { changed: boolean; activeId: string | null } {
  if (hasRefreshableOauth(live.claudeAiOauth) && !live.oauthAccount) {
    const exactTokenMatches = store.profiles.filter((candidate) =>
      candidate.claudeAiOauth?.refreshToken === live.claudeAiOauth!.refreshToken);
    if (exactTokenMatches.length !== 1) {
      throw new Error(
        exactTokenMatches.length > 1
          ? 'Multiple Claude profiles own the exact live refresh-token chain. Reconciliation aborted.'
          : 'Live Claude credentials are present but their account identity is unavailable. Active-account maintenance was aborted.',
      );
    }
    const profile = exactTokenMatches[0];
    profile.claudeAiOauth = live.claudeAiOauth;
    profile.organizationUuidRoot = live.organizationUuidRoot;
    profile.updatedAt = Date.now();
    store.activeProfileId = profile.id;
    profile.lastUsedAt ??= Date.now();
    logger.warn('reconcile: preserved exact-token active Claude profile while live identity is unavailable', {
      profileId: profile.id,
    });
    return { changed: true, activeId: profile.id };
  }
  const fields = profileFieldsFromLive(live);
  if (!fields) {
    logger.warn('reconcile: no live account (not logged in)');
    const active = getActive(store);
    if (active && hasCliAuth(active)) {
      // The metadata marker must not claim a saved profile is active when Claude's
      // actual live credential file is missing or unusable. The profile stays saved.
      store.activeProfileId = null;
      return { changed: true, activeId: null };
    }
    return { changed: false, activeId: store.activeProfileId };
  }
  const exactTokenMatches = store.profiles.filter((candidate) => candidate.claudeAiOauth?.refreshToken
    && candidate.claudeAiOauth.refreshToken === fields.claudeAiOauth.refreshToken);
  const activeClaudeTombstones = (store.tombstones ?? []).filter((tombstone) =>
    tombstone.provider === 'claude'
      && tombstone.archivedProfile?.provider === 'claude'
      && (!tombstone.restoredAt || tombstone.deletedAt > tombstone.restoredAt));
  const archivedTokenMatches = activeClaudeTombstones.filter((tombstone) =>
    readCredentialEnvelope(tombstone.id)?.claudeAiOauth.refreshToken === fields.claudeAiOauth.refreshToken);
  if (exactTokenMatches.length + archivedTokenMatches.length > 1) {
    throw new Error('Multiple Claude profiles own the exact live refresh-token chain. Reconciliation aborted before rotation.');
  }
  const archivedLiveAccount = activeClaudeTombstones.find((tombstone) =>
    tombstone.archivedProfile?.provider === 'claude'
      && tombstone.archivedProfile.accountUuid === fields.accountUuid);
  const identityProfile = findByAccountUuid(store, fields.accountUuid);
  const tokenProfile = exactTokenMatches[0];
  const tokenTombstone = archivedTokenMatches[0];
  const identityOwnerId = identityProfile?.id ?? archivedLiveAccount?.id;
  const tokenOwnerId = tokenProfile?.id ?? tokenTombstone?.id;
  const tokenOwnerAccountUuid = tokenProfile?.accountUuid
    ?? (tokenTombstone?.archivedProfile?.provider === 'claude'
      ? tokenTombstone.archivedProfile.accountUuid
      : undefined);
  const tokenProfileIsUnresolved = !!tokenProfile?.needsReauth
    && !!tokenProfile.accountUuid?.startsWith('pending:');
  const checkpointUnresolvedLiveChain = (reason: string): { changed: boolean; activeId: string | null } => {
    let candidate = tokenProfileIsUnresolved ? tokenProfile : undefined;
    if (!candidate) {
      const syntheticAccount = syntheticClaudeAccountId(fields.claudeAiOauth);
      candidate = makeProfile({
        email: '(authorization recovery)',
        accountUuid: syntheticAccount,
        organizationUuid: live.organizationUuidRoot?.trim() ?? '',
        organizationUuidRoot: live.organizationUuidRoot?.trim() || undefined,
        subscriptionType: subscriptionOf(fields.claudeAiOauth),
        claudeAiOauth: fields.claudeAiOauth,
        // Never copy the possibly stale .claude.json identity into the recovery row.
        // An explicit provider-backed identity probe/re-authentication must resolve it.
        oauthAccount: { accountUuid: '' },
      }, 'Unresolved live Claude authorization');
      candidate.needsReauth = true;
      store.profiles.push(candidate);
    }
    // The two live files do not yet prove one account. Keeping neither side marked active
    // prevents a later background refresh from attributing this chain to stale metadata.
    store.activeProfileId = null;
    logger.warn('reconcile: checkpointed ambiguous live Claude credential as a separate recovery profile', {
      profileId: candidate.id,
      reason,
    });
    return { changed: true, activeId: null };
  };
  if (!tokenProfileIsUnresolved
    && ((identityOwnerId && tokenOwnerId && identityOwnerId !== tokenOwnerId)
      || (tokenOwnerAccountUuid && tokenOwnerAccountUuid !== fields.accountUuid))) {
    throw new Error(
      'Claude live identity and refresh-token chain belong to different saved profiles. Reconciliation aborted without changing either credential envelope.',
    );
  }
  const credentialOrganization = live.organizationUuidRoot?.trim();
  const liveIdentityOrganization = live.oauthAccount?.organizationUuid?.trim();
  if (credentialOrganization && liveIdentityOrganization
    && credentialOrganization !== liveIdentityOrganization) {
    if (!tokenOwnerId) return checkpointUnresolvedLiveChain('organization-mismatch');
    throw new Error(
      'Claude live credential and identity files name different organizations. Reconciliation aborted until the official client finishes writing one coherent login.',
    );
  }
  // organizationUuid is a workspace, not an account identity: Team/Enterprise members
  // legitimately share it. Therefore a new chain can never overwrite a known identity
  // merely because both files name the same organization. Checkpoint it separately and
  // require an explicit provider-backed resolution/re-authentication.
  if ((identityOwnerId && !tokenOwnerId) || tokenProfileIsUnresolved) {
    return checkpointUnresolvedLiveChain(tokenProfileIsUnresolved ? 'identity-unresolved' : 'new-chain-for-known-identity');
  }
  if (archivedLiveAccount) {
    // Reconciliation is observation, not an explicit restore operation. Keep the
    // tombstone authoritative and never create a replacement id for the same account.
    // The live provider may nevertheless have rotated this chain since deletion; save
    // that newest generation in the archived envelope before another switch can replace
    // the live files. A failure here aborts the outer transaction and therefore blocks
    // all subsequent mutation until the chain is durably checkpointed.
    if (!archivedLiveAccount.archivedProfile || archivedLiveAccount.archivedProfile.provider !== 'claude') {
      throw new Error('Archived Claude identity metadata is unavailable; live rotation could not be checkpointed.');
    }
    const archivedCheckpoint: Profile = {
      ...archivedLiveAccount.archivedProfile,
      ...fields,
      id: archivedLiveAccount.id,
      provider: 'claude',
      label: archivedLiveAccount.archivedProfile.label,
      createdAt: archivedLiveAccount.archivedProfile.createdAt,
      updatedAt: Date.now(),
    };
    persistProfileCredentials(archivedCheckpoint);
    store.activeProfileId = null;
    logger.warn('reconcile: live Claude account is archived; explicit restore required', {
      profileId: archivedLiveAccount.id,
    });
    return { changed: true, activeId: null };
  }
  let profile = identityProfile ?? tokenProfile;
  let changed = false;
  if (!profile) {
    profile = makeProfile(fields);
    store.profiles.push(profile);
    changed = true;
    logger.info('reconcile: imported live account', { email: profile.email });
  } else {
    copyFieldsInto(profile, fields);
    changed = true;
  }
  if (store.activeProfileId !== profile.id) {
    store.activeProfileId = profile.id;
    changed = true;
  }
  profile.lastUsedAt = profile.lastUsedAt ?? Date.now();
  return { changed, activeId: profile.id };
}

/** Atomically reconcile one coherent live-auth generation into the durable profile store. */
export function reconcileStoreWithLive(
  after?: (store: ProfilesStore, result: { changed: boolean; activeId: string | null }) => void,
): ProfilesStore {
  return mutateStoreWithLiveAccount((store, live) => {
    const result = reconcileWithLiveSnapshot(store, live);
    after?.(store, result);
  });
}

export interface ClaudeReconcileProofOptions {
  processInventory?: () => ProcInfo[];
  /** Test seam: production reads `claude auth status --json` from the live official CLI. */
  authStatusProbe?: () => ClaudeAuthStatus | null;
  /** Test seam: production uses the official Claude CLI in an isolated config home. */
  identityProbe?: (
    profile: Profile,
    checkpoint: (identity: PrimedIdentity) => void,
  ) => PrimedIdentity;
}

function fieldsFromPrimedIdentity(identity: PrimedIdentity): LiveProfileFields {
  const oauthAccount = identity.oauthAccount;
  return {
    email: oauthAccount.emailAddress ?? '(identity unresolved)',
    accountUuid: oauthAccount.accountUuid || syntheticClaudeAccountId(identity.claudeAiOauth),
    organizationUuid: oauthAccount.organizationUuid ?? identity.organizationUuidRoot ?? '',
    organizationUuidRoot: identity.organizationUuidRoot,
    organizationType: oauthAccount.organizationType,
    subscriptionType: subscriptionOf(identity.claudeAiOauth, oauthAccount.organizationType),
    planObservedAt: Date.now(),
    planSource: 'oauth-token',
    claudeAiOauth: identity.claudeAiOauth,
    oauthAccount,
    userID: identity.userID,
  };
}

/**
 * Reconcile locally first so every unknown rotating chain is already durable, then use
 * an isolated official-CLI projection to resolve a normal live rotation. A shared
 * organization id is never considered proof: only the accountUuid written by the
 * provider into the isolated home can merge the pending generation.
 */
export function reconcileStoreWithProviderProof(
  after?: (store: ProfilesStore, result: { changed: boolean; activeId: string | null }) => void,
  options: ClaudeReconcileProofOptions = {},
): ProfilesStore {
  let store = reconcileStoreWithLive(after);
  if (!supportsIsolatedClaudeAuth()) return store;

  const live = getLiveAccount();
  if (!hasRefreshableOauth(live.claudeAiOauth)) return store;
  const pending = store.profiles.find((profile) =>
    profile.needsReauth
      && profile.accountUuid?.startsWith('pending:')
      && profile.claudeAiOauth?.refreshToken === live.claudeAiOauth!.refreshToken);
  if (!pending || !hasCliAuth(pending)) return store;

  // A running official Claude client can legitimately replace the complete OAuth chain,
  // not merely rotate one refresh token. Do not launch a second credential-owning client
  // beside it. Instead, combine three independent live/provider signals: the stable
  // accountUuid from Claude's identity file, and both email + organization from the
  // official non-secret `claude auth status --json` projection. Email is never sufficient
  // on its own, and a shared Team organization is never sufficient on its own.
  let authStatus: ClaudeAuthStatus | null = null;
  try {
    authStatus = options.authStatusProbe
      ? options.authStatusProbe()
      : options.identityProbe
        ? null
        : readClaudeAuthStatusSync();
  } catch (error) {
    logger.warn('Claude live auth-status proof was unavailable', { error: String(error) });
  }
  const initialLiveAccountUuid = live.oauthAccount?.accountUuid?.trim();
  const statusEmail = authStatus?.email?.trim().toLowerCase();
  const statusOrganization = authStatus?.organizationId?.trim();
  const statusAge = authStatus ? Date.now() - authStatus.observedAt : Number.POSITIVE_INFINITY;
  const identityMatches = initialLiveAccountUuid
    ? store.profiles.filter((profile) => profile.id !== pending.id
      && (profile.accountUuid?.trim() === initialLiveAccountUuid
        || profile.oauthAccount?.accountUuid?.trim() === initialLiveAccountUuid))
    : [];
  const statusTarget = identityMatches.length === 1 ? identityMatches[0] : undefined;
  const targetEmails = new Set([
    statusTarget?.email,
    statusTarget?.oauthAccount?.emailAddress,
  ].filter((value): value is string => isStableEmailIdentity(value)).map((value) => value.trim().toLowerCase()));
  const targetOrganizations = new Set([
    statusTarget?.organizationUuid,
    statusTarget?.organizationUuidRoot,
    statusTarget?.oauthAccount?.organizationUuid,
  ].filter((value): value is string => !!value?.trim()).map((value) => value.trim()));
  const liveOrganizations = [live.organizationUuidRoot, live.oauthAccount?.organizationUuid]
    .filter((value): value is string => !!value?.trim())
    .map((value) => value.trim());
  const statusProvesTarget = !!authStatus?.loggedIn
    && statusAge >= -60_000
    && statusAge <= 60_000
    && !!statusTarget
    && !!statusEmail
    && targetEmails.has(statusEmail)
    && !!statusOrganization
    && targetOrganizations.has(statusOrganization)
    && liveOrganizations.length > 0
    && liveOrganizations.every((organization) => organization === statusOrganization);

  if (statusProvesTarget && authStatus && statusTarget && statusEmail && statusOrganization) {
    const confirmedLive = getLiveAccount();
    const samePendingChain = confirmedLive.claudeAiOauth?.refreshToken === pending.claudeAiOauth.refreshToken;
    const sameAccountIdentity = confirmedLive.oauthAccount?.accountUuid?.trim() === initialLiveAccountUuid;
    if (!samePendingChain || !sameAccountIdentity) {
      logger.warn('Claude live authorization changed during auth-status proof; checkpointing the newer observation');
      return reconcileStoreWithLive(after);
    }
    const fields = profileFieldsFromLive(confirmedLive);
    if (fields) {
      fields.email = authStatus.email!.trim();
      fields.organizationUuid = statusOrganization;
      fields.organizationUuidRoot = confirmedLive.organizationUuidRoot ?? statusOrganization;
      fields.oauthAccount = {
        ...statusTarget.oauthAccount,
        ...confirmedLive.oauthAccount,
        accountUuid: initialLiveAccountUuid!,
        emailAddress: authStatus.email!.trim(),
        organizationUuid: statusOrganization,
      };
      fields.subscriptionType = authStatus.subscriptionType ?? statusTarget.subscriptionType
        ?? fields.subscriptionType;
      fields.planObservedAt = authStatus.observedAt;
      fields.planSource = 'claude-auth-status';
      try {
        const finalized = finalizeClaudeAuthorization(pending.id, fields);
        if (finalized.profile.id !== statusTarget.id || finalized.profile.needsReauth) {
          logger.warn('Claude auth-status proof resolved to an unexpected profile; live account remains unclaimed');
          return finalized.store;
        }
        logger.info('Claude official auth status promoted a normal live OAuth replacement', {
          profileId: finalized.profile.id,
        });
        return mutateStoreWithLiveAccount((fresh, observedLive) => {
          const chainUnchanged = observedLive.claudeAiOauth?.refreshToken === fields.claudeAiOauth.refreshToken;
          const identityUnchanged = observedLive.oauthAccount?.accountUuid?.trim() === initialLiveAccountUuid;
          if (!chainUnchanged || !identityUnchanged) {
            const result = reconcileWithLiveSnapshot(fresh, observedLive);
            after?.(fresh, result);
            return;
          }
          const selected = fresh.profiles.find((profile) => profile.id === statusTarget.id);
          if (!selected || selected.claudeAiOauth?.refreshToken !== fields.claudeAiOauth.refreshToken) {
            throw new Error('Claude canonical profile changed while auth-status proof was committing.');
          }
          fresh.activeProfileId = selected.id;
          selected.lastUsedAt ??= Date.now();
          after?.(fresh, { changed: true, activeId: selected.id });
        });
      } catch (error) {
        logger.warn('Claude auth-status proof could not be committed; recovery profile was retained', {
          profileId: pending.id,
          error: String(error),
        });
        return loadStore();
      }
    }
  }

  // Do not run a second credential-owning Claude process beside a live client, and do
  // not ask the isolated CLI to resolve an already-expired access token: either case
  // could rotate the chain out from under the official live process. The pending row
  // remains fully recoverable for a later quiescent run or explicit re-authorization.
  const processInventory = options.processInventory ?? findClaudeProcesses;
  let running: ProcInfo[];
  try {
    running = processInventory();
  } catch (error) {
    logger.warn('Claude identity proof skipped because process safety could not be verified', { error: String(error) });
    return store;
  }
  if (running.length || pending.claudeAiOauth.expiresAt <= Date.now() + 15 * 60_000) return store;

  let finalized: { store: ProfilesStore; profile: Profile } | undefined;
  const checkpoint = (identity: PrimedIdentity): void => {
    finalized = finalizeClaudeAuthorization(pending.id, fieldsFromPrimedIdentity(identity));
  };
  try {
    const identity = options.identityProbe
      ? options.identityProbe(pending, checkpoint)
      : primeIdentity({
          accessToken: pending.claudeAiOauth.accessToken,
          refreshToken: pending.claudeAiOauth.refreshToken,
          expiresAt: pending.claudeAiOauth.expiresAt,
          scopes: Array.isArray(pending.claudeAiOauth.scopes)
            ? pending.claudeAiOauth.scopes
            : String(pending.claudeAiOauth.scopes ?? '').split(/\s+/).filter(Boolean),
        }, findClaudeExe(), DEFAULT_SCOPES, checkpoint);
    if (!finalized) checkpoint(identity);
  } catch (error) {
    logger.warn('Claude ambiguous credential remains quarantined after identity proof failure', {
      profileId: pending.id,
      error: String(error),
    });
    return loadStore();
  }

  if (!finalized) return loadStore();
  store = finalized.store;
  const resolved = finalized.profile;
  const resolvedAccountUuid = resolved.oauthAccount?.accountUuid?.trim();
  const liveAccountUuid = live.oauthAccount?.accountUuid?.trim();
  if (!resolvedAccountUuid || resolved.needsReauth || resolvedAccountUuid !== liveAccountUuid || !hasCliAuth(resolved)) {
    // The provider proved this is another account (the classic same-org/stale-identity
    // midpoint), so retain it independently and leave the live pair unclaimed.
    return store;
  }

  const rotatedDuringProbe = resolved.claudeAiOauth.refreshToken !== live.claudeAiOauth.refreshToken;
  if (rotatedDuringProbe) {
    try {
      if (processInventory().length) return store;
      updateLiveCredentials(
        resolved.claudeAiOauth,
        resolved.organizationUuidRoot ?? resolved.organizationUuid,
      );
    } catch (error) {
      logger.warn('Claude proof resolved the account but live token synchronization was deferred', {
        profileId: resolved.id,
        error: String(error),
      });
      return store;
    }
  }
  return reconcileStoreWithLive(after);
}

// ---------- Import from files (another PC) ----------

/**
 * Build profile fields from raw Claude files copied from another machine.
 * `credsFile` = a .credentials.json (or credentials.json); `claudeJsonFile` optional
 * = a .claude.json to pull `oauthAccount`/`userID` from. Missing identity is tolerated
 * and self-heals on first switch.
 */
export function fieldsFromRawFiles(credsFile: string, claudeJsonFile?: string): LiveProfileFields | null {
  let claudeAiOauth: ClaudeAiOauth | null = null;
  let organizationUuidRoot: string | undefined;
  try {
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
    claudeAiOauth = creds.claudeAiOauth ?? null;
    organizationUuidRoot = creds.organizationUuid;
  } catch (e) {
    logger.error('import: failed to read credentials file', e, { credsFile });
    return null;
  }
  if (!claudeAiOauth?.accessToken || !claudeAiOauth?.refreshToken) {
    logger.error('import: credentials file has no claudeAiOauth tokens', undefined, { credsFile });
    return null;
  }

  let oauthAccount: OauthAccount = { accountUuid: '' };
  let userID: string | undefined;
  if (claudeJsonFile) {
    try {
      const text = fs.readFileSync(claudeJsonFile, 'utf8');
      const errors: ParseError[] = [];
      const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
      if (!tree || errors.length) throw new Error('Invalid Claude JSONC identity file.');
      const accountNode = findNodeAtLocation(tree, ['oauthAccount']);
      const userNode = findNodeAtLocation(tree, ['userID']);
      if (accountNode) oauthAccount = getNodeValue(accountNode) as OauthAccount;
      if (userNode) userID = getNodeValue(userNode) as string;
    } catch (e) {
      logger.warn('import: could not read .claude.json (identity will self-heal)', { claudeJsonFile });
    }
  }

  return {
    email: oauthAccount.emailAddress ?? '(imported)',
    accountUuid: oauthAccount.accountUuid || `imported:${crypto
      .createHash('sha256')
      .update(`${claudeAiOauth.accessToken}\0${claudeAiOauth.refreshToken}`)
      .digest('hex')
      .slice(0, 32)}`,
    organizationUuid: oauthAccount.organizationUuid ?? organizationUuidRoot ?? '',
    organizationUuidRoot,
    organizationType: oauthAccount.organizationType,
    subscriptionType: subscriptionOf(claudeAiOauth, oauthAccount.organizationType),
    claudeAiOauth,
    oauthAccount,
    userID,
  };
}

function fieldsFromExportRecord(data: PortableExport): LiveProfileFields {
  return {
    email: data.email,
    accountUuid: data.accountUuid,
    organizationUuid: data.organizationUuid,
    organizationUuidRoot: data.organizationUuidRoot,
    organizationType: data.organizationType,
    subscriptionType: data.subscriptionType,
    claudeAiOauth: data.claudeAiOauth,
    oauthAccount: data.oauthAccount,
    userID: data.userID,
  };
}

export interface ImportCandidate {
  source: string; // description shown to user
  fields: LiveProfileFields;
  label?: string; // preferred label (from an export)
}

/** Turn any *.ccswitch.json (single export OR full "export-all") into candidates. */
function candidatesFromCcswitchFile(file: string): ImportCandidate[] {
  const src = path.basename(file);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.kind === 'claude-account-switch/export-all' && Array.isArray(data.accounts)) {
      if (data.provider && data.provider !== 'claude') return [];
      return (data.accounts as PortableExport[]).map((a) => ({
        source: `${src} → ${a.email}`,
        fields: fieldsFromExportRecord(a),
        label: a.label,
      }));
    }
    if (data?.kind === 'claude-account-switch/export') {
      if (data.provider && data.provider !== 'claude') return [];
      return [{ source: src, fields: fieldsFromExportRecord(data as PortableExport), label: (data as PortableExport).label }];
    }
    // Unknown JSON — maybe a raw .credentials.json
    const raw = fieldsFromRawFiles(file);
    return raw ? [{ source: src, fields: raw }] : [];
  } catch (e) {
    logger.error('import: failed to parse .ccswitch.json', e, { file });
    return [];
  }
}

/**
 * Scan the import folder (~/.claude-switch/import) for anything importable:
 * *.ccswitch.json (single or full backup), or a raw .credentials.json (+ .claude.json).
 */
export function scanImportDir(): ImportCandidate[] {
  ensureDataDirs();
  const out: ImportCandidate[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(importDir());
  } catch {
    return out;
  }
  const full = (n: string) => path.join(importDir(), n);

  for (const n of entries.filter((n) => n.endsWith('.ccswitch.json'))) {
    out.push(...candidatesFromCcswitchFile(full(n)));
  }

  const credFile = entries.find((n) => n === '.credentials.json' || n === 'credentials.json');
  const cjFile = entries.find((n) => n === '.claude.json');
  if (credFile) {
    const f = fieldsFromRawFiles(full(credFile), cjFile ? full(cjFile) : undefined);
    if (f) out.push({ source: `${credFile}${cjFile ? ' + ' + cjFile : ''}`, fields: f });
  }
  return out;
}

/** Resolve an arbitrary path (file or directory) into import candidates. */
export function importFromPath(target: string): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return out;
  }
  if (stat.isDirectory()) {
    const cred = ['.credentials.json', 'credentials.json'].map((n) => path.join(target, n)).find((p) => fs.existsSync(p));
    const cj = path.join(target, '.claude.json');
    if (cred) {
      const f = fieldsFromRawFiles(cred, fs.existsSync(cj) ? cj : undefined);
      if (f) out.push({ source: path.basename(target), fields: f });
    }
    for (const n of fs.readdirSync(target).filter((n) => n.endsWith('.ccswitch.json'))) {
      out.push(...candidatesFromCcswitchFile(path.join(target, n)));
    }
    return out;
  }
  // single file
  if (target.endsWith('.ccswitch.json')) {
    out.push(...candidatesFromCcswitchFile(target));
  } else {
    const f = fieldsFromRawFiles(target);
    if (f) out.push({ source: path.basename(target), fields: f });
  }
  return out;
}

/**
 * Add a candidate as a profile, merging only on provider identity or the exact
 * rotating credential chain. A typed/display email is never account ownership proof.
 */
export function addOrUpdateProfile(
  store: ProfilesStore,
  fields: LiveProfileFields,
  label?: string,
  options: { credentialSource?: 'portable-import' | 'validated-login' } = {},
): Profile {
  if (!hasRefreshableOauth(fields.claudeAiOauth)) {
    throw new Error('Imported Claude Code credentials are missing a refresh token.');
  }
  const exactCredentialMatches = store.profiles.filter((profile) =>
    profile.claudeAiOauth?.refreshToken === fields.claudeAiOauth.refreshToken);
  if (exactCredentialMatches.length > 1) {
    throw new Error('Multiple Claude profiles own the imported refresh-token chain. Resolve the duplicate before importing.');
  }
  const archived = (store.tombstones ?? []).find((t) => {
    if (t.provider !== 'claude' || t.archivedProfile?.provider !== 'claude'
      || (t.restoredAt && t.restoredAt >= t.deletedAt)) return false;
    return t.archivedProfile.accountUuid === fields.accountUuid;
  });
  if (archived && options.credentialSource !== 'validated-login') {
    throw new Error(
      'This Claude identity was voluntarily archived. Restore it explicitly first, or re-authenticate it through the official login flow; a portable import cannot resurrect it.',
    );
  }
  let existing = findByAccountUuid(store, fields.accountUuid)
    ?? exactCredentialMatches[0];
  if (!existing && archived?.archivedProfile?.provider === 'claude') {
      beginClaudeArchiveRestore(archived.id);
      existing = { ...archived.archivedProfile };
      store.profiles.push(existing);
      archived.restoredAt = Date.now();
  }
  if (existing) {
    const existingRefresh = existing.claudeAiOauth?.refreshToken?.trim();
    const incomingRefresh = fields.claudeAiOauth.refreshToken.trim();
    if (existingRefresh
      && incomingRefresh !== existingRefresh
      && options.credentialSource !== 'validated-login') {
      throw new Error(
        'Refusing to replace an existing Claude login from a portable import. Re-authenticate it through the official add/login flow instead.',
      );
    }
    if (existingRefresh
      && incomingRefresh !== existingRefresh
      && options.credentialSource === 'validated-login') {
      persistProfileCredentials({
        ...existing,
        ...fields,
        id: existing.id,
        provider: 'claude',
        label: existing.label,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      }, { expectedPreviousRefreshToken: existingRefresh });
    }
    copyFieldsInto(existing, fields);
    existing.needsReauth = false; // a fresh login means the account is healthy again
    existing.updatedAt = Date.now();
    if (label) existing.label = label;
    logger.info('import: updated existing profile', { email: existing.email });
    return existing;
  }
  const profile = makeProfile(fields, label);
  store.profiles.push(profile);
  logger.info('import: added new profile', { email: profile.email });
  return profile;
}

// ---------- Export (to another PC) ----------

/** Null when the profile has no claude-code credentials (e.g. Desktop-only) — nothing portable to write. */
function toExportRecord(profile: Profile): PortableExport | null {
  if (!hasCliAuth(profile)) return null;
  return {
    kind: 'claude-account-switch/export',
    version: 2,
    provider: 'claude',
    exportedAt: Date.now(),
    label: profile.label,
    email: profile.email,
    accountUuid: profile.accountUuid,
    organizationUuid: profile.organizationUuid,
    organizationUuidRoot: profile.organizationUuidRoot,
    organizationType: profile.organizationType,
    subscriptionType: profile.subscriptionType,
    claudeAiOauth: profile.claudeAiOauth,
    oauthAccount: profile.oauthAccount,
    userID: profile.userID,
  };
}

export interface ClaudeExportOptions {
  processInventory?: () => ProcInfo[];
}

function assertClaudeExportQuiescent(processInventory: () => ProcInfo[]): void {
  let running: ProcInfo[];
  try {
    running = processInventory();
  } catch (error) {
    throw new Error(
      `Claude export was refused because process safety could not be established: ${String((error as Error).message ?? error)}`,
      { cause: error },
    );
  }
  if (running.length) {
    throw new Error(
      `Close Claude before exporting credentials (process ${running.map((process) => process.pid).join(', ')}). No secrets were written.`,
    );
  }
}

function claudeExportCredentialLockName(profile: Pick<Profile, 'id' | 'accountUuid'>): string {
  // Must remain identical to usage.ts's rotating-token lock. The provider lock is
  // acquired first everywhere, so nesting these locks cannot invert switch/refresh order.
  return `oauth-refresh-${profile.accountUuid || profile.id}`;
}

async function withClaudeExportCredentialLocks<T>(
  lockNames: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const [next, ...remaining] = lockNames;
  if (!next) return operation();
  return withFileLock(next, () => withClaudeExportCredentialLocks(remaining, operation));
}

function sameLockSet(profiles: Profile[], expected: string[]): boolean {
  const current = [...new Set(profiles.filter(hasCliAuth).map(claudeExportCredentialLockName))].sort();
  return current.length === expected.length && current.every((lock, index) => lock === expected[index]);
}

export async function exportProfile(
  profile: Pick<Profile, 'id'>,
  options: ClaudeExportOptions = {},
): Promise<string> {
  const processInventory = options.processInventory ?? findClaudeProcesses;
  assertClaudeExportQuiescent(processInventory);
  return withFileLock('claude-provider-switch', async () => {
    assertClaudeExportQuiescent(processInventory);
    reconcileStoreWithProviderProof(undefined, { processInventory });
    const observed = loadStore().profiles.find((candidate) => candidate.id === profile.id);
    if (!observed) throw new Error('The selected Claude profile no longer exists. Nothing was exported.');
    const lockNames = hasCliAuth(observed) ? [claudeExportCredentialLockName(observed)] : [];
    return withClaudeExportCredentialLocks(lockNames, async () => {
      assertClaudeExportQuiescent(processInventory);
      const current = loadStore().profiles.find((candidate) => candidate.id === profile.id);
      if (!current) throw new Error('The selected Claude profile changed while export was waiting. Nothing was exported.');
      if (!sameLockSet([current], lockNames)) {
        throw new Error('The selected Claude credential identity changed while export was waiting. Retry the export.');
      }
      const record = toExportRecord(current);
      if (!record) throw new Error('This profile has no Claude Code credentials to export (Desktop-only accounts are not portable).');
      ensureDataDirs();
      const safeLabel = current.label.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'account';
      const file = path.join(exportDir(), `${safeLabel}.ccswitch.json`);
      atomicWriteFile(file, JSON.stringify(record, null, 2) + '\n');
      logger.info('exported profile', { email: current.email, file });
      return file;
    });
  });
}

export interface ClaudePortableExportResult {
  file: string;
  exportedCount: number;
  skippedDesktopOnly: Array<{ id: string; label: string }>;
}

/** Export every portable Claude Code credential; machine-bound Desktop sessions are reported, never implied. */
export async function exportAllProfiles(
  _callerSnapshot: ProfilesStore = loadStore(),
  options: ClaudeExportOptions = {},
): Promise<ClaudePortableExportResult> {
  const processInventory = options.processInventory ?? findClaudeProcesses;
  assertClaudeExportQuiescent(processInventory);
  return withFileLock('claude-provider-switch', async () => {
    assertClaudeExportQuiescent(processInventory);
    reconcileStoreWithProviderProof(undefined, { processInventory });
    const observed = loadStore();
    const lockNames = [...new Set(observed.profiles.filter(hasCliAuth).map(claudeExportCredentialLockName))].sort();
    return withClaudeExportCredentialLocks(lockNames, async () => {
      assertClaudeExportQuiescent(processInventory);
      const current = loadStore();
      if (!sameLockSet(current.profiles, lockNames)) {
        throw new Error('The Claude account set changed while export was waiting. Retry the export.');
      }
      ensureDataDirs();
      const accounts = current.profiles.map(toExportRecord).filter((record): record is PortableExport => record != null);
      const skippedDesktopOnly = current.profiles
        .filter((profile) => !hasCliAuth(profile))
        .map((profile) => ({ id: profile.id, label: profile.label }));
      const data: PortableExportAll = {
        kind: 'claude-account-switch/export-all',
        version: 2,
        provider: 'claude',
        exportedAt: Date.now(),
        accounts,
      };
      const file = path.join(exportDir(), `all-accounts.ccswitch.json`);
      atomicWriteFile(file, JSON.stringify(data, null, 2) + '\n');
      logger.info('exported portable Claude Code profiles', {
        exportedCount: accounts.length,
        skippedDesktopOnlyCount: skippedDesktopOnly.length,
        file,
      });
      return { file, exportedCount: accounts.length, skippedDesktopOnly };
    });
  });
}

function deleteProfileWithLive(store: ProfilesStore, id: string, live: LiveAccount): void {
  const profile = store.profiles.find((p) => p.id === id);
  if (profile) {
    if (store.activeProfileId === id) throw new Error('Cannot delete the active Claude account.');
    if (hasCliAuth(profile)) {
      const liveMatches = live.oauthAccount?.accountUuid === profile.oauthAccount.accountUuid
        || (!!live.claudeAiOauth?.refreshToken
          && live.claudeAiOauth.refreshToken === profile.claudeAiOauth.refreshToken);
      if (liveMatches) {
        throw new Error('Cannot archive the Claude account that is still live. Switch or log out first.');
      }
    }
    const deletedAt = Date.now();
    const archivedProfile = withoutClaudeSecret(profile);
    // This marker is the deletion commit point. It is written before metadata so an
    // old sidecar/snapshot can never silently resurrect a voluntarily removed account.
    // Credential envelopes remain intact and can still be restored explicitly.
    writeClaudeArchiveMarker(id, deletedAt, archivedProfile);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = path.join(backupsDir(), 'claude-deleted', `${stamp}-${id}`);
    try {
      const credentials = path.dirname(claudeProfileCredentialsPath(id));
      if (fs.existsSync(credentials)) fs.cpSync(credentials, path.join(archive, 'credentials'), { recursive: true });
      if (profile.desktopSnapshotDir && fs.existsSync(profile.desktopSnapshotDir)) {
        fs.cpSync(profile.desktopSnapshotDir, path.join(archive, 'desktop'), { recursive: true });
      }
    } catch (error) {
      logger.warn('claude deleted credential backup failed; canonical copy retained', { error: String(error) });
    }
    store.tombstones = [
      ...(store.tombstones ?? []).filter((t) => t.id !== id),
      { id, provider: 'claude', deletedAt, archivedProfile },
    ];
    logger.info('claude profile archived', { email: profile.email });
  }
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.activeProfileId === id) store.activeProfileId = null;
}

/** Archive a Claude profile only after proving against a coherent live-auth snapshot. */
export function archiveClaudeProfile(id: string): ProfilesStore {
  return mutateStoreWithLiveAccount((store, live) => deleteProfileWithLive(store, id, live));
}

/** Restore the most recently archived Claude profile without making it active. */
export function restoreLatestDeletedProfile(store: ProfilesStore): Profile | undefined {
  const tombstone = [...(store.tombstones ?? [])]
    .filter((t) => t.provider === 'claude' && t.archivedProfile?.provider === 'claude'
      && (!t.restoredAt || t.deletedAt > t.restoredAt))
    .sort((a, b) => b.deletedAt - a.deletedAt)[0];
  if (!tombstone?.archivedProfile || tombstone.archivedProfile.provider !== 'claude') return undefined;
  const archived = tombstone.archivedProfile as Omit<Profile, 'claudeAiOauth'>;
  const envelope = readCredentialEnvelope(archived.id);
  const restored: Profile = {
    ...archived,
    ...(envelope ? { claudeAiOauth: envelope.claudeAiOauth } : {}),
    ...(!envelope && archived.accountUuid ? { needsReauth: true } : {}),
    updatedAt: Date.now(),
  };
  // Publish a durable restore-pending marker transition first. If metadata commit is
  // interrupted, loadStore can distinguish a committed restored row from an old
  // tombstone and an explicit retry remains possible.
  beginClaudeArchiveRestore(tombstone.id);
  if (!store.profiles.some((profile) => profile.id === restored.id)) store.profiles.push(restored);
  tombstone.restoredAt = Date.now();
  logger.info('claude archived profile restored', { email: restored.email });
  return restored;
}
