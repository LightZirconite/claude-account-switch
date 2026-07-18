import assert from 'node:assert/strict';
import test from 'node:test';

import {
  moveCursor,
  moveProviderCursor,
  viewportFor,
  type CursorMove,
  type ProviderNavigationState,
} from '../src/navigation';

test('an empty collection always has a safe zero cursor', () => {
  const moves: CursorMove[] = ['prev', 'next', 'pagePrev', 'pageNext', 'first', 'last'];
  for (const move of moves) {
    assert.equal(moveCursor(0, -12, move, 20), 0);
  }

  const state: ProviderNavigationState = {
    provider: 'claude',
    cursors: { claude: -1, codex: 4 },
  };
  const moved = moveProviderCursor(state, 'claude', 0, -1);
  assert.deepEqual(moved.cursors, { claude: 0, codex: 4 });
  assert.deepEqual(state.cursors, { claude: -1, codex: 4 });
});

test('previous and next movement wrap at collection boundaries', () => {
  assert.equal(moveCursor(4, 0, 'prev'), 3);
  assert.equal(moveCursor(4, 3, 'next'), 0);
  assert.equal(moveCursor(4, 2, 'prev'), 1);
  assert.equal(moveCursor(4, 1, 'next'), 2);
});

test('page movement clamps at collection boundaries', () => {
  assert.equal(moveCursor(10, 1, 'pagePrev', 4), 0);
  assert.equal(moveCursor(10, 1, 'pageNext', 4), 5);
  assert.equal(moveCursor(10, 8, 'pageNext', 4), 9);
  assert.equal(moveCursor(10, 9, 'pagePrev', 4), 5);
  assert.equal(moveCursor(10, 5, 'pageNext', 0), 6);
});

test('first and last movement normalize an out-of-range cursor', () => {
  assert.equal(moveCursor(7, 99, 'first'), 0);
  assert.equal(moveCursor(7, -99, 'last'), 6);
  assert.equal(moveCursor(1, Number.NaN, 'last'), 0);
});

test('viewportFor returns an empty slice for an empty collection', () => {
  assert.deepEqual(viewportFor(0, 12, 8), { start: 0, end: 0 });
});

test('viewportFor keeps the cursor visible across full and partial pages', () => {
  assert.deepEqual(viewportFor(100, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(viewportFor(100, 9, 10), { start: 0, end: 10 });
  assert.deepEqual(viewportFor(100, 10, 10), { start: 10, end: 20 });
  assert.deepEqual(viewportFor(100, 99, 10), { start: 90, end: 100 });
  assert.deepEqual(viewportFor(25, 24, 10), { start: 15, end: 25 });
});

test('viewportFor clamps cursors and normalizes capacity', () => {
  assert.deepEqual(viewportFor(5, -10, 3), { start: 0, end: 3 });
  assert.deepEqual(viewportFor(5, 99, 3), { start: 2, end: 5 });
  assert.deepEqual(viewportFor(5, 3, 0), { start: 3, end: 4 });
  assert.deepEqual(viewportFor(5, 3, 20), { start: 0, end: 5 });
});
