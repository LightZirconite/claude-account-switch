// ADD a new account using Claude's OFFICIAL manual (paste-code) flow:
// authorize on claude.ai -> you're redirected to console.anthropic.com/oauth/code/callback
// which shows a code -> you paste it back here -> we exchange it for tokens.
// This is portable: authorize in any browser, paste into the waiting tool.
//
// If this ever breaks, the app falls back to the official `claude` login run in an
// isolated temp CLAUDE_CONFIG_DIR (see loginViaClaudeCli), which is always correct.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { logger } from './logger';
import { parseTree, findNodeAtLocation, getNodeValue } from 'jsonc-parser';
import type { ClaudeAiOauth, OauthAccount } from './types';

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const MANUAL_REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
// Scopes used by the official Claude Code login (must match for the token to work).
export const DEFAULT_SCOPES = 'org:create_api_key user:profile user:inference';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export interface ManualAuth {
  url: string;
  state: string;
  verifier: string;
}

/**
 * Build the authorize URL for the manual paste-code flow. Returns the URL to open
 * (copy to clipboard) plus the PKCE verifier + state needed to exchange the pasted code.
 */
export function buildManualAuth(scopes: string = DEFAULT_SCOPES): ManualAuth {
  const { verifier, challenge } = makePkce();
  const state = base64url(crypto.randomBytes(32));
  const url =
    AUTHORIZE_URL +
    '?' +
    new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: MANUAL_REDIRECT,
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();
  logger.info('oauth: built manual auth url');
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
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn('oauth: token endpoint failed', { status: res.status, body: text.slice(0, 300) });
    throw new Error(`Token exchange failed (HTTP ${res.status}). ${text.slice(0, 160)}`);
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

/**
 * Exchange a pasted authorization code. The pasted string is typically "code#state";
 * we split it and send both, exactly like Claude's official flow.
 */
export async function exchangeCode(pasted: string, verifier: string, state: string): Promise<TokenSet> {
  // Pasted value is usually "code#state"; keep only the code part.
  const code = pasted.trim().split('#')[0].split('&')[0].trim();
  return postToken({
    grant_type: 'authorization_code',
    code,
    state, // the original state we generated (matches the reference implementation)
    client_id: CLIENT_ID,
    redirect_uri: MANUAL_REDIRECT,
    code_verifier: verifier,
  });
}

export async function refreshToken(refresh: string): Promise<TokenSet> {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: CLIENT_ID,
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

/**
 * Write tokens into an isolated temp CLAUDE_CONFIG_DIR and run `claude` once so it
 * populates `oauthAccount`. Returns the full identity, or a token-only fallback.
 */
export function primeIdentity(tokens: TokenSet, claudeExe: string, scopes: string): PrimedIdentity {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-'));
  const claudeAiOauth: ClaudeAiOauth = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes ?? scopes.split(' '),
  };
  try {
    fs.writeFileSync(path.join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth }, null, 2));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
    // A tiny headless call forces Claude to fetch the profile and write oauthAccount.
    const r = spawnSync(claudeExe, ['-p', 'hi'], { env, timeout: 60_000, encoding: 'utf8' });
    logger.info('oauth: identity prime finished', { status: r.status, hadError: !!r.error });

    let oauthAccount: OauthAccount = { accountUuid: '' };
    let userID: string | undefined;
    const cjPath = path.join(tmp, '.claude.json');
    if (fs.existsSync(cjPath)) {
      const cjText = fs.readFileSync(cjPath, 'utf8');
      oauthAccount = extractNode<OauthAccount>(cjText, 'oauthAccount') ?? oauthAccount;
      userID = extractNode<string>(cjText, 'userID');
    }
    let organizationUuidRoot: string | undefined;
    let finalOauth = claudeAiOauth;
    const credPath = path.join(tmp, '.credentials.json');
    if (fs.existsSync(credPath)) {
      try {
        const after = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        if (after.claudeAiOauth) finalOauth = after.claudeAiOauth;
        organizationUuidRoot = after.organizationUuid;
      } catch {
        /* keep original */
      }
    }
    return { claudeAiOauth: finalOauth, oauthAccount, userID, organizationUuidRoot };
  } catch (e) {
    logger.error('oauth: identity prime failed (token-only fallback)', e);
    return { claudeAiOauth, oauthAccount: { accountUuid: '' }, userID: undefined };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Fallback: run the official `claude` login inside an isolated temp CLAUDE_CONFIG_DIR
 * (interactive). Returns the resulting identity after the user completes login.
 * The child inherits stdio so the user sees Claude's own login prompts.
 */
export function loginViaClaudeCli(claudeExe: string): Promise<PrimedIdentity | null> {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-login-'));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
    logger.info('oauth: starting fallback claude login', { tmp });
    const child = spawn(claudeExe, ['/login'], { env, stdio: 'inherit' });
    child.on('exit', () => {
      try {
        const credPath = path.join(tmp, '.credentials.json');
        const cjPath = path.join(tmp, '.claude.json');
        if (!fs.existsSync(credPath)) {
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
        logger.error('oauth: fallback login snapshot failed', e);
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
