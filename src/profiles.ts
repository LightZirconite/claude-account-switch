// The profiles store: saved accounts kept in ~/.claude-switch/profiles.json (plain JSON).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { claudeProfileCredentialsPath, profilesPath, ensureDataDirs, exportDir, importDir, backupsDir } from './paths';
import { getLiveAccount } from './claudeStore';
import { snapshotLiveDesktopInto, newDesktopProfileId, deleteDesktopSnapshot } from './desktopStore';
import { logger } from './logger';
import { withFileLockSync } from './locks';
import {
  hasCliAuth,
  hasRefreshableOauth,
  type ClaudeAiOauth,
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

interface ClaudeCredentialEnvelope {
  kind: 'claude-codex-account-switch/claude-credentials';
  version: 1;
  provider: 'claude';
  profileId: string;
  updatedAt: number;
  claudeAiOauth: ClaudeAiOauth;
}

function isClaudeCredentialBlock(value: unknown): value is ClaudeAiOauth {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return 'accessToken' in record || 'refreshToken' in record || 'expiresAt' in record || 'refreshTokenExpiresAt' in record;
}

function readCredentialEnvelope(profileId: string): ClaudeCredentialEnvelope | null {
  for (const file of [claudeProfileCredentialsPath(profileId), `${claudeProfileCredentialsPath(profileId)}.bak`]) {
    try {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCredentialEnvelope;
      if (
        envelope?.kind === 'claude-codex-account-switch/claude-credentials'
        && envelope.provider === 'claude'
        && envelope.profileId === profileId
        && isClaudeCredentialBlock(envelope.claudeAiOauth)
      ) return envelope;
    } catch {
      /* try the mirrored envelope */
    }
  }
  return null;
}

function hydrateCredentialEnvelopes(store: ProfilesStore): void {
  for (const profile of store.profiles) {
    // Legacy stores carry the credential inline and are migrated on the next save.
    if (isClaudeCredentialBlock(profile.claudeAiOauth)) continue;
    const envelope = readCredentialEnvelope(profile.id);
    if (envelope) profile.claudeAiOauth = envelope.claudeAiOauth;
  }
}

/** Parse + normalize store text, or null if it isn't a usable store. */
function parseStore(text: string): ProfilesStore | null {
  try {
    const s = JSON.parse(text) as ProfilesStore;
    if (!s || typeof s !== 'object' || !Array.isArray(s.profiles)) return null;
    if (typeof s.version !== 'number') s.version = 1;
    s.revision = Number.isFinite(s.revision) ? s.revision : 0;
    s.tombstones = Array.isArray(s.tombstones) ? s.tombstones : [];
    for (const p of s.profiles) {
      p.provider = 'claude';
      p.updatedAt = Number.isFinite(p.updatedAt) ? p.updatedAt : p.createdAt;
    }
    s.activeProfileIds = {
      claude: s.activeProfileIds?.claude ?? s.activeProfileId ?? null,
      codex: s.activeProfileIds?.codex ?? null,
    };
    s.activeProfileId = s.activeProfileIds.claude;
    hydrateCredentialEnvelopes(s);
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

/** Move a corrupt profiles.json aside for forensics (never silently overwrite it). */
function setCorruptAside(): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(profilesPath(), `${profilesPath()}.corrupt-${stamp}`);
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
      if (migrated.changed || mainText.includes('"claudeAiOauth"')) saveStore(migrated.store);
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

  // 3) nothing to recover — if the main file was non-empty garbage, keep it aside.
  if (mainText != null && mainText.trim()) {
    logger.error('profiles.json corrupt and unrecoverable — kept aside, starting empty');
    setCorruptAside();
  }
  return {
    version: STORE_VERSION,
    revision: 0,
    activeProfileId: null,
    activeProfileIds: { claude: null, codex: null },
    tombstones: [],
    profiles: [],
  };
}

/** A signature of the account *set* (not tokens/usage) to detect real changes. */
function accountsSignature(store: ProfilesStore): string {
  return JSON.stringify(
    store.profiles
      .map((p) => [p.id, p.label, p.email, p.accountUuid])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function accountKey(p: Profile): string {
  return (p.accountUuid || p.email || p.id).trim().toLowerCase();
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
  to.claudeAiOauth = from.claudeAiOauth;
  to.oauthAccount = from.oauthAccount;
  to.userID = from.userID;
  to.needsReauth = from.needsReauth;
}

function mergeWithDisk(next: ProfilesStore): ProfilesStore {
  let current: ProfilesStore | null = null;
  try {
    current = parseStore(fs.readFileSync(profilesPath(), 'utf8'));
  } catch {
    current = null;
  }
  if (!current) return next;

  const tombstones = new Map<string, NonNullable<ProfilesStore['tombstones']>[number]>();
  for (const t of [...(current.tombstones ?? []), ...(next.tombstones ?? [])]) {
    const old = tombstones.get(t.id);
    if (!old || old.deletedAt < t.deletedAt) tombstones.set(t.id, t);
  }
  next.tombstones = [...tombstones.values()];
  next.profiles = next.profiles.filter((p) => !tombstones.has(p.id));

  for (const diskProfile of current.profiles) {
    if (tombstones.has(diskProfile.id)) continue;
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
      diskRefresh !== incomingRefresh &&
      (incoming.needsReauth || (diskOauth.expiresAt ?? 0) > (incomingOauth.expiresAt ?? 0))
    ) {
      copyCredentials(diskProfile, incoming);
      logger.warn('profiles save preserved newer disk token over stale incoming copy', { email: incoming.email });
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
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `profiles-${stamp}.json`), prevText, 'utf8');
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

let saveSeq = 0;

/** Atomic write via a per-call temp file (unique so concurrent/other-process writes can't collide). */
function atomicWriteFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}-${saveSeq++}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch {
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function persistCredentialEnvelopes(store: ProfilesStore): void {
  for (const profile of store.profiles) {
    if (!isClaudeCredentialBlock(profile.claudeAiOauth)) continue;
    const envelope: ClaudeCredentialEnvelope = {
      kind: 'claude-codex-account-switch/claude-credentials',
      version: 1,
      provider: 'claude',
      profileId: profile.id,
      updatedAt: Date.now(),
      claudeAiOauth: profile.claudeAiOauth,
    };
    const content = JSON.stringify(envelope, null, 2) + '\n';
    const target = claudeProfileCredentialsPath(profile.id);
    atomicWriteFile(target, content);
    atomicWriteFile(`${target}.bak`, content);
  }
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
    let current = (() => {
      try {
        return parseStore(fs.readFileSync(profilesPath(), 'utf8'));
      } catch {
        return null;
      }
    })();
    if (!current) {
      try {
        current = parseStore(fs.readFileSync(lastGoodPath(), 'utf8'));
      } catch {
        current = null;
      }
    }
    const store = current
      ? migrateLegacyStore(current).store
      : {
          version: STORE_VERSION,
          revision: 0,
          activeProfileId: null,
          activeProfileIds: { claude: null, codex: null },
          tombstones: [],
          profiles: [],
        } satisfies ProfilesStore;

    mutator(store);
    store.version = STORE_VERSION;
    store.revision = (store.revision ?? 0) + 1;
    store.tombstones = store.tombstones ?? [];
    store.activeProfileIds = {
      claude: store.activeProfileId,
      codex: store.activeProfileIds?.codex ?? null,
    };
    backupProfilesIfChanged(store);
    persistCredentialEnvelopes(store);
    const content = serializeStore(store);
    atomicWriteFile(profilesPath(), content);
    atomicWriteFile(lastGoodPath(), content);
    return store;
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

interface LiveProfileFields {
  email: string;
  accountUuid: string;
  organizationUuid: string;
  organizationUuidRoot?: string;
  organizationType?: string;
  subscriptionType?: string;
  claudeAiOauth: ClaudeAiOauth;
  oauthAccount: OauthAccount;
  userID?: string;
}

/** Read the current live account into profile fields (or null if not logged in). */
export function liveProfileFields(): LiveProfileFields | null {
  const live = getLiveAccount();
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
    claudeAiOauth: live.claudeAiOauth,
    oauthAccount: oa,
    userID: live.userID,
  };
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
  if (!key) return undefined;
  return store.profiles.find((p) => p.email.trim().toLowerCase() === key);
}

/**
 * Capture Claude Desktop's currently-live (already logged-in) session as a profile.
 * Merges into an existing profile with the same email if one exists, so one person
 * ends up as one row carrying both a CLI and a Desktop capability.
 */
export function captureDesktopAccount(store: ProfilesStore, label: string, email: string): Profile {
  const existing = findByEmail(store, email);
  const profile: Profile =
    existing ??
    {
      id: newDesktopProfileId(),
      provider: 'claude',
      label: label || email || 'Desktop account',
      email: email || label || '(desktop account)',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  const dir = snapshotLiveDesktopInto(profile.id);
  profile.desktopSnapshotDir = dir;
  profile.desktopCapturedAt = Date.now();
  profile.updatedAt = Date.now();
  if (label) profile.label = label;
  if (!existing) store.profiles.push(profile);
  logger.info(existing ? 'desktop: linked to existing profile' : 'desktop: captured new profile', { email: profile.email });
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
export function reconcileWithLive(store: ProfilesStore): { changed: boolean; activeId: string | null } {
  const fields = liveProfileFields();
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
  let profile = findByAccountUuid(store, fields.accountUuid);
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
      const cj = JSON.parse(fs.readFileSync(claudeJsonFile, 'utf8'));
      if (cj.oauthAccount) oauthAccount = cj.oauthAccount;
      userID = cj.userID;
    } catch (e) {
      logger.warn('import: could not read .claude.json (identity will self-heal)', { claudeJsonFile });
    }
  }

  return {
    email: oauthAccount.emailAddress ?? '(imported)',
    accountUuid: oauthAccount.accountUuid || claudeAiOauth.accessToken.slice(-12),
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
 * Add a candidate as a profile, merging if the account already exists. Also merges
 * into a Desktop-only profile with the same email, so one person stays one row.
 */
export function addOrUpdateProfile(store: ProfilesStore, fields: LiveProfileFields, label?: string): Profile {
  if (!hasRefreshableOauth(fields.claudeAiOauth)) {
    throw new Error('Imported Claude Code credentials are missing a refresh token.');
  }
  const existing = findByAccountUuid(store, fields.accountUuid) ?? findByEmail(store, fields.email);
  if (existing) {
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

export function exportProfile(profile: Profile): string {
  const record = toExportRecord(profile);
  if (!record) throw new Error('This profile has no Claude Code credentials to export (Desktop-only accounts are not portable).');
  ensureDataDirs();
  const safeLabel = profile.label.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'account';
  const file = path.join(exportDir(), `${safeLabel}.ccswitch.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  logger.info('exported profile', { email: profile.email, file });
  return file;
}

/** Export ALL accounts into a single portable file (full backup / whole-PC migration). Desktop-only accounts are skipped. */
export function exportAllProfiles(store: ProfilesStore): string {
  ensureDataDirs();
  const data: PortableExportAll = {
    kind: 'claude-account-switch/export-all',
    version: 2,
    provider: 'claude',
    exportedAt: Date.now(),
    accounts: store.profiles.map(toExportRecord).filter((r): r is PortableExport => r != null),
  };
  const file = path.join(exportDir(), `all-accounts.ccswitch.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  logger.info('exported all profiles', { count: store.profiles.length, file });
  return file;
}

export function deleteProfile(store: ProfilesStore, id: string): void {
  const profile = store.profiles.find((p) => p.id === id);
  if (profile?.desktopSnapshotDir) deleteDesktopSnapshot(id);
  if (profile) {
    store.tombstones = [...(store.tombstones ?? []).filter((t) => t.id !== id), { id, provider: 'claude', deletedAt: Date.now() }];
  }
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.activeProfileId === id) store.activeProfileId = null;
}
