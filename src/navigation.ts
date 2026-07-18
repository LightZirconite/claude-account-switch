import type { ProviderId } from './types';

export interface ProviderNavigationState {
  provider: ProviderId;
  cursors: Record<ProviderId, number>;
}

export type CursorMove = 'prev' | 'next' | 'pagePrev' | 'pageNext' | 'first' | 'last';

export interface Viewport {
  /** Inclusive index of the first visible item. */
  start: number;
  /** Exclusive index after the last visible item. */
  end: number;
}

function normalizedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizedCapacity(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function clampCursor(total: number, cursor: number): number {
  if (total === 0) return 0;
  const finiteCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  return Math.max(0, Math.min(finiteCursor, total - 1));
}

/**
 * Move a cursor within a collection without ever returning a negative index.
 * Single-row movement wraps; page and boundary movement clamp at the ends.
 */
export function moveCursor(
  total: number,
  cursor: number,
  move: CursorMove,
  pageSize = 1,
): number {
  const count = normalizedCount(total);
  if (count === 0) return 0;

  const current = clampCursor(count, cursor);
  const page = normalizedCapacity(pageSize);
  switch (move) {
    case 'prev':
      return current === 0 ? count - 1 : current - 1;
    case 'next':
      return current === count - 1 ? 0 : current + 1;
    case 'pagePrev':
      return Math.max(0, current - page);
    case 'pageNext':
      return Math.min(count - 1, current + page);
    case 'first':
      return 0;
    case 'last':
      return count - 1;
  }
}

/**
 * Return the visible slice that contains `cursor`, filling the final viewport when possible.
 */
export function viewportFor(total: number, cursor: number, capacity: number): Viewport {
  const count = normalizedCount(total);
  if (count === 0) return { start: 0, end: 0 };

  const visible = Math.min(count, normalizedCapacity(capacity));
  const current = clampCursor(count, cursor);
  const pageStart = Math.floor(current / visible) * visible;
  const start = Math.min(pageStart, count - visible);
  return { start, end: start + visible };
}

export function switchProviderTab(
  state: ProviderNavigationState,
  direction: 'left' | 'right',
): ProviderNavigationState {
  return {
    provider: direction === 'left' ? 'claude' : 'codex',
    cursors: { ...state.cursors },
  };
}

export function moveProviderCursor(
  state: ProviderNavigationState,
  provider: ProviderId,
  total: number,
  delta: -1 | 1,
): ProviderNavigationState {
  const next = moveCursor(total, state.cursors[provider], delta === -1 ? 'prev' : 'next');
  return {
    provider: state.provider,
    cursors: { ...state.cursors, [provider]: next },
  };
}
