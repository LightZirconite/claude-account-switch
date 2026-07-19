import { terminalSafeMetadata } from './providerMetadata';

export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 15_000;
const MAX_PROFILE_BODY_BYTES = 256 * 1024;

export interface ClaudeProfileObservation {
  observedAt: number;
  accountUuid: string;
  email?: string;
  displayName?: string;
  fullName?: string;
  organizationUuid?: string;
  organizationName?: string;
  organizationType?: string;
  billingType?: string;
  rateLimitTier?: string;
  subscriptionType?: string;
}

export interface ClaudeProfileFetchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function objectRecord(value: unknown, field: string, optional = false): Record<string, unknown> | undefined {
  if ((value === undefined || value === null) && optional) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Claude profile response contained an invalid ${field} object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(
  record: Record<string, unknown> | undefined,
  key: string,
  maxLength: number,
): string | undefined {
  if (!record || record[key] === undefined || record[key] === null) return undefined;
  if (typeof record[key] !== 'string') {
    throw new Error(`Claude profile response contained an invalid ${key} value.`);
  }
  return terminalSafeMetadata(record[key]).trim().slice(0, maxLength) || undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (record[key] === undefined || record[key] === null) return undefined;
  if (typeof record[key] !== 'boolean') {
    throw new Error(`Claude profile response contained an invalid ${key} value.`);
  }
  return record[key];
}

function subscriptionFromProfile(
  account: Record<string, unknown>,
  organizationType?: string,
): string | undefined {
  if (optionalBoolean(account, 'has_claude_max')) return 'max';
  if (optionalBoolean(account, 'has_claude_pro')) return 'pro';
  if (!organizationType) return undefined;
  const match = organizationType.match(/^claude[_-](.+)$/i);
  return terminalSafeMetadata(match?.[1] ?? organizationType).trim().toLowerCase().slice(0, 80) || undefined;
}

/** Strictly validate provider data before it can replace saved identity metadata. */
export function parseClaudeProfilePayload(
  value: unknown,
  observedAt = Date.now(),
): ClaudeProfileObservation {
  const root = objectRecord(value, 'root')!;
  const account = objectRecord(root.account, 'account')!;
  const organization = objectRecord(root.organization, 'organization', true);
  const accountUuid = optionalString(account, 'uuid', 160);
  if (!accountUuid) throw new Error('Claude profile response did not contain a stable account UUID.');
  const organizationType = optionalString(organization, 'organization_type', 80);
  return {
    observedAt,
    accountUuid,
    email: optionalString(account, 'email', 320),
    displayName: optionalString(account, 'display_name', 160),
    fullName: optionalString(account, 'full_name', 160),
    organizationUuid: optionalString(organization, 'uuid', 160),
    organizationName: optionalString(organization, 'name', 160),
    organizationType,
    billingType: optionalString(organization, 'billing_type', 80),
    rateLimitTier: optionalString(organization, 'rate_limit_tier', 80),
    subscriptionType: subscriptionFromProfile(account, organizationType),
  };
}

/**
 * Read identity metadata with the current access token only. This request never receives
 * a refresh token and therefore cannot rotate or replace the imported credential chain.
 */
export async function fetchClaudeProfileMetadata(
  accessToken: string,
  claudeVersion: string,
  options: ClaudeProfileFetchOptions = {},
): Promise<ClaudeProfileObservation> {
  const token = accessToken.trim();
  if (!token) throw new Error('Claude profile metadata requires a non-empty access token.');
  const timeoutMs = Math.max(1, Math.min(60_000, options.timeoutMs ?? PROFILE_TIMEOUT_MS));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const safeVersion = terminalSafeMetadata(claudeVersion).trim().replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 80) || 'unknown';
  const response = await (options.fetchImpl ?? fetch)(CLAUDE_PROFILE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-code/${safeVersion}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Claude profile metadata request failed with HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROFILE_BODY_BYTES) {
    throw new Error('Claude profile metadata response exceeded the safe size limit.');
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_PROFILE_BODY_BYTES) {
    throw new Error('Claude profile metadata response exceeded the safe size limit.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Claude profile metadata response was not valid JSON.');
  }
  return parseClaudeProfilePayload(payload);
}
