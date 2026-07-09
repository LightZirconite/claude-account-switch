import type { ProviderId } from './types';

export interface ProviderNavigationState {
  provider: ProviderId;
  cursors: Record<ProviderId, number>;
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
  if (total <= 0) return state;
  const current = Math.max(0, Math.min(state.cursors[provider], total - 1));
  const next = (current + delta + total) % total;
  return {
    provider: state.provider,
    cursors: { ...state.cursors, [provider]: next },
  };
}
