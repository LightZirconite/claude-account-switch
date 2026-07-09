// Claude login is delegated to the official CLI in an isolated CLAUDE_CONFIG_DIR.
// This module only serializes refresh-token rotation for saved parked accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from './logger';
import { parseTree, findNodeAtLocation, getNodeValue } from 'jsonc-parser';
import type { ClaudeAiOauth, OauthAccount } from './types';

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

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
    throw new Error(`Token refresh failed (HTTP ${res.status}, ${reason}).`);
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
 * Run the official `claude` login inside an isolated temp CLAUDE_CONFIG_DIR
 * (interactive). Returns the resulting identity after the user completes login.
 * The child inherits stdio so the user sees Claude's own login prompts.
 */
export function loginViaClaudeCli(claudeExe: string, email?: string): Promise<PrimedIdentity | null> {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-login-'));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
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
