import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_PROFILE_URL,
  fetchClaudeProfileMetadata,
  parseClaudeProfilePayload,
} from '../src/claudeProfile';
import {
  fieldsWithClaudeProfileMetadata,
  recoverClaudeImportMetadata,
  type ImportCandidate,
  type LiveProfileFields,
} from '../src/profiles';

function rawFields(): LiveProfileFields {
  return {
    email: '(imported)',
    accountUuid: 'imported:opaque',
    organizationUuid: '',
    claudeAiOauth: {
      accessToken: 'access-token-for-test',
      refreshToken: 'refresh-token-for-test',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile'],
    },
    oauthAccount: { accountUuid: '' },
  };
}

function providerPayload(): Record<string, unknown> {
  return {
    account: {
      uuid: 'account-real',
      email: 'real@example.test',
      display_name: 'Real Account',
      full_name: 'Real Person',
      has_claude_pro: true,
      has_claude_max: false,
    },
    organization: {
      uuid: 'organization-real',
      name: 'Personal',
      organization_type: 'claude_pro',
      billing_type: 'stripe_subscription',
      rate_limit_tier: 'default_claude_ai',
    },
  };
}

test('Claude profile parser extracts only bounded terminal-safe metadata', () => {
  const observation = parseClaudeProfilePayload({
    ...providerPayload(),
    account: {
      ...(providerPayload().account as Record<string, unknown>),
      display_name: 'Real\u001b[31m Account',
    },
  }, 1234);

  assert.deepEqual(observation, {
    observedAt: 1234,
    accountUuid: 'account-real',
    email: 'real@example.test',
    displayName: 'Real Account',
    fullName: 'Real Person',
    organizationUuid: 'organization-real',
    organizationName: 'Personal',
    organizationType: 'claude_pro',
    billingType: 'stripe_subscription',
    rateLimitTier: 'default_claude_ai',
    subscriptionType: 'pro',
  });
  assert.throws(
    () => parseClaudeProfilePayload({ account: { email: 'missing-id@example.test' } }),
    /stable account UUID/,
  );
  assert.throws(
    () => parseClaudeProfilePayload({
      account: { uuid: 'account', has_claude_pro: 'yes' },
    }),
    /invalid has_claude_pro/,
  );
});

test('Claude profile fetch uses only the access token and never returns credential material', async () => {
  const accessToken = 'access-secret-that-must-not-escape';
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify(providerPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const observation = await fetchClaudeProfileMetadata(accessToken, '2.1.0\r\nunsafe', { fetchImpl });
  const headers = new Headers(requestedInit?.headers);
  assert.equal(requestedUrl, CLAUDE_PROFILE_URL);
  assert.equal(requestedInit?.method, 'GET');
  assert.equal(headers.get('authorization'), `Bearer ${accessToken}`);
  assert.equal(headers.get('user-agent'), 'claude-code/2.1.0unsafe');
  assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20');
  assert.doesNotMatch(JSON.stringify(observation), /access-secret|refresh-token/);
});

test('Claude import metadata recovery enriches identity but remains offline-safe', async () => {
  const candidate: ImportCandidate = {
    source: '.credentials.json',
    sourcePath: 'C:\\transfer\\.credentials.json',
    consumedPaths: ['C:\\transfer\\.credentials.json'],
    format: 'raw-credentials',
    fields: rawFields(),
  };
  const onlineFetch = (async () => new Response(JSON.stringify(providerPayload()), { status: 200 })) as typeof fetch;
  const recovered = await recoverClaudeImportMetadata([candidate], '2.1.0', { fetchImpl: onlineFetch });
  assert.equal(recovered.verifiedCount, 1);
  assert.equal(recovered.unavailableCount, 0);
  assert.equal(recovered.candidates[0].fields.email, 'real@example.test');
  assert.equal(recovered.candidates[0].fields.accountUuid, 'account-real');
  assert.equal(recovered.candidates[0].fields.subscriptionType, 'pro');
  assert.equal(recovered.candidates[0].fields.planSource, 'claude-profile');
  assert.equal(recovered.candidates[0].fields.claudeAiOauth.refreshToken, 'refresh-token-for-test');

  const offlineFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const offline = await recoverClaudeImportMetadata([candidate], '2.1.0', { fetchImpl: offlineFetch });
  assert.equal(offline.verifiedCount, 0);
  assert.equal(offline.unavailableCount, 1);
  assert.equal(offline.candidates[0].fields.accountUuid, 'imported:opaque');
});

test('validated Claude profile metadata cannot modify the rotating token chain', () => {
  const fields = rawFields();
  const merged = fieldsWithClaudeProfileMetadata(fields, parseClaudeProfilePayload(providerPayload(), 999));
  assert.equal(merged.claudeAiOauth, fields.claudeAiOauth);
  assert.equal(merged.claudeAiOauth.accessToken, fields.claudeAiOauth.accessToken);
  assert.equal(merged.claudeAiOauth.refreshToken, fields.claudeAiOauth.refreshToken);
  assert.equal(merged.claudeAiOauth.expiresAt, fields.claudeAiOauth.expiresAt);
  assert.equal(merged.oauthAccount.accountUuid, 'account-real');
  assert.equal(merged.organizationUuidRoot, 'organization-real');
});
