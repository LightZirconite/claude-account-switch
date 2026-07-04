// The profiles store: saved accounts kept in ~/.claude-switch/profiles.json (plain JSON).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { profilesPath, ensureDataDirs, exportDir, importDir, backupsDir } from './paths';
import { getLiveAccount } from './claudeStore';
import { logger } from './logger';
import type { ClaudeAiOauth, OauthAccount, PortableExport, PortableExportAll, Profile, ProfilesStore } from './types';

export function loadStore(): ProfilesStore {
  try {
    const t = fs.readFileSync(profilesPath(), 'utf8');
    const s = JSON.parse(t) as ProfilesStore;
    if (!Array.isArray(s.profiles)) s.profiles = [];
    if (typeof s.version !== 'number') s.version = 1;
    return s;
  } catch {
    return { version: 1, activeProfileId: null, profiles: [] };
  }
}

/** A signature of the account *set* (not tokens/usage) to detect real changes. */
function accountsSignature(store: ProfilesStore): string {
  return JSON.stringify(
    store.profiles
      .map((p) => [p.id, p.label, p.email, p.accountUuid])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
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

export function saveStore(store: ProfilesStore): void {
  ensureDataDirs();
  backupProfilesIfChanged(store);
  const content = JSON.stringify(store, null, 2) + '\n';
  const tmp = profilesPath() + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, profilesPath());
  } catch {
    fs.writeFileSync(profilesPath(), content, 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The OAuth token's `subscriptionType` isn't always populated (e.g. right after the
 * manual paste-code add-account flow). Fall back to deriving the plan from
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
  if (!live.claudeAiOauth || !live.oauthAccount) return null;
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
  return {
    id: crypto.randomUUID(),
    label: label ?? fields.oauthAccount.displayName ?? fields.email,
    createdAt: Date.now(),
    ...fields,
  };
}

/** Overwrite a profile's credential fields from the given fields (keeps id/label/timestamps). */
export function copyFieldsInto(profile: Profile, fields: LiveProfileFields): Profile {
  profile.email = fields.email;
  profile.accountUuid = fields.accountUuid;
  profile.organizationUuid = fields.organizationUuid;
  profile.organizationUuidRoot = fields.organizationUuidRoot;
  profile.organizationType = fields.organizationType;
  profile.subscriptionType = fields.subscriptionType;
  profile.claudeAiOauth = fields.claudeAiOauth;
  profile.oauthAccount = fields.oauthAccount;
  profile.userID = fields.userID;
  return profile;
}

export function findByAccountUuid(store: ProfilesStore, accountUuid?: string): Profile | undefined {
  if (!accountUuid) return undefined;
  return store.profiles.find((p) => p.accountUuid === accountUuid);
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
      return (data.accounts as PortableExport[]).map((a) => ({
        source: `${src} → ${a.email}`,
        fields: fieldsFromExportRecord(a),
        label: a.label,
      }));
    }
    if (data?.kind === 'claude-account-switch/export') {
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

/** Add a candidate as a profile, merging if the account already exists. */
export function addOrUpdateProfile(store: ProfilesStore, fields: LiveProfileFields, label?: string): Profile {
  const existing = findByAccountUuid(store, fields.accountUuid);
  if (existing) {
    copyFieldsInto(existing, fields);
    existing.needsReauth = false; // a fresh login means the account is healthy again
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

function toExportRecord(profile: Profile): PortableExport {
  return {
    kind: 'claude-account-switch/export',
    version: 1,
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
  ensureDataDirs();
  const safeLabel = profile.label.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'account';
  const file = path.join(exportDir(), `${safeLabel}.ccswitch.json`);
  fs.writeFileSync(file, JSON.stringify(toExportRecord(profile), null, 2) + '\n', 'utf8');
  logger.info('exported profile', { email: profile.email, file });
  return file;
}

/** Export ALL accounts into a single portable file (full backup / whole-PC migration). */
export function exportAllProfiles(store: ProfilesStore): string {
  ensureDataDirs();
  const data: PortableExportAll = {
    kind: 'claude-account-switch/export-all',
    version: 1,
    exportedAt: Date.now(),
    accounts: store.profiles.map(toExportRecord),
  };
  const file = path.join(exportDir(), `all-accounts.ccswitch.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  logger.info('exported all profiles', { count: store.profiles.length, file });
  return file;
}

export function deleteProfile(store: ProfilesStore, id: string): void {
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.activeProfileId === id) store.activeProfileId = null;
}
