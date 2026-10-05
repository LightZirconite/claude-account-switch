import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASCII_SPINNER_FRAMES,
  CURSOR_ARRIVING,
  CURSOR_SETTLED,
  cursorGlyph,
  FLASH_STEPS,
  flashFrame,
  flashSchedule,
  progressBar,
  progressFromLabel,
  resolveMotionPolicy,
  revealGlyph,
  spinnerFrameCount,
  spinnerGlyph,
  STATIC_FLASH_MS,
  UNICODE_SPINNER_FRAMES,
  type MotionPolicy,
} from '../src/motion';

const animated: MotionPolicy = { animate: true, unicode: true };
const asciiAnimated: MotionPolicy = { animate: true, unicode: false };
const still: MotionPolicy = { animate: false, unicode: true };

test('motion is enabled only for an interactive terminal without opt-outs', () => {
  assert.deepEqual(resolveMotionPolicy({}, true, 'linux'), { animate: true, unicode: true });
  assert.equal(resolveMotionPolicy({}, false, 'linux').animate, false, 'stdout is not a TTY');
  assert.equal(resolveMotionPolicy({ TERM: 'dumb' }, true, 'linux').animate, false);
  for (const value of ['1', 'true', 'yes', 'TRUE']) {
    assert.equal(resolveMotionPolicy({ CI: value }, true, 'linux').animate, false, `CI=${value}`);
    assert.equal(resolveMotionPolicy({ NO_ANIMATION: value }, true, 'darwin').animate, false);
    assert.equal(resolveMotionPolicy({ REDUCE_MOTION: value }, true, 'win32').animate, false);
  }
  assert.equal(resolveMotionPolicy({ NO_COLOR: '1' }, true, 'linux').animate, false);
  assert.equal(resolveMotionPolicy({ NO_COLOR: 'anything' }, true, 'linux').animate, false);
});

test('explicitly false or empty opt-out values keep motion enabled', () => {
  for (const value of ['', '0', 'false', 'no']) {
    assert.equal(resolveMotionPolicy({ CI: value, NO_ANIMATION: value, REDUCE_MOTION: value }, true, 'linux').animate, true);
  }
  // no-color.org: an empty NO_COLOR does not disable color.
  assert.equal(resolveMotionPolicy({ NO_COLOR: '' }, true, 'linux').animate, true);
});

test('legacy consoles fall back to ASCII spinner frames', () => {
  assert.equal(resolveMotionPolicy({}, true, 'win32').unicode, false, 'classic conhost');
  assert.equal(resolveMotionPolicy({ WT_SESSION: 'abc' }, true, 'win32').unicode, true, 'Windows Terminal');
  assert.equal(resolveMotionPolicy({ TERM_PROGRAM: 'vscode' }, true, 'win32').unicode, true);
  assert.equal(resolveMotionPolicy({ ConEmuANSI: 'ON' }, true, 'win32').unicode, true);
  assert.equal(resolveMotionPolicy({ TERM: 'xterm-256color' }, true, 'win32').unicode, true);
  assert.equal(resolveMotionPolicy({ TERM: 'linux' }, true, 'linux').unicode, false, 'Linux VT');
  assert.equal(resolveMotionPolicy({}, true, 'darwin').unicode, true);
});

test('spinner frames cycle, wrap and stay one column wide', () => {
  assert.equal(spinnerFrameCount(animated), UNICODE_SPINNER_FRAMES.length);
  assert.equal(spinnerFrameCount(asciiAnimated), ASCII_SPINNER_FRAMES.length);
  const seen = new Set<string>();
  for (let tick = 0; tick < UNICODE_SPINNER_FRAMES.length * 2; tick += 1) {
    const glyph = spinnerGlyph(tick, animated);
    assert.equal([...glyph].length, 1);
    seen.add(glyph);
  }
  assert.equal(seen.size, UNICODE_SPINNER_FRAMES.length);
  assert.equal(spinnerGlyph(UNICODE_SPINNER_FRAMES.length, animated), spinnerGlyph(0, animated));
  assert.equal(spinnerGlyph(-1, animated), UNICODE_SPINNER_FRAMES.at(-1));
  assert.equal(spinnerGlyph(5, asciiAnimated), ASCII_SPINNER_FRAMES[1]);
  for (const glyph of ASCII_SPINNER_FRAMES) assert.match(glyph, /^[\x20-\x7e]$/);
});

test('disabled motion uses one static spinner glyph and no frame cycle', () => {
  assert.equal(spinnerFrameCount(still), 1);
  const glyphs = new Set(Array.from({ length: 12 }, (_, tick) => spinnerGlyph(tick, still)));
  assert.equal(glyphs.size, 1);
  assert.equal(spinnerGlyph(3, { animate: false, unicode: false }), '*');
});

test('progress counters are read only from a trailing n/m suffix', () => {
  assert.deepEqual(progressFromLabel('Refreshing Codex usage… 3/7'), { completed: 3, total: 7 });
  assert.deepEqual(progressFromLabel('Refreshing usage… 0/2'), { completed: 0, total: 2 });
  assert.deepEqual(progressFromLabel('Overflow 9/4'), { completed: 4, total: 4 });
  assert.equal(progressFromLabel('Waiting for ChatGPT login…'), null);
  assert.equal(progressFromLabel('Switching to 1/2 team… now'), null);
  assert.equal(progressFromLabel('Empty 0/0'), null);
  assert.equal(progressFromLabel(undefined), null);
  assert.equal(progressFromLabel(null), null);
});

test('progress bars always occupy exactly their width', () => {
  assert.equal(progressBar(0, 4, 8), '░░░░░░░░');
  assert.equal(progressBar(2, 4, 8), '████░░░░');
  assert.equal(progressBar(4, 4, 8), '████████');
  for (const [done, total] of [[-3, 5], [99, 5], [1, 0], [Number.NaN, 3]]) {
    assert.equal([...progressBar(done, total, 10)].length, 10);
  }
  assert.equal(progressBar(1, 2, 0).length, 1, 'width is clamped to one cell');
});

test('cursor arrives light and settles bold, both two columns wide', () => {
  assert.equal(cursorGlyph(false, animated), CURSOR_ARRIVING);
  assert.equal(cursorGlyph(true, animated), CURSOR_SETTLED);
  assert.equal(cursorGlyph(false, still), CURSOR_SETTLED, 'no arrival frame without motion');
  assert.equal([...CURSOR_ARRIVING].length, [...CURSOR_SETTLED].length);
});

test('switch flash pulses then ends, with the same cell width each frame', () => {
  const frames = Array.from({ length: FLASH_STEPS }, (_, step) => flashFrame(step, 'success', animated));
  assert.ok(frames.every((frame) => frame?.glyph === '✓'));
  assert.ok(frames.some((frame) => frame?.highlight), 'highlights at least once');
  assert.ok(frames.some((frame) => !frame?.highlight), 'settles back without highlight');
  assert.equal(frames.at(-1)?.highlight, false);
  assert.equal(flashFrame(FLASH_STEPS, 'success', animated), null);
  assert.equal(flashFrame(-1, 'success', animated), null);
  assert.equal(flashFrame(0, 'error', animated)?.glyph, '✗');
  assert.deepEqual(flashSchedule(animated).steps, FLASH_STEPS);
});

test('reduced motion flash is one static mark shown for a fixed time', () => {
  assert.deepEqual(flashSchedule(still), { steps: 1, intervalMs: STATIC_FLASH_MS });
  assert.deepEqual(flashFrame(0, 'error', still), { glyph: '✗', highlight: false, bold: true });
});

test('result marks reveal in three steps unless motion is disabled', () => {
  assert.deepEqual([0, 1, 2, 3].map((step) => revealGlyph(step, 'success', animated)), ['·', '•', '✓', '✓']);
  assert.equal(revealGlyph(0, 'error', animated), '·');
  assert.equal(revealGlyph(2, 'error', animated), '✗');
  assert.equal(revealGlyph(0, 'success', still), '✓');
  assert.equal(revealGlyph(0, 'error', still), '✗');
});
