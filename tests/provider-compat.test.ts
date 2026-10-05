import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  AUTHORIZE_URL,
  buildManualAuth,
  CLIENT_ID,
  DEFAULT_SCOPES,
  exchangeCode,
  MANUAL_REDIRECT,
  refreshToken,
  TOKEN_URL,
} from '../src/oauth';
import { formatPlanLabel } from '../src/providerMetadata';
import {
  checkToolVersion,
  compareVersions,
  describeToolVersion,
  parseToolVersion,
  readVersionOutput,
  VERIFIED_TOOL_VERSIONS,
} from '../src/toolVersions';

test.afterEach(() => mock.restoreAll());

test('tool versions are parsed from both official --version formats', () => {
  assert.equal(parseToolVersion('2.1.289 (Claude Code)\n'), '2.1.289');
  assert.equal(parseToolVersion('codex-cli 0.153.4\n'), '0.153.4');
  assert.equal(parseToolVersion('codex-cli 0.154.0-alpha.2'), '0.154.0');
  assert.equal(parseToolVersion('v22.20.0'), '22.20.0');
  for (const unusable of ['', 'unknown', 'codex-cli', '1.2', null, undefined]) {
    assert.equal(parseToolVersion(unusable), null, String(unusable));
  }
});

test('versions compare numerically, not lexically', () => {
  assert.equal(compareVersions('2.1.290', '2.1.289'), 1);
  assert.equal(compareVersions('2.10.0', '2.9.99'), 1);
  assert.equal(compareVersions('0.153.4', '0.153.4'), 0);
  assert.equal(compareVersions('0.99.0', '0.153.4'), -1);
});

test('only a CLI newer than the verified release produces a diagnostics warning', () => {
  for (const tool of ['claude', 'codex'] as const) {
    const verified = VERIFIED_TOOL_VERSIONS[tool];
    const same = checkToolVersion(tool, `x ${verified}`);
    assert.equal(same.status, 'verified');
    assert.equal(same.warning, undefined);
    assert.match(describeToolVersion(same), /\(verified\)$/);

    const older = checkToolVersion(tool, '0.0.1');
    assert.equal(older.status, 'older');
    assert.equal(older.warning, undefined);

    const unknown = checkToolVersion(tool, null);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.installed, null);
    assert.equal(unknown.warning, undefined);
    assert.match(describeToolVersion(unknown), /^unknown/);

    const newer = checkToolVersion(tool, '999.0.0');
    assert.equal(newer.status, 'newer');
    assert.equal(newer.installed, '999.0.0');
    assert.match(newer.warning ?? '', new RegExp(`999\\.0\\.0 is newer than ${verified.replace(/\./g, '\\.')}`));
    assert.match(describeToolVersion(newer), /NEWER than verified/);
  }
  assert.match(checkToolVersion('claude', '999.0.0').warning ?? '', /^Claude Code /);
  assert.match(checkToolVersion('codex', '999.0.0').warning ?? '', /^Codex CLI /);
});

test('the async version probe resolves null instead of throwing for a missing CLI', async () => {
  assert.equal(await readVersionOutput(path.join(import.meta.dirname, 'no-such-cli-binary')), null);
  assert.equal(parseToolVersion(await readVersionOutput(process.execPath)), process.versions.node);
});

test('portable Claude authorization matches the current official OAuth configuration', () => {
  assert.equal(AUTHORIZE_URL, 'https://claude.com/cai/oauth/authorize');
  assert.equal(MANUAL_REDIRECT, 'https://platform.claude.com/oauth/code/callback');
  assert.equal(TOKEN_URL, 'https://platform.claude.com/v1/oauth/token');
  const url = new URL(buildManualAuth().url);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), MANUAL_REDIRECT);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const scopes = url.searchParams.get('scope')?.split(' ') ?? [];
  assert.deepEqual(scopes, DEFAULT_SCOPES.split(' '));
  for (const scope of ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers']) {
    assert.ok(scopes.includes(scope), scope);
  }
});

test('the code exchange posts to the current token endpoint with the matching redirect URI', async () => {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      refresh_token_expires_in: 86_400,
      scope: 'user:profile user:inference',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const before = Date.now();
  const tokens = await exchangeCode('pasted-code#state', 'verifier', 'state');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].body.redirect_uri, MANUAL_REDIRECT);
  assert.equal(calls[0].body.code, 'pasted-code');
  assert.deepEqual(tokens.scopes, ['user:profile', 'user:inference']);
  assert.ok((tokens.refreshTokenExpiresAt ?? 0) >= before + 86_400_000);
  assert.ok((tokens.refreshTokenExpiresAt ?? 0) <= Date.now() + 86_400_000);
});

for (const [label, value] of [
  ['absent', undefined],
  ['a string', '86400'],
  ['zero', 0],
  ['negative', -5],
  ['null', null],
] as const) {
  test(`a refresh_token_expires_in that is ${label} never blocks persisting a rotated token`, async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
      ...(value === undefined ? {} : { refresh_token_expires_in: value }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const tokens = await refreshToken('refresh-1');
    assert.equal(tokens.refreshToken, 'refresh-2');
    assert.equal(tokens.refreshTokenExpiresAt, undefined);
    assert.equal('refreshTokenExpiresAt' in tokens, false);
  });
}

test('current Codex PlanType variants render as their customer-facing tier', () => {
  for (const plan of ['self_serve_business_prolite', 'self_serve_business_usage_based', 'business']) {
    assert.equal(formatPlanLabel(plan), 'BUSINESS', plan);
  }
  for (const plan of ['ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise']) {
    assert.equal(formatPlanLabel(plan), 'ENTERPRISE', plan);
  }
  assert.equal(formatPlanLabel('edu'), 'EDU');
  assert.equal(formatPlanLabel('edu_plus'), 'EDU PLUS');
  assert.equal(formatPlanLabel('edu_pro'), 'EDU PRO');
  assert.equal(formatPlanLabel('prolite'), 'PRO');
  assert.equal(formatPlanLabel('unknown'), '—');
  // Claude subscription types share the formatter and must stay unchanged.
  assert.equal(formatPlanLabel('max'), 'MAX');
  assert.equal(formatPlanLabel('pro'), 'PRO');
});
