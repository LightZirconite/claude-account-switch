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
  const d = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    scope?: string | string[];
  };
  logger.info('oauth: token exchange ok');
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: Date.now() + (d.expires_in ?? 28800) * 1000,
    scopes: typeof d.scope === 'string' ? d.scope.split(' ') : d.scope,
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
  return env;
}

/** Resolve account identity without touching the user's live Claude configuration. */
export function primeIdentity(tokens: TokenSet, claudeExe: string, scopes = DEFAULT_SCOPES): PrimedIdentity {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-prime-'));
  const claudeAiOauth: ClaudeAiOauth = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes ?? scopes.split(' '),
  };
  try {
    fs.writeFileSync(path.join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const result = spawnSync(claudeExe, ['-p', 'hi', '--max-turns', '1'], {
      env: isolatedClaudeEnv(tmp),
      timeout: 60_000,
      encoding: 'utf8',
      windowsHide: true,
    });
    logger.info('oauth: isolated identity lookup finished', { status: result.status, hadError: !!result.error });

    let oauthAccount: OauthAccount = { accountUuid: '' };
    let userID: string | undefined;
    const claudeJson = path.join(tmp, '.claude.json');
    if (fs.existsSync(claudeJson)) {
      const text = fs.readFileSync(claudeJson, 'utf8');
      oauthAccount = extractNode<OauthAccount>(text, 'oauthAccount') ?? oauthAccount;
      userID = extractNode<string>(text, 'userID');
    }
    let finalOauth = claudeAiOauth;
    let organizationUuidRoot: string | undefined;
    const credentials = path.join(tmp, '.credentials.json');
    if (fs.existsSync(credentials)) {
      const after = JSON.parse(fs.readFileSync(credentials, 'utf8')) as {
        claudeAiOauth?: ClaudeAiOauth;
        organizationUuid?: string;
      };
      if (hasRefreshableOauth(after.claudeAiOauth)) finalOauth = after.claudeAiOauth;
      organizationUuidRoot = after.organizationUuid;
    }
    return { claudeAiOauth: finalOauth, oauthAccount, userID, organizationUuidRoot };
  } catch (error) {
    logger.error('oauth: isolated identity lookup failed', error);
    return { claudeAiOauth, oauthAccount: { accountUuid: '' } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Run the official `claude` login inside an isolated temp CLAUDE_CONFIG_DIR
 * (interactive). Returns the resulting identity after the user completes login.
 * The child inherits stdio so the user sees Claude's own login prompts.
 */
export function loginViaClaudeCli(claudeExe: string, email?: string): Promise<PrimedIdentity | null> {
  return new Promise((resolve) => {
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
        resolve({
          claudeAiOauth: creds.claudeAiOauth,
          oauthAccount,
          userID,
          organizationUuidRoot: creds.organizationUuid,
        });
      } catch (e) {
        logger.error('oauth: official login snapshot failed', e);
        resolve(null);
      } finally {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  });
}
