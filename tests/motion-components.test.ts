import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { render } from 'ink';
import { createElement as h, type ReactElement } from 'react';

import type { MotionPolicy } from '../src/motion';
import { CursorMark, RevealMark, Spinner, SwitchFlashMark } from '../src/motionComponents';

const animated: MotionPolicy = { animate: true, unicode: true };
const still: MotionPolicy = { animate: false, unicode: true };

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 20;
  isTTY = false;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
}

function mount(node: ReactElement) {
  const stdout = new FakeStdout();
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { stdout, instance };
}

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

test('an animated spinner advances frames and stops writing after unmount', async () => {
  const { stdout, instance } = mount(h(Spinner, { label: 'Switching Codex to Work…', policy: animated }));
  await delay(350);
  const glyphs = new Set(stdout.frames.map((frame) => plain(frame).trim().charAt(0)));
  assert.ok(glyphs.size >= 2, `expected several spinner frames, saw ${[...glyphs].join(' ')}`);
  assert.ok(stdout.frames.every((frame) => plain(frame).includes('Switching Codex to Work…')));
  instance.unmount();
  const afterUnmount = stdout.frames.length;
  await delay(300);
  assert.equal(stdout.frames.length, afterUnmount, 'the interval must be cleared on unmount');
});

test('a disabled spinner renders one static frame and starts no timer', async () => {
  const { stdout, instance } = mount(h(Spinner, { label: 'Refreshing usage… 2/4', policy: still }));
  await delay(300);
  const unique = new Set(stdout.frames.map(plain));
  assert.equal(unique.size, 1);
  assert.equal(plain(stdout.frames[0]).trim(), '• █████░░░░░ Refreshing usage… 2/4');
  instance.unmount();
});

test('the cursor settles after arriving and is static without motion', async () => {
  const moving = mount(h(CursorMark, { color: 'cyan', idleFrame: 0, policy: animated }));
  assert.equal(plain(moving.stdout.frames[0]).trimEnd(), '›');
  await delay(200);
  assert.equal(plain(moving.stdout.frames.at(-1) ?? '').trimEnd(), '❯');
  moving.instance.unmount();

  const fixed = mount(h(CursorMark, { color: 'cyan', idleFrame: 0, policy: still }));
  await delay(150);
  assert.deepEqual(fixed.stdout.frames.map((frame) => plain(frame).trimEnd()), ['❯']);
  fixed.instance.unmount();
});

test('a switch flash calls onDone exactly once and nothing after unmount', async () => {
  let done = 0;
  const reduced = mount(h(SwitchFlashMark, { tone: 'success', onDone: () => { done += 1; }, policy: { animate: false, unicode: true } }));
  assert.equal(plain(reduced.stdout.frames[0]).trim(), '✓');
  reduced.instance.unmount();
  await delay(50);
  assert.equal(done, 0, 'unmounting before the flash ends cancels it');

  const flashing = mount(h(SwitchFlashMark, { tone: 'error', onDone: () => { done += 1; }, policy: animated }));
  assert.equal(plain(flashing.stdout.frames[0]).trim(), '✗');
  await delay(1_500);
  assert.equal(done, 1);
  flashing.instance.unmount();
  await delay(150);
  assert.equal(done, 1);
});

test('the result mark reveals to its final glyph', async () => {
  const { stdout, instance } = mount(h(RevealMark, { tone: 'success', color: 'green', policy: animated }));
  assert.equal(plain(stdout.frames[0]).trim(), '·');
  await delay(250);
  assert.equal(plain(stdout.frames.at(-1) ?? '').trim(), '✓');
  instance.unmount();

  const fixed = mount(h(RevealMark, { tone: 'error', color: 'red', policy: still }));
  assert.equal(plain(fixed.stdout.frames[0]).trim(), '✗');
  fixed.instance.unmount();
});
