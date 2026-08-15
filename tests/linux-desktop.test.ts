import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  configureLinuxDesktopDistrobox,
  linuxDesktopConfigPath,
  linuxDesktopGuide,
  loadLinuxDesktopConfig,
} from '../src/linuxDesktop';

test('Distrobox Desktop configuration stores structured no-shell launch descriptors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-linux-desktop-'));
  const previous = process.env.CLAUDE_SWITCH_HOME;
  process.env.CLAUDE_SWITCH_HOME = root;
  try {
    const file = configureLinuxDesktopDistrobox('ai-desktop-ubuntu');
    assert.equal(file, linuxDesktopConfigPath());
    const config = loadLinuxDesktopConfig();
    assert.ok(config);
    assert.equal(config.container, 'ai-desktop-ubuntu');
    assert.deepEqual(config.apps.claude, {
      exe: 'distrobox',
      args: ['enter', '--name', 'ai-desktop-ubuntu', '--', 'claude-desktop'],
    });
    assert.deepEqual(config.apps.codex, {
      exe: 'distrobox',
      args: ['enter', '--name', 'ai-desktop-ubuntu', '--', 'chatgpt'],
    });
    assert.equal(fs.readFileSync(file, 'utf8').includes('sh -c'), false);
    assert.throws(() => configureLinuxDesktopDistrobox('bad name; rm'), /unsupported characters/i);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_SWITCH_HOME;
    else process.env.CLAUDE_SWITCH_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CachyOS guide keeps privileged package installation explicit and links vendor docs', () => {
  const guide = linuxDesktopGuide('ai-desktop-ubuntu');
  assert.match(guide, /sudo pacman -S --needed podman distrobox/);
  assert.match(guide, /ubuntu:24\.04/);
  assert.match(guide, /code\.claude\.com\/docs\/en\/desktop-linux/);
  assert.match(guide, /learn\.chatgpt\.com\/docs\/linux\/linux-app/);
  assert.match(guide, /distrobox-export --app claude-desktop/);
  assert.match(guide, /distrobox-export --app chatgpt/);
  assert.match(guide, /never run automatically/i);
});
