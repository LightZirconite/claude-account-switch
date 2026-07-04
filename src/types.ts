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

/** A saved account ("profile") that can be swapped in. */
export interface Profile {
  id: string;
  label: string; // user-editable display name
  email: string;
  accountUuid: string;
  organizationUuid: string;
  /** organizationUuid found at the root of .credentials.json (kept in sync) */
  organizationUuidRoot?: string;
  organizationType?: string;
  subscriptionType?: string;
  claudeAiOauth: ClaudeAiOauth;
  oauthAccount: OauthAccount;
  userID?: string;
  createdAt: number;
  lastUsedAt?: number;
  usage?: UsageInfo;
  /** Set when the refresh token is rejected (invalid_grant) — the account must be re-added. */
  needsReauth?: boolean;
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
