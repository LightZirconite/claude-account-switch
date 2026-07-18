import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getLiveAccount } from '../src/claudeStore';
import { credentialsPath } from '../src/paths';

test('Claude live auth uses the official dotted store when a stale undotted artifact also exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-claude-path-test-'));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousSwitchHome = process.env.CLAUDE_SWITCH_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CLAUDE_SWITCH_HOME = path.join(root, 'switch');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

  const dotted = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
  const undotted = path.join(process.env.CLAUDE_CONFIG_DIR, 'credentials.json');
  const staleArtifact = `${JSON.stringify({
    claudeAiOauth: {
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: Date.now() + 60_000,
    },
  })}\n`;

  try {
    fs.writeFileSync(dotted, `${JSON.stringify({
      claudeAiOauth: {
        accessToken: 'official-access',
        refreshToken: 'official-refresh',
        expiresAt: Date.now() + 60_000,
      },
      organizationUuid: 'official-org',
    })}\n`, 'utf8');
    fs.writeFileSync(undotted, staleArtifact, 'utf8');
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        accountUuid: 'official-account',
        organizationUuid: 'official-org',
      },
    })}\n`, 'utf8');

    assert.equal(credentialsPath(), dotted);
    assert.equal(getLiveAccount().claudeAiOauth?.refreshToken, 'official-refresh');
    assert.equal(fs.readFileSync(undotted, 'utf8'), staleArtifact);
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    if (previousSwitchHome === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previousSwitchHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
