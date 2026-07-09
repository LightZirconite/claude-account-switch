// Shared type definitions for the Claude Account Switcher.

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

export interface UsageInfo {
  fetchedAt: number;
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  /** Per-model scoped weekly limits, parsed from the `limits` array. */
  models?: ModelLimit[];
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
export interface Profile {
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
  activeProfileId: string | null;
  claudeVersion?: string;
  /** Whether a switch auto-closes running `claude` processes (default true). */
  closeClaudeOnSwitch?: boolean;
  profiles: Profile[];
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
  version: 1;
  exportedAt: number;
  accounts: PortableExport[];
}

/** Portable export file format (*.ccswitch.json) for moving an account between PCs. */
export interface PortableExport {
  kind: 'claude-account-switch/export';
  version: 1;
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
