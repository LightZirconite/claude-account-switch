// OAuth flow to ADD a new account (native), plus refresh-grant + identity priming.
//
// NOTE: These endpoints are reverse-engineered from Claude Code and may change.
// If the native flow fails, the app falls back to the official `claude` login run in
// an isolated temp CLAUDE_CONFIG_DIR (see loginViaClaudeCli), which is always correct.
import http from 'node:http';
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
export const DEFAULT_SCOPES = 'user:inference user:profile';
// Candidate token endpoints (tried in order — sources disagree across versions).
const TOKEN_URLS = [
  'https://console.anthropic.com/v1/oauth/token',
  'https://console.anthropic.com/api/oauth/token',
  'https://claude.ai/v1/oauth/token',
];

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export interface PendingAuth {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
  waitForCode: (timeoutMs?: number) => Promise<string>;
  close: () => void;
}

/** Start a loopback server + build the authorize URL. Resolves the code automatically. */
export function startAuth(scopes: string = DEFAULT_SCOPES): PendingAuth {
  const { verifier, challenge } = makePkce();
  const state = base64url(crypto.randomBytes(16));

  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: unknown) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state');
      const respond = (title: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui;padding:3rem;text-align:center">` +
            `<h2>${title}</h2><p>You can close this tab and return to the terminal.</p></body></html>`,
        );
      };
      if (err) {
        respond('Authorization failed');
        rejectCode(new Error(`oauth error: ${err}`));
        return;
      }
      if (st !== state) {
        respond('State mismatch');
        rejectCode(new Error('state mismatch'));
        return;
      }
      if (!code) {
        respond('No code received');
        rejectCode(new Error('no code'));
        return;
      }
      respond('✓ Account authorized');
      resolveCode(code);
    } catch (e) {
      res.writeHead(500);
      res.end('error');
      rejectCode(e);
    }
  });

  server.listen(0, '127.0.0.1');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const redirectUri = `http://localhost:${port}/callback`;

  const url =
    AUTHORIZE_URL +
    '?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();

  logger.info('oauth: started loopback auth', { port, redirectUri });

  return {
    url,
    state,
    verifier,
    redirectUri,
    waitForCode: (timeoutMs = 300_000) =>
      Promise.race([
        codePromise,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('authorization timed out')), timeoutMs)),
      ]),
    close: () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
}

async function postToken(body: Record<string, string>): Promise<TokenSet> {
  let lastErr: unknown;
  for (const url of TOKEN_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = new Error(`token endpoint ${url} -> HTTP ${res.status}`);
        logger.warn('oauth: token endpoint failed', { url, status: res.status });
        continue;
      }
      const d = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
        scope?: string | string[];
      };
      logger.info('oauth: token exchange ok', { url });
      return {
        accessToken: d.access_token,
        refreshToken: d.refresh_token,
        expiresAt: Date.now() + (d.expires_in ?? 28800) * 1000,
        scopes: typeof d.scope === 'string' ? d.scope.split(' ') : d.scope,
      };
    } catch (e) {
      lastErr = e;
      logger.warn('oauth: token endpoint error', { url, error: String(e) });
    }
  }
  throw lastErr ?? new Error('token exchange failed on all endpoints');
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
  const cleanCode = code.split('#')[0].split('&')[0];
  return postToken({
    grant_type: 'authorization_code',
    code: cleanCode,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
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
