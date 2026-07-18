// Claude login is delegated to the official CLI in an isolated CLAUDE_CONFIG_DIR.
// The TUI also offers the portable paste-code flow for users authorizing on another PC.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { logger } from './logger';
import { parseTree, findNodeAtLocation, getNodeValue } from 'jsonc-parser';
import { hasRefreshableOauth, type ClaudeAiOauth, type OauthAccount } from './types';

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const MANUAL_REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
export const DEFAULT_SCOPES = 'org:create_api_key user:profile user:inference';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export interface ManualAuth {
  url: string;
  state: string;
  verifier: string;
}

export function buildManualAuth(scopes = DEFAULT_SCOPES): ManualAuth {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(32));
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: MANUAL_REDIRECT,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })}`;
  logger.info('oauth: built portable Claude authorization URL');
  return { url, state, verifier };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
}

async function postToken(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const reason = /invalid_grant/i.test(text)
      ? 'invalid_grant'
      : /invalid_request/i.test(text)
        ? 'invalid_request'
        : 'oauth_error';
    logger.warn('oauth: token endpoint failed', { status: res.status, reason });
    throw new Error(`OAuth token request failed (HTTP ${res.status}, ${reason}).`);
  }
  const d = (await res.json()) as Record<string, unknown>;
  const accessToken = typeof d.access_token === 'string' ? d.access_token.trim() : '';
  const returnedRefresh = typeof d.refresh_token === 'string' ? d.refresh_token.trim() : '';
  const previousRefresh = body.grant_type === 'refresh_token' ? body.refresh_token?.trim() : '';
  const refreshTokenValue = returnedRefresh || previousRefresh;
  const expiresIn = d.expires_in === undefined ? 28_800 : d.expires_in;
  if (!accessToken || !refreshTokenValue) {
    throw new Error('OAuth token endpoint returned an incomplete credential set. Existing credentials were preserved.');
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 365 * 24 * 60 * 60) {
    throw new Error('OAuth token endpoint returned an invalid access-token lifetime. Existing credentials were preserved.');
  }
  let scopes: string[] | undefined;
  if (typeof d.scope === 'string') scopes = d.scope.split(/\s+/).filter(Boolean);
  else if (Array.isArray(d.scope) && d.scope.every((scope) => typeof scope === 'string')) scopes = d.scope;
  else if (d.scope !== undefined) throw new Error('OAuth token endpoint returned an invalid scope projection. Existing credentials were preserved.');
  logger.info('oauth: token exchange ok');
  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes,
  };
}

export async function refreshToken(refresh: string): Promise<TokenSet> {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: CLIENT_ID,
  });
}

export async function exchangeCode(pasted: string, verifier: string, state: string): Promise<TokenSet> {
  const code = pasted.trim().split('#')[0].split('&')[0].trim();
  if (!code) throw new Error('The pasted Claude authorization code is empty.');
  return postToken({
    grant_type: 'authorization_code',
    code,
    state,
    client_id: CLIENT_ID,
    redirect_uri: MANUAL_REDIRECT,
    code_verifier: verifier,
  });
}

export interface PrimedIdentity {
  claudeAiOauth: ClaudeAiOauth;
  oauthAccount: OauthAccount;
  userID?: string;
  organizationUuidRoot?: string;
}

export type ClaudeCredentialCheckpoint = (identity: PrimedIdentity) => void;

export interface PrimeIdentityOptions {
  /** Test seam around the official CLI invocation; the isolated config path is never live. */
  runIdentityLookup?: (claudeExe: string, configDir: string) => { status: number | null; error?: unknown };
}

function extractNode<T>(text: string, key: string): T | undefined {
  const tree = parseTree(text);
  if (!tree) return undefined;
  const node = findNodeAtLocation(tree, [key]);
  return node ? (getNodeValue(node) as T) : undefined;
}

function isolatedClaudeEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_ACCOUNT_UUID;
  delete env.CLAUDE_CODE_USER_EMAIL;
  delete env.CLAUDE_CODE_ORGANIZATION_UUID;
  return env;
}

export function supportsIsolatedClaudeAuth(): boolean {
  return process.platform !== 'darwin';
}

function assertFileIsolatedClaudeAuth(): void {
  if (!supportsIsolatedClaudeAuth()) {
    throw new Error(
      'Safe parked-account capture is unavailable on macOS: Claude Code stores OAuth in the login Keychain, which is not proven to be isolated by CLAUDE_CONFIG_DIR. Existing live credentials were not touched.',
    );
  }
}

/** Resolve account identity without touching the user's live Claude configuration. */
export function primeIdentity(
  tokens: TokenSet,
  claudeExe: string,
  scopes = DEFAULT_SCOPES,
  checkpoint?: ClaudeCredentialCheckpoint,
  options: PrimeIdentityOptions = {},
): PrimedIdentity {
  assertFileIsolatedClaudeAuth();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-prime-'));
  const claudeAiOauth: ClaudeAiOauth = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes ?? scopes.split(' '),
  };
  let identity: PrimedIdentity = { claudeAiOauth, oauthAccount: { accountUuid: '' } };
  let removeTemporaryHome = true;
  try {
    fs.writeFileSync(path.join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const result = options.runIdentityLookup
      ? options.runIdentityLookup(claudeExe, tmp)
      : spawnSync(claudeExe, ['-p', 'hi', '--max-turns', '1'], {
          env: isolatedClaudeEnv(tmp),
          timeout: 60_000,
          encoding: 'utf8',
          windowsHide: true,
        });
    logger.info('oauth: isolated identity lookup finished', { status: result.status, hadError: !!result.error });

    // Read and validate the possibly-rotated chain before touching auxiliary identity
    // files. Once the provider rotates a refresh token, falling back to the input token
    // would persist an invalid predecessor and deleting this home would lose the account.
    let finalOauth: ClaudeAiOauth;
    let organizationUuidRoot: string | undefined;
    const credentials = path.join(tmp, '.credentials.json');
    try {
      const after = JSON.parse(fs.readFileSync(credentials, 'utf8')) as {
        claudeAiOauth?: ClaudeAiOauth;
        organizationUuid?: unknown;
      };
      if (!hasRefreshableOauth(after.claudeAiOauth)) {
        throw new Error('The isolated Claude credential file no longer contains a reusable refresh token.');
      }
      finalOauth = after.claudeAiOauth;
      organizationUuidRoot = typeof after.organizationUuid === 'string' ? after.organizationUuid : undefined;
    } catch (error) {
      removeTemporaryHome = false;
      logger.error('oauth: rotated credential recovery read failed; isolated home retained', error, { tmp });
      throw new Error(`Claude identity lookup may have rotated the login, but its credential file could not be verified. The isolated recovery home was retained at ${tmp}.`, {
        cause: error,
      });
    }

    let oauthAccount: OauthAccount = { accountUuid: '' };
    let userID: string | undefined;
    const claudeJson = path.join(tmp, '.claude.json');
    try {
      if (fs.existsSync(claudeJson)) {
        const text = fs.readFileSync(claudeJson, 'utf8');
        oauthAccount = extractNode<OauthAccount>(text, 'oauthAccount') ?? oauthAccount;
        userID = extractNode<string>(text, 'userID');
      }
    } catch (error) {
      // Identity metadata is enrichable later; the rotating credential is not. Continue
      // with an unresolved identity so the callback checkpoints the newest token chain.
      logger.warn('oauth: Claude identity metadata unavailable; credential will be parked', { error: String(error) });
    }
    identity = { claudeAiOauth: finalOauth, oauthAccount, userID, organizationUuidRoot };
    checkpoint?.(identity);
    return identity;
  } catch (error) {
    // The isolated home still contains the provider-issued rotating chain. Keeping it
    // is preferable to consuming a one-shot authorization and deleting the only copy.
    removeTemporaryHome = false;
    logger.error('oauth: durable identity checkpoint failed; isolated home retained', error, { tmp });
    const alreadyRecoveryError = !removeTemporaryHome
      && error instanceof Error
      && error.message.includes('isolated recovery home was retained');
    if (alreadyRecoveryError) throw error;
    throw new Error(`Claude credentials could not be committed; the isolated recovery home was retained at ${tmp}.`, {
      cause: error,
    });
  } finally {
    if (removeTemporaryHome) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Run the official `claude` login inside an isolated temp CLAUDE_CONFIG_DIR
 * (interactive). Returns the resulting identity after the user completes login.
 * The child inherits stdio so the user sees Claude's own login prompts.
 */
export function loginViaClaudeCli(
  claudeExe: string,
  email?: string,
  checkpoint?: ClaudeCredentialCheckpoint,
): Promise<PrimedIdentity | null> {
  try {
    assertFileIsolatedClaudeAuth();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-login-'));
    const env = isolatedClaudeEnv(tmp);
    logger.info('oauth: starting official isolated Claude login', { tmp });
    const args = ['auth', 'login', ...(email?.trim() ? ['--email', email.trim()] : [])];
    const child = spawn(claudeExe, args, { env, stdio: 'inherit' });
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      logger.error('oauth: official Claude login failed to start', error);
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve(null);
    });
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      let removeTemporaryHome = true;
      try {
        const credPath = [path.join(tmp, '.credentials.json'), path.join(tmp, 'credentials.json')]
          .find((candidate) => fs.existsSync(candidate));
        const cjPath = path.join(tmp, '.claude.json');
        if (!credPath) {
          resolve(null);
          return;
        }
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        let oauthAccount: OauthAccount = { accountUuid: '' };
        let userID: string | undefined;
        if (fs.existsSync(cjPath)) {
          const cjText = fs.readFileSync(cjPath, 'utf8');
          oauthAccount = extractNode<OauthAccount>(cjText, 'oauthAccount') ?? oauthAccount;
          userID = extractNode<string>(cjText, 'userID');
        }
        const identity: PrimedIdentity = {
          claudeAiOauth: creds.claudeAiOauth,
          oauthAccount,
          userID,
          organizationUuidRoot: creds.organizationUuid,
        };
        if (!hasRefreshableOauth(identity.claudeAiOauth)) {
          throw new Error('Official Claude login did not produce a reusable refresh token.');
        }
        checkpoint?.(identity);
        resolve(identity);
      } catch (e) {
        logger.error('oauth: official login snapshot failed', e);
        // Keep the official CLI home when it contains a credential that could not be
        // parsed or committed. It remains importable and is never silently discarded.
        removeTemporaryHome = false;
        reject(new Error(`Claude login capture failed; the isolated recovery home was retained at ${tmp}.`, { cause: e }));
      } finally {
        if (removeTemporaryHome) {
          try {
            fs.rmSync(tmp, { recursive: true, force: true });
          } catch {
            /* cleanup can be retried by the OS */
          }
        }
      }
    });
  });
}
