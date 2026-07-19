import { terminalSafeMetadata } from './providerMetadata';
import type { ProviderId } from './types';

export interface CommandHelpEntry {
  /** Stable capability id used to prove the public help stays complete. */
  id: string;
  key: string;
  description: string;
}

export interface CommandHelpSection {
  title: string;
  entries: CommandHelpEntry[];
}

export interface CommandHelpPage {
  title: string;
  shortTitle: string;
  sections: CommandHelpSection[];
}

/** Complete public command reference, split into short terminal-friendly pages. */
export function commandHelpPages(provider: ProviderId): CommandHelpPage[] {
  const providerName = provider === 'claude' ? 'Claude' : 'Codex';
  return [
    {
      title: 'Navigate and find accounts',
      shortTitle: 'Nav',
      sections: [
        {
          title: 'ACCOUNT LIST',
          entries: [
            { id: 'navigate', key: '↑ / ↓ · j / k', description: 'Move to the previous / next account' },
            { id: 'page-accounts', key: 'PgUp / PgDn', description: 'Move one visible account page' },
            { id: 'jump-accounts', key: 'g / G', description: 'Jump to the first / last account' },
            { id: 'search', key: '/', description: 'Find next match by label, e-mail or plan' },
            { id: 'provider-tab', key: '← / →', description: 'Open the Claude / Codex provider tab' },
            { id: 'help', key: '?', description: 'Open this complete command reference' },
          ],
        },
      ],
    },
    {
      title: 'Switch and quota decisions',
      shortTitle: 'Quota',
      sections: [
        {
          title: 'SELECT AND REFRESH',
          entries: [
            { id: 'switch', key: 'Enter', description: `Switch to the selected ${providerName} account` },
            { id: 'refresh', key: 'u', description: 'Refresh every account quota in this provider' },
            { id: 'best-now', key: 'b', description: 'Refresh, then choose the reset-aware Best Now account' },
            { id: 'raw-headroom', key: 'l', description: 'Highlight most raw headroom without switching' },
            { id: 'cancel-refresh', key: 'Esc during refresh', description: 'Stop safely after the account currently being checked' },
          ],
        },
      ],
    },
    {
      title: 'Manage saved accounts',
      shortTitle: 'Accounts',
      sections: [
        {
          title: 'ACCOUNT MANAGEMENT',
          entries: [
            { id: 'add-account', key: 'a', description: 'Add an account or re-authenticate the selected one' },
            { id: 'rename-account', key: 'r', description: 'Rename the selected saved account' },
            { id: 'archive-account', key: 'd', description: 'Archive a non-active account without destroying it' },
            { id: 'restore-account', key: 'z', description: 'Restore the latest archived account / recovery' },
            ...(provider === 'claude'
              ? [{ id: 'capture-desktop', key: 'A', description: 'Capture an optional machine-bound Desktop session' }]
              : []),
          ],
        },
      ],
    },
    {
      title: 'Import credentials',
      shortTitle: 'Import',
      sections: [
        {
          title: 'LIST AND IMPORT INBOX',
          entries: [
            { id: 'import-inbox', key: 'i', description: 'Open the guided inbox for the visible provider' },
            { id: 'import-path', key: 'I / p inside inbox', description: 'Paste or drag an external file / folder path' },
            { id: 'import-select', key: '↑ / ↓ · Enter', description: 'Select and import the complete detected source' },
            { id: 'import-open', key: 'o inside inbox', description: 'Open the exact provider inbox in the file manager' },
            { id: 'import-rescan', key: 'r inside inbox', description: 'Rescan after files are copied into the inbox' },
            { id: 'import-close', key: 'Esc / q', description: 'Leave the import screen without changing accounts' },
          ],
        },
      ],
    },
    {
      title: 'Export credentials',
      shortTitle: 'Export',
      sections: [
        {
          title: 'PORTABLE EXPORTS',
          entries: [
            { id: 'export-selected', key: 'e', description: 'Export the selected portable account' },
            { id: 'export-all', key: 'E', description: 'Export every portable account for this provider' },
            { id: 'export-open', key: 'o after export', description: 'Open the export folder from the result screen' },
            { id: 'export-unique', key: 'File names', description: 'Timestamped exports never overwrite older recovery files' },
            { id: 'export-secrets', key: 'Security', description: 'Exports contain login secrets and must stay private' },
            ...(provider === 'claude'
              ? [{ id: 'export-provider-limit', key: 'Desktop', description: 'Machine-bound Claude Desktop sessions are skipped' }]
              : [{ id: 'export-provider-limit', key: 'Codex auth', description: 'Portable export uses the saved file-backed credential' }]),
          ],
        },
      ],
    },
    {
      title: 'Setup, dialogs and exit',
      shortTitle: 'Controls',
      sections: [
        {
          title: 'CONTEXTUAL CONTROLS',
          entries: [
            { id: 'setup', key: 'S', description: 'Open shortcuts and scheduled-maintenance setup' },
            { id: 'setup-actions', key: 'i / x inside setup', description: 'Install / uninstall the shown integrations' },
            { id: 'confirm', key: 'y / n', description: 'Accept / reject a switch or archive confirmation' },
            { id: 'submit-back', key: 'Enter / Esc', description: 'Submit or save / cancel or go back safely' },
            { id: 'edit', key: 'Backspace / Delete', description: 'Edit search, rename, login and path fields' },
            { id: 'quit', key: 'q', description: 'Quit from the list; close help/import/messages elsewhere' },
          ],
        },
      ],
    },
    {
      title: 'Command line: accounts',
      shortTitle: 'CLI A',
      sections: [
        {
          title: 'PUBLIC CLI COMMANDS',
          entries: [
            { id: 'cli-launch', key: 'switch.cmd', description: 'Launch the interactive account switcher' },
            { id: 'cli-login', key: 'login [claude|codex]', description: 'Run the official provider login workflow' },
            { id: 'cli-import', key: 'import [--provider P] <path>', description: 'Import every valid account represented by one source' },
            { id: 'cli-import-all', key: 'import-all [--provider P] <path>', description: 'Explicit bulk-import alias for a bundle or folder' },
            { id: 'cli-export-all', key: 'export-all [claude|codex]', description: 'Create a new timestamped provider bundle' },
            { id: 'cli-doctor', key: 'doctor [all|claude|codex]', description: 'Diagnose stores and accounts without printing secrets' },
          ],
        },
      ],
    },
    {
      title: 'Command line: maintenance',
      shortTitle: 'CLI B',
      sections: [
        {
          title: 'PUBLIC CLI COMMANDS',
          entries: [
            { id: 'cli-dry-run', key: '--dry-run', description: 'Preview exactly which live keys a switch would change' },
            { id: 'cli-restore', key: 'restore <provider> [backup]', description: 'Restore one provider live-auth backup transactionally' },
            { id: 'cli-install', key: 'install / uninstall', description: 'Add / remove shortcuts and scheduled maintenance' },
            { id: 'cli-keep-alive', key: 'keep-alive', description: 'Refresh due tokens and report required logins now' },
            { id: 'cli-keep-alive-job', key: 'keep-alive install|uninstall', description: 'Add / remove only the scheduled keep-alive job' },
            { id: 'cli-help', key: '--help / -h', description: 'Print the non-interactive command reference' },
          ],
        },
      ],
    },
    {
      title: 'Safety and storage rules',
      shortTitle: 'Safety',
      sections: [
        {
          title: 'GUARANTEES',
          entries: [
            ...(provider === 'claude'
              ? [{ id: 'safety-switch', key: 'Claude switch', description: 'Requires a normal close; Claude is never force-killed' }]
              : [{ id: 'safety-switch', key: 'Codex switch', description: 'Warns before closing confirmed Codex process trees' }]),
            { id: 'safety-provider', key: 'Provider isolation', description: 'Claude operations never write Codex files, or vice versa' },
            { id: 'safety-archive', key: 'Archive', description: 'Creates recovery evidence and a deletion tombstone' },
            { id: 'safety-import', key: 'Imports · ⧉', description: 'Inbox moves after commit; another active PC can race renewal' },
            { id: 'safety-export', key: 'Export / switch', description: 'Refused while credentials may be rotating' },
            { id: 'safety-storage', key: 'Data and logs', description: 'Private diagnostics live under ~/.claude-switch/' },
          ],
        },
      ],
    },
  ];
}

/** Keep dense list rows scannable; the selected-account panel can show the email. */
export function accountListLabel(label: string, email: string, importedSession = false): string {
  const cleanLabel = terminalSafeMetadata(label).trim();
  const cleanEmail = terminalSafeMetadata(email).trim();
  const identity = cleanLabel || cleanEmail || '(unnamed account)';
  return importedSession ? `⧉ ${identity}` : identity;
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
