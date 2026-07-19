import { terminalSafeMetadata } from './providerMetadata';

/** Keep dense list rows scannable; the selected-account panel can show the email. */
export function accountListLabel(label: string, email: string): string {
  const cleanLabel = terminalSafeMetadata(label).trim();
  const cleanEmail = terminalSafeMetadata(email).trim();
  return cleanLabel || cleanEmail || '(unnamed account)';
}

/** Show an email as secondary detail only when it is not already the account label. */
export function accountSecondaryIdentity(label: string, email: string): string | null {
  const cleanLabel = terminalSafeMetadata(label).trim();
  const cleanEmail = terminalSafeMetadata(email).trim();
  if (!cleanEmail || cleanLabel.toLowerCase() === cleanEmail.toLowerCase()) return null;
  return cleanEmail;
}

export function quotaMeter(usedPercent: number | null | undefined, width = 8): string {
  const safeWidth = Math.max(1, Math.min(24, Math.floor(width)));
  if (usedPercent == null || !Number.isFinite(usedPercent)) return '─'.repeat(safeWidth);
  const bounded = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((bounded / 100) * safeWidth);
  return `${'━'.repeat(filled)}${'─'.repeat(safeWidth - filled)}`;
}

export interface AccountTableLayout {
  ultraCompact: boolean;
  compact: boolean;
  showIndex: boolean;
  indexWidth: number;
  prefixWidth: number;
  accountWidth: number;
  planWidth: number;
  usageWidth: number;
  usageColumnCount: number;
  stateWidth: number;
}

/**
 * Keep every account row exactly within the terminal width. Wide and compact layouts
 * include stable row numbers; ultra-narrow terminals preserve the account and plan
 * columns by dropping only that decorative index.
 */
export function accountTableLayout(
  terminalWidth: number,
  totalAccounts: number,
  requestedUsageColumns = 2,
): AccountTableLayout {
  const width = Number.isFinite(terminalWidth) ? Math.max(16, Math.floor(terminalWidth)) : 16;
  const ultraCompact = width < 52;
  const compact = width < 96;
  const safeTotal = Number.isFinite(totalAccounts) ? Math.max(1, Math.floor(totalAccounts)) : 1;
  const digits = String(safeTotal).length;
  const showIndex = !ultraCompact && digits <= 4;
  const indexWidth = showIndex ? Math.max(2, digits) : 0;
  // cursor (2) + optional ordinal and gap + health glyph (2)
  const prefixWidth = 4 + (showIndex ? indexWidth + 1 : 0);
  const planWidth = compact ? 7 : 8;
  const usageWidth = compact ? 9 : 12;
  const safeRequestedUsageColumns = Number.isFinite(requestedUsageColumns)
    ? Math.floor(requestedUsageColumns)
    : 0;
  const usageColumnCount = ultraCompact ? 0 : Math.max(0, Math.min(2, safeRequestedUsageColumns));
  const stateWidth = compact ? 0 : 9;
  const fixedWidth = prefixWidth + 2 + planWidth
    + usageColumnCount * (2 + usageWidth)
    + (compact ? 0 : 2 + stateWidth);
  const minimumAccountWidth = ultraCompact ? 3 : compact ? 8 : 18;

  return {
    ultraCompact,
    compact,
    showIndex,
    indexWidth,
    prefixWidth,
    accountWidth: Math.max(minimumAccountWidth, width - fixedWidth),
    planWidth,
    usageWidth,
    usageColumnCount,
    stateWidth,
  };
}

export function formatAccountOrdinal(index: number, width: number): string {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  return String(safeIndex + 1).padStart(safeWidth, '0');
}

export function formatQuotaWindowLabel(
  durationMins: number | null | undefined,
  style: 'compact' | 'long' = 'compact',
): string {
  if (durationMins == null || !Number.isFinite(durationMins) || durationMins <= 0) {
    return style === 'long' ? 'LIMIT' : 'limit';
  }
  const minutes = Math.round(durationMins);
  let amount: number;
  let compactUnit: string;
  let longUnit: string;
  if (minutes % (24 * 60) === 0) {
    amount = minutes / (24 * 60);
    compactUnit = 'D';
    longUnit = 'DAY';
  } else if (minutes % 60 === 0) {
    amount = minutes / 60;
    compactUnit = 'H';
    longUnit = 'HOUR';
  } else {
    amount = minutes;
    compactUnit = 'M';
    longUnit = 'MIN';
  }
  return style === 'long' ? `${amount}-${longUnit}` : `${amount}${compactUnit}`;
}

export function quotaColumnPresentation(
  durations: Array<number | null | undefined>,
  index: number,
  totalColumns: number,
): { compactLabel: string; longLabel: string; mixedDuration: boolean } {
  const compactDurations = [...new Set(durations.map((duration) => formatQuotaWindowLabel(duration)))];
  const mixedDuration = compactDurations.length > 1;
  const sample = durations[0];
  return {
    compactLabel: mixedDuration
      ? totalColumns > 1 ? `WIN ${index + 1}` : 'WINDOW'
      : formatQuotaWindowLabel(sample),
    longLabel: mixedDuration
      ? totalColumns > 1 ? `WINDOW ${index + 1}` : 'WINDOW'
      : formatQuotaWindowLabel(sample, 'long'),
    mixedDuration,
  };
}

export function claudeMascotFrame(frame: number): {
  signal: string;
  crown: string;
  body: string;
  feet: string;
} {
  return {
    signal: ['·', '•', '✦', '•'][Math.abs(Math.floor(frame)) % 4],
    crown: '▐▛███▜▌',
    body: '▝▜█████▛▘',
    feet: '▘▘   ▝▝',
  };
}

export function codexMascotFrame(frame: number): {
  signal: string;
  eyes: string;
  mouth: string;
} {
  const normalized = Math.abs(Math.floor(frame)) % 8;
  return {
    signal: ['·', '•', '◆', '•'][normalized % 4],
    eyes: normalized === 7 ? '─ ─' : '● ●',
    mouth: normalized % 4 === 2 ? '╰━╯' : '╰─╯',
  };
}
