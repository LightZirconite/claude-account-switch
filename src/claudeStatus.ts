import { execFile, execFileSync } from 'node:child_process';
import { findClaudeExe } from './paths';

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  organizationId?: string;
  subscriptionType?: string;
  authMethod?: string;
  apiProvider?: string;
  observedAt: number;
}

function execFileText(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 512 * 1024,
      signal,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function parseClaudeAuthStatusPayload(value: unknown, observedAt = Date.now()): ClaudeAuthStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Claude auth status returned a non-object response.');
  }
  const data = value as Record<string, unknown>;
  const plan = data.subscriptionType ?? data.subscription_type ?? data.subscription;
  const organizationId = data.orgId ?? data.organizationId ?? data.organization_id;
  return {
    loggedIn: data.loggedIn === true || data.logged_in === true,
    ...(typeof data.email === 'string' && data.email.trim() ? { email: data.email.trim() } : {}),
    ...(typeof organizationId === 'string' && organizationId.trim()
      ? { organizationId: organizationId.trim() }
      : {}),
    ...(typeof plan === 'string' && plan.trim() ? { subscriptionType: plan.trim().toLowerCase() } : {}),
    ...(typeof data.authMethod === 'string' && data.authMethod.trim() ? { authMethod: data.authMethod.trim() } : {}),
    ...(typeof data.apiProvider === 'string' && data.apiProvider.trim() ? { apiProvider: data.apiProvider.trim() } : {}),
    observedAt,
  };
}

/** Read the official CLI's live auth projection without printing or retaining tokens. */
export async function readClaudeAuthStatus(signal?: AbortSignal): Promise<ClaudeAuthStatus | null> {
  try {
    return parseClaudeAuthStatusPayload(
      JSON.parse(await execFileText(findClaudeExe(), ['auth', 'status', '--json'], signal)),
    );
  } catch {
    // Older official CLI versions may not expose `auth status --json`. Callers retain
    // the last-known plan and treat this as an unavailable observation, never a logout.
    return null;
  }
}

/** Synchronous status read for the synchronous live-auth reconciliation transaction. */
export function readClaudeAuthStatusSync(): ClaudeAuthStatus | null {
  try {
    const stdout = execFileSync(findClaudeExe(), ['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    return parseClaudeAuthStatusPayload(JSON.parse(stdout));
  } catch {
    return null;
  }
}
