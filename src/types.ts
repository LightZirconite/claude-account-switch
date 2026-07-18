// Shared type definitions for the Claude + Codex Account Switcher.

export type ProviderId = 'claude' | 'codex';

export interface BaseProfile {
  id: string;
  provider: ProviderId;
  label: string;
  email: string;
  createdAt: number;
  updatedAt?: number;
  lastUsedAt?: number;
  needsReauth?: boolean;
}

/** The `claudeAiOauth` block stored in ~/.claude/.credentials.json */
export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[] | string;
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

/** Whether an OAuth block can still participate in Claude Code auth/refresh. */
export function hasRefreshableOauth(oauth: ClaudeAiOauth | null | undefined): oauth is ClaudeAiOauth {
  return (
    !!oauth &&
    typeof oauth.refreshToken === 'string' &&
    oauth.refreshToken.trim().length > 0 &&
    typeof oauth.expiresAt === 'number' &&
    Number.isFinite(oauth.expiresAt)
  );
}

/** The `oauthAccount` block stored in ~/.claude.json */
export interface OauthAccount {
  accountUuid: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationType?: string;
  organizationName?: string;
  displayName?: string;
  billingType?: string;
  organizationRole?: string;
  [key: string]: unknown;
}

export interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export type UsageStatus = 'ok' | 'rate_limited' | 'error' | 'stale' | 'never';

/** A per-model scoped limit (e.g. Opus / Sonnet / Fable weekly bucket). */
export interface ModelLimit {
  name: string;
  utilization: number;
  resets_at?: string | null;
}

/**
 * Evidence carried with Claude's dynamic `limits` projection.
 *
 * An explicit empty array proves that no scoped bucket applies. Missing, malformed,
 * or unsupported data must remain distinguishable so Best Now cannot silently treat
 * an unknown constraint as zero usage.
 */
export type ClaudeModelLimitsState =
  | 'absent'
  | 'empty'
  | 'complete'
  | 'malformed'
  | 'unsupported';

export interface UsageInfo {
  fetchedAt: number;
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  /** Per-model scoped weekly limits, parsed from the `limits` array. */
  models?: ModelLimit[];
  /** Completeness evidence for `models`; absent on legacy cached observations. */
  modelLimitsState?: ClaudeModelLimitsState;
  status: UsageStatus;
  error?: string;
}

/**
 * A saved account ("profile") that can be swapped in. One profile = one person.
 * A profile can carry a claude-code capability (token-level swap, plaintext),
 * a claude-desktop capability (opaque session-folder swap, since Desktop's tokens
 * are OS-encrypted and can't be read/written field by field), or both — in which
 * case switching to this profile swaps BOTH surfaces at once, since there's always
 * exactly one active profile ("one account active everywhere").
 */
export interface Profile extends BaseProfile {
  provider: 'claude';
  id: string;
  label: string; // user-editable display name
  email: string;
  // --- claude-code capability (present once this account has been added/imported for the CLI) ---
  accountUuid?: string;
  organizationUuid?: string;
  /** organizationUuid found at the root of .credentials.json (kept in sync) */
  organizationUuidRoot?: string;
  organizationType?: string;
  subscriptionType?: string;
  /** Last time/source that the plan was confirmed by the official Claude CLI. */
  planObservedAt?: number;
  planSource?: 'oauth-token' | 'claude-auth-status';
  claudeAiOauth?: ClaudeAiOauth;
  oauthAccount?: OauthAccount;
  userID?: string;
  usage?: UsageInfo;
  /** Set when the refresh token is rejected (invalid_grant) — the account must be re-added. */
  needsReauth?: boolean;
  // --- claude-desktop capability (present once this account has been captured from Desktop) ---
  /** Directory under ~/.claude-switch/desktop/ holding this account's captured session bundle. */
  desktopSnapshotDir?: string;
  desktopCapturedAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export type ClaudeProfile = Profile;

export interface CodexAuthFile {
  auth_mode: 'chatgpt' | string;
  OPENAI_API_KEY?: string | null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
    [key: string]: unknown;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexQuotaWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary?: CodexQuotaWindow | null;
  secondary?: CodexQuotaWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: number | null;
  } | null;
  /** Effective monthly spend/credit limit reported by current Codex app-server builds. */
  individualLimit?: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
}

export interface CodexUsageInfo {
  fetchedAt: number;
  status: UsageStatus;
  bucket?: CodexRateLimitBucket | null;
  buckets?: Record<string, CodexRateLimitBucket>;
  resetCredits?: number | null;
  /** Newer app-server responses expose a separate workspace spend-control gate. */
  spendControlReached?: boolean | null;
  error?: string;
}

export interface CodexProfile extends BaseProfile {
  provider: 'codex';
  accountId: string;
  planType?: string;
  usage?: CodexUsageInfo;
}

export type AccountProfile = ClaudeProfile | CodexProfile;

export interface ProfileTombstone {
  id: string;
  provider: ProviderId;
  deletedAt: number;
  /** A later explicit restore wins over stale writers carrying the deletion. */
  restoredAt?: number;
  /** Secret-free metadata used to undo a voluntary deletion. */
  archivedProfile?: Omit<Profile, 'claudeAiOauth'> | CodexProfile;
}

/** Narrows a Profile to one with its claude-code fields present (added/imported for the CLI). */
export function hasCliAuth(
  p: Profile,
): p is Profile & { claudeAiOauth: ClaudeAiOauth; oauthAccount: OauthAccount; accountUuid: string; organizationUuid: string } {
  return hasRefreshableOauth(p.claudeAiOauth) && !!p.oauthAccount;
}

/** Whether this profile has a captured Claude Desktop session bundle. */
export function hasDesktopAuth(p: Profile): p is Profile & { desktopSnapshotDir: string } {
  return !!p.desktopSnapshotDir;
}

export interface ProfilesStore {
  version: number;
  revision?: number;
  activeProfileId: string | null;
  activeProfileIds?: { claude: string | null; codex: string | null };
  tombstones?: ProfileTombstone[];
  claudeVersion?: string;
  profiles: Profile[];
}

export interface CodexProfilesStore {
  version: number;
  revision: number;
  activeProfileId: string | null;
  profiles: CodexProfile[];
  tombstones: ProfileTombstone[];
}

/** The snapshot of the currently-active live Claude account read from disk. */
export interface LiveAccount {
  claudeAiOauth: ClaudeAiOauth | null;
  organizationUuidRoot?: string;
  oauthAccount: OauthAccount | null;
  userID?: string;
}

/** A full backup of ALL accounts in one file (for migrating a whole PC). */
export interface PortableExportAll {
  kind: 'claude-account-switch/export-all';
  version: 1 | 2;
  provider?: 'claude';
  exportedAt: number;
  accounts: PortableExport[];
}

/** Portable export file format (*.ccswitch.json) for moving an account between PCs. */
export interface PortableExport {
  kind: 'claude-account-switch/export';
  version: 1 | 2;
  provider?: 'claude';
  exportedAt: number;
  label: string;
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
