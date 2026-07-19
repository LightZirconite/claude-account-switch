// Keyboard-driven TUI for switching Claude Code and Codex accounts. UI is in English.
import { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import clipboard from 'clipboardy';

import {
  claudeConfigDir,
  codexHome,
  credentialsPath,
  dataDir,
  desktopUserDataDir,
  exportDir,
  findClaudeExe,
  providerImportDir,
  undottedClaudeCredentialsPath,
} from './paths';
import { logger, redactText } from './logger';
import { withFileLock } from './locks';
import { markManualRecovery } from './retention';
import { checkForUpdate } from './updateCheck';
import pkg from '../package.json';
const APP_VERSION: string = pkg.version;
import {
  loadStore,
  mutateStore,
  reconcileStoreWithProviderProof,
  recoverClaudeImportMetadata,
  recoverMissingClaudeProfileMetadata,
  getActive,
  addOrUpdateProfile,
  captureDesktopAccount,
  archiveClaudeProfile,
  restoreLatestDeletedProfile,
  exportProfile,
  groupClaudeImportCandidates,
  scanImportDir,
  importFromPath,
  subscriptionOf,
  exportAllProfiles,
  orphanedClaudeCredentialIds,
  orphanedClaudeDesktopIds,
  checkpointClaudeAuthorization,
  finalizeClaudeAuthorization,
  syntheticClaudeAccountId,
  mutateStoreWithLiveAccount,
  type ClaudeImportGroup,
} from './profiles';
import {
  applyProfile,
  getLiveAccount,
  restoreFromBackup,
  restoreLatestBackup,
  dryRunApply,
  inspectClaudeLiveAuthRecovery,
  recoverClaudeLiveAuthTransaction,
  updateLiveCredentials,
  type DryRunReport,
} from './claudeStore';
import {
  applyDesktopSnapshot,
  inspectDesktopRecovery,
  isDesktopInstalled,
  recoverDesktopTransactions,
  restoreDesktopBackup,
} from './desktopStore';
import {
  bestNow,
  describeClaudeRefreshResult,
  ensureFreshToken,
  fetchUsage,
  hasFreshCompleteClaudeUsage,
  keepActiveTokenAlive,
  keepTokenAlive,
  leastLoaded,
} from './usage';
import { findClaudeProcesses, detectClaudeVersion, type ProcInfo } from './processes';
import {
  installAll,
  uninstallAll,
  installState,
  shouldOfferSetup,
  markSetupOffered,
  schedulerOnlyInstall,
  schedulerOnlyUninstall,
  APP_NAME,
  type InstallReport,
} from './installer';
import {
  buildManualAuth,
  exchangeCode,
  loginViaClaudeCli,
  primeIdentity,
  supportsIsolatedClaudeAuth,
  DEFAULT_SCOPES,
  type ManualAuth,
  type PrimedIdentity,
} from './oauth';
import { hasCliAuth, hasRefreshableOauth, type Profile, type ProfilesStore } from './types';
import type { CodexProfile, CodexProfilesStore, ProviderId } from './types';
import {
  addCodexAccount,
  archiveCodexProfile,
  bestNowCodex,
  effectiveCodexQuota,
  exportAllCodexProfiles,
  exportCodexProfile,
  importCodexFromPath,
  leastLoadedCodex,
  listAbandonedCodexLoginArchives,
  loadCodexStore,
  listPendingCodexHomes,
  readCodexAuth,
  recoverAbandonedCodexHomes,
  restoreLatestCodexRecovery,
  reconcileLiveCodex,
  resolveCodexPlan,
  refreshCodexProfile,
  refreshAllCodexProfiles,
  renameCodexProfile,
  scanCodexImportDir,
} from './codexProfiles';
import {
  CodexLoginCancelledError,
  codexRedirectUriFromAuthUrl,
  detectCodexVersion,
  inspectCodexHome,
  submitCodexCallback as forwardCodexCallback,
} from './codexAppServer';
import {
  findCodexProcesses,
  runCodexSwitchWorker,
  startCodexSwitchWorker,
  waitForCodexSwitchResult,
  restoreCodexLiveBackup,
  restoreLatestCodexLiveBackup,
} from './codexSwitch';
import { moveCursor, switchProviderTab, viewportFor } from './navigation';
import { type BestNowDecision } from './scheduling';
import { readClaudeAuthStatus } from './claudeStatus';
import { formatPlanLabel } from './providerMetadata';
import {
  accountListLabel,
  accountSecondaryIdentity,
  accountTableLayout,
  claudeMascotFrame,
  codexMascotFrame,
  commandHelpPages,
  formatAccountOrdinal,
  formatQuotaWindowLabel,
  quotaColumnPresentation,
  quotaMeter,
} from './presentation';
import {
  archiveImportedSources,
  discoverCodexImportFiles,
  importDispositionSummary,
  normalizeImportPath,
} from './transfer';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function providerMetadataSummary(verifiedCount: number, total: number): string {
  if (verifiedCount === total) return `Provider metadata verified for ${total}/${total} account${total === 1 ? '' : 's'}.`;
  if (verifiedCount > 0) {
    return `Provider metadata verified for ${verifiedCount}/${total}; saved details remain for the rest and retry automatically.`;
  }
  return 'Provider metadata is temporarily unavailable; credentials remain saved and will retry automatically.';
}

async function recoverImportedCodexMetadata(
  profiles: CodexProfile[],
): Promise<{ store: CodexProfilesStore; verifiedCount: number }> {
  const ids = [...new Set(profiles.map((profile) => profile.id))];
  let nextIndex = 0;
  let verifiedCount = 0;
  const worker = async () => {
    while (true) {
      const id = ids[nextIndex++];
      if (!id) return;
      const startedAt = Date.now();
      try {
        const store = await refreshCodexProfile(id, { forceTokenRefresh: false });
        const profile = store.profiles.find((candidate) => candidate.id === id);
        const providerPlanObserved = (profile?.planObservedAt ?? 0) >= startedAt
          && (profile?.planSource === 'codex-rate-limits' || profile?.planSource === 'codex-account');
        const providerQuotaObserved = (profile?.usage?.fetchedAt ?? 0) >= startedAt
          && profile?.usage?.status === 'ok';
        if (providerPlanObserved || providerQuotaObserved) verifiedCount++;
      } catch (error) {
        logger.warn('Codex imported-profile metadata remains unavailable', { profileId: id, error: String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, () => worker()));
  return { store: loadCodexStore(), verifiedCount };
}

function identityToFields(id: PrimedIdentity) {
  const oa = id.oauthAccount;
  return {
    email: oa.emailAddress ?? '(new account)',
    accountUuid: oa.accountUuid || syntheticClaudeAccountId(id.claudeAiOauth),
    organizationUuid: oa.organizationUuid ?? id.organizationUuidRoot ?? '',
    organizationUuidRoot: id.organizationUuidRoot,
    organizationType: oa.organizationType,
    subscriptionType: subscriptionOf(id.claudeAiOauth, oa.organizationType),
    claudeAiOauth: id.claudeAiOauth,
    oauthAccount: oa,
    userID: id.userID,
  };
}

function openFolder(dir: string): void {
  try {
    const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' });
    child.once('error', (error) => logger.warn('file manager could not be opened', { dir, error: String(error) }));
    child.unref();
  } catch (error) {
    logger.warn('file manager could not be started', { dir, error: String(error) });
  }
}

// ---------- small view helpers ----------

function pad(s: string, n: number): string {
  const str = s ?? '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str.padEnd(n);
}

function relTime(ms?: number): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

const CLAUDE_ORANGE = '#D97757'; // Claude brand coral/orange
// Current Windows Codex app manifest uses this royal-blue brand background.
const CODEX_BLUE = '#3143FF';

function motionIsAllowed(): boolean {
  return Boolean(process.stdout.isTTY)
    && process.env.CI !== 'true'
    && process.env.TERM !== 'dumb'
    && process.env.NO_ANIMATION !== '1'
    && process.env.REDUCE_MOTION !== '1';
}

function useMotionFrame(enabled: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!enabled || !motionIsAllowed()) {
      setFrame(0);
      return undefined;
    }
    // One intentionally slow timer drives every decorative motion. This avoids the
    // flicker and CPU cost of multiple fast intervals in ordinary terminals.
    const timer = setInterval(() => setFrame((value) => (value + 1) % 8), 650);
    return () => clearInterval(timer);
  }, [enabled]);
  return frame;
}

function ClaudePulseMark({ frame }: { frame: number }) {
  const mascot = claudeMascotFrame(frame);
  return (
    <Box flexDirection="column" alignItems="center">
      <Text bold color={CLAUDE_ORANGE}>{mascot.signal}</Text>
      <Text bold color={CLAUDE_ORANGE}>{mascot.crown}</Text>
      <Text bold color={CLAUDE_ORANGE}>{mascot.body}</Text>
      <Text bold color={CLAUDE_ORANGE}>{mascot.feet}</Text>
      <Text dimColor>CLAUDE READY</Text>
    </Box>
  );
}

function CodexBotMark({ frame }: { frame: number }) {
  const mascot = codexMascotFrame(frame);
  return (
    <Box flexDirection="column" alignItems="center">
      <Text bold color={CODEX_BLUE}>{`╭──${mascot.signal}──╮`}</Text>
      <Text bold color={CODEX_BLUE}>{'╭─┤ '}<Text color="white">{mascot.eyes}</Text>{' ├─╮'}</Text>
      <Text bold color={CODEX_BLUE}>{'╰─┤ '}<Text color="cyanBright">{mascot.mouth}</Text>{' ├─╯'}</Text>
      <Text bold color={CODEX_BLUE}>{'╰─────╯'}</Text>
      <Text dimColor>CODEX READY</Text>
    </Box>
  );
}

const ColumnRule = () => <Text color="#3F3F46">{'│ '}</Text>;
const Divider = ({ width, color = 'gray' as string }: { width: number; color?: string }) => (
  <Text color={color}>{'─'.repeat(Math.max(1, width))}</Text>
);

// A tiny animated spinner (no extra dependency).
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function Spinner({ label, color = 'cyanBright' as string }: { label?: string; color?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={color}>
      {SPINNER_FRAMES[i]}
      {label ? ` ${label}` : ''}
    </Text>
  );
}

// Track the terminal width so the UI fills the available space and reflows on resize.
function currentTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || Number(process.env.COLUMNS) || 100,
    rows: process.stdout.rows || Number(process.env.LINES) || 30,
  };
}
function useTerminalSize(): { cols: number; rows: number } {
  const [size, setSize] = useState(currentTerminalSize);
  useEffect(() => {
    const onResize = () => setSize(currentTerminalSize());
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return size;
}

function utilColor(u: number | null): string {
  if (u == null) return 'gray';
  if (u >= 90) return 'red';
  if (u >= 70) return 'yellow';
  return 'greenBright';
}

function fmtPct(u?: number | null): string {
  return u == null ? '–' : `${Math.round(u)}%`;
}

// "resets in" countdown from an ISO timestamp.
function resetIn(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(t)) return '—';
  if (t <= 0) return 'now';
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Absolute reset time in the PC's local timezone/locale (e.g. "18:59" today, "Jul 8, 13:00").
function resetAt(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function quotaResetLabel(usedPercent: number | null | undefined, iso?: string | null): string {
  if (usedPercent === 0 && !iso) return 'available now';
  return `resets ${resetAt(iso)}`;
}

function bestNowDetail(
  decision: BestNowDecision<unknown>,
  labels: { primary: string; secondary: string } = { primary: '5h', secondary: '7d' },
): string {
  if (decision.reason === 'primary-reset-soon' && decision.primaryResetsAt) {
    return `${labels.primary} ${Math.round(decision.primaryUsedPercent ?? 0)}% · resets in ${resetIn(new Date(decision.primaryResetsAt).toISOString())}`;
  }
  if (decision.reason === 'secondary-reset-soon' && decision.secondaryResetsAt) {
    return `${labels.secondary} ${Math.round(decision.secondaryUsedPercent ?? 0)}% · resets in ${resetIn(new Date(decision.secondaryResetsAt).toISOString())}`;
  }
  if (decision.reason === 'additional-reset-soon' && decision.limitingResetsAt) {
    return `${decision.limitingWindowName ?? 'scoped'} ${Math.round(decision.limitingUsedPercent ?? 0)}% · resets in ${resetIn(new Date(decision.limitingResetsAt).toISOString())}`;
  }
  return 'most usable headroom';
}

function bestNowUnavailableStatus(
  provider: 'Claude' | 'Codex',
  decision: BestNowDecision<unknown>,
  labelForId: (id: string | undefined) => string | undefined,
): string {
  const resetEstimate = decision.nextAvailableAt
    ? resetIn(new Date(decision.nextAvailableAt).toISOString())
    : null;
  if (decision.confidence === 'low') {
    return resetEstimate
      ? `${provider} quota data is stale or incomplete; the next possible reset is estimated in ${resetEstimate}. Press "u" to verify.`
      : `${provider} quota data is stale or incomplete, so Best Now will not switch automatically. Press "u" to verify.`;
  }
  if (decision.reason === 'all-exhausted' && resetEstimate) {
    return `No ${provider} account is available. ${labelForId(decision.nextAvailableId) ?? 'Next account'} resets in ${resetEstimate}.`;
  }
  if (decision.reason === 'reserve-protected') {
    return resetEstimate
      ? `Best Now kept the final 5% reserve. More capacity is expected in ${resetEstimate}.`
      : `Best Now kept the final 5% reserve on every ${provider} account.`;
  }
  return decision.reason === 'no-eligible-account'
    ? `No usable ${provider} account is available.`
    : `${provider} quota data is unavailable; press "u" to retry.`;
}

function planColor(sub?: string): string {
  if (!sub) return 'gray';
  if (/max/i.test(sub)) return 'magenta';
  if (/pro/i.test(sub)) return 'blueBright';
  return 'cyan';
}

function HeroQuotaLine({
  label,
  usedPercent,
  reset,
}: {
  label: string;
  usedPercent?: number | null;
  reset?: string | null;
}) {
  const color = utilColor(usedPercent ?? null);
  return (
    <Text>
      <Text dimColor>{label.padEnd(4)}</Text>
      <Text bold color={color}>{fmtPct(usedPercent).padStart(4)}</Text>{' '}
      <Text color={color}>{quotaMeter(usedPercent, 10)}</Text>
      {reset ? <Text dimColor>{`  ${reset}`}</Text> : null}
    </Text>
  );
}

// A fixed 12-char cell. Mixed-duration columns spend four characters on the
// provider window label and shrink only the decorative bar, never the percentage.
function UsageCell({
  win,
  windowLabel,
}: {
  win?: { utilization: number | null } | null;
  windowLabel?: string | null;
}) {
  const u = win?.utilization ?? null;
  const width = windowLabel ? 2 : 6;
  const filled = u == null ? 0 : Math.max(0, Math.min(width, Math.round((u / 100) * width)));
  const bar = u == null ? '─'.repeat(width) : '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (u == null ? '·' : `${Math.round(u)}%`).padStart(4);
  const color = utilColor(u);
  return (
    <Text>
      {windowLabel ? <Text dimColor>{pad(windowLabel.toLowerCase(), 4)}</Text> : null}
      <Text color={color}>{pct}</Text>
      {' '}
      <Text color={color}>{bar}</Text>
      {' '}
    </Text>
  );
}

type Mode =
  | 'list'
  | 'confirmSwitch'
  | 'confirmDelete'
  | 'rename'
  | 'help'
  | 'importMenu'
  | 'importPath'
  | 'importing'
  | 'adding'
  | 'capturingDesktopConfirm'
  | 'capturingDesktopLabel'
  | 'capturingDesktopEmail'
  | 'setup'
  | 'codexAdding'
  | 'codexConfirmSwitch'
  | 'codexConfirmDelete'
  | 'codexRename'
  | 'search'
  | 'message';
type Tone = 'success' | 'error' | 'info';

interface ImportInboxItem {
  key: string;
  title: string;
  detail: string;
  sourcePaths: string[];
  format: 'switch-export' | 'raw-credentials';
  claudeGroup?: ClaudeImportGroup;
  codexPath?: string;
}

interface MessageState {
  title: string;
  lines: string[];
  tone: Tone;
  openFolder?: string;
}

interface AppProps {
  initialStore: ProfilesStore;
  initialCodexStore: CodexProfilesStore;
  claudeVersion: string;
}

function App({ initialStore, initialCodexStore, claudeVersion }: AppProps) {
  const { exit } = useApp();
  const [store, setStore] = useState<ProfilesStore>(initialStore);
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [codexStore, setCodexStore] = useState<CodexProfilesStore>(initialCodexStore);
  const [codexCursor, setCodexCursor] = useState(() => {
    const i = initialCodexStore.profiles.findIndex((p) => p.id === initialCodexStore.activeProfileId);
    return i >= 0 ? i : 0;
  });
  const [cursor, setCursor] = useState(() => {
    const i = initialStore.profiles.findIndex((p) => p.id === initialStore.activeProfileId);
    return i >= 0 ? i : 0;
  });
  const [mode, setMode] = useState<Mode>('list');
  const [status, setStatus] = useState<string>('');
  const [buffer, setBuffer] = useState<string>('');
  const [lastSearch, setLastSearch] = useState<string>('');
  const [pendingSwitch, setPendingSwitch] = useState<{ profile: Profile; pids: ProcInfo[] } | null>(null);
  const [pendingCodexSwitch, setPendingCodexSwitch] = useState<CodexProfile | null>(null);
  const [importItems, setImportItems] = useState<ImportInboxItem[]>([]);
  const [importCursor, setImportCursor] = useState(0);
  const [helpPage, setHelpPage] = useState(0);
  const [addLines, setAddLines] = useState<string[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [codexAddLines, setCodexAddLines] = useState<string[]>([]);
  const [codexCallbackBusy, setCodexCallbackBusy] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const desktopLabelRef = useRef('');
  const [busy, setBusy] = useState<string | null>(null);
  const motionFrame = useMotionFrame(mode === 'list' && !busy);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [setupReport, setSetupReport] = useState<InstallReport | null>(null);
  const [message, setMessage] = useState<MessageState | null>(null);
  const authRef = useRef<ManualAuth | null>(null);
  // React state updates are asynchronous. This ref closes the tiny Enter -> Esc race
  // immediately, before the one-shot token exchange can be misreported as cancelled.
  const claudeAddSubmissionRef = useRef(false);
  const codexAddAbortRef = useRef<AbortController | null>(null);
  const codexRedirectRef = useRef<string | null>(null);
  const claudePlanGenerationRef = useRef(0);
  const claudeUsageRefreshRef = useRef<Promise<ProfilesStore> | null>(null);
  const codexUsageRefreshRef = useRef<Promise<CodexProfilesStore> | null>(null);
  const bulkRefreshAbortRef = useRef<AbortController | null>(null);
  const claudeRefreshWasCancelledRef = useRef(false);
  const codexRefreshWasCancelledRef = useRef(false);
  const { cols, rows } = useTerminalSize();
  const storeRef = useRef(store);
  storeRef.current = store;
  const codexStoreRef = useRef(codexStore);
  codexStoreRef.current = codexStore;

  const reloadClaudeStore = useCallback(() => {
    const next = loadStore();
    storeRef.current = next;
    setStore(next);
    setCursor((current) => Math.max(0, Math.min(current, next.profiles.length - 1)));
    return next;
  }, []);

  const refreshClaudePlanProjection = useCallback(async (signal?: AbortSignal) => {
    const expectedProfileId = storeRef.current.activeProfileId;
    if (!expectedProfileId) return null;
    const generation = ++claudePlanGenerationRef.current;
    const observation = await readClaudeAuthStatus(signal);
    if (signal?.aborted || generation !== claudePlanGenerationRef.current) return null;
    if (!observation?.loggedIn || !observation.subscriptionType) return null;
    const next = mutateStore((fresh) => {
      if (fresh.activeProfileId !== expectedProfileId) return;
      const profile = fresh.profiles.find((candidate) => candidate.id === expectedProfileId);
      if (!profile) return;
      const expectedEmail = profile.email.trim().toLowerCase();
      const observedEmail = observation.email?.trim().toLowerCase();
      if (observedEmail && !/^\(unknown/i.test(expectedEmail) && observedEmail !== expectedEmail) {
        logger.warn('discarded Claude plan observation for a different live identity', { profileId: expectedProfileId });
        return;
      }
      profile.subscriptionType = observation.subscriptionType;
      profile.planObservedAt = observation.observedAt;
      profile.planSource = 'claude-auth-status';
      if (observation.email && /^\(unknown/i.test(profile.email)) profile.email = observation.email;
      profile.updatedAt = Date.now();
    });
    storeRef.current = next;
    setStore(next);
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshClaudePlanProjection(controller.signal).catch((error) => {
      if (!controller.signal.aborted) logger.warn('official Claude plan refresh unavailable', { error: String(error) });
    });
    return () => controller.abort();
  }, [refreshClaudePlanProjection]);

  const persistUsage = useCallback((profileId: string, usage: Profile['usage']) => {
    const next = mutateStore((fresh) => {
      const profile = fresh.profiles.find((candidate) => candidate.id === profileId);
      if (profile) profile.usage = usage;
    });
    storeRef.current = next;
    setStore(next);
    return next;
  }, []);

  const reloadCodexStore = useCallback(() => {
    const next = loadCodexStore();
    codexStoreRef.current = next;
    setCodexStore(next);
    setCodexCursor((cursor) => Math.max(0, Math.min(cursor, next.profiles.length - 1)));
    return next;
  }, []);

  const showMessage = useCallback((title: string, lines: string[], tone: Tone, openFolderPath?: string) => {
    setMessage({ title, lines, tone, openFolder: openFolderPath });
    setMode('message');
  }, []);

  const openSetup = useCallback(() => {
    setSetupReport(null);
    setMode('setup');
  }, []);

  // installAll/uninstallAll shell out (schtasks/PowerShell/launchctl/cron) and block
  // briefly; paint the busy line first, then run on the next tick.
  const runInstall = useCallback(() => {
    setBusy(`Setting up ${APP_NAME}…`);
    markSetupOffered();
    setTimeout(() => {
      const rep = installAll();
      setSetupReport(rep);
      setBusy(null);
    }, 30);
  }, []);
  const runUninstall = useCallback(() => {
    setBusy('Removing shortcuts & scheduled job…');
    setTimeout(() => {
      const rep = uninstallAll();
      setSetupReport(rep);
      setBusy(null);
    }, 30);
  }, []);

  // When a usage refresh rotates a token, persist it. If it's the ACTIVE account,
  // also sync it into the live credentials so Claude's running session stays valid.
  const onRotate = useCallback(
    (p: Profile) => {
      // usage.ts has already persisted the rotation while holding the account lock.
      // Reload instead of writing a potentially stale React snapshot over that token.
      const current = reloadClaudeStore();
      const persisted = current.profiles.find((candidate) => candidate.id === p.id) ?? p;
      if (persisted.id === current.activeProfileId && hasCliAuth(persisted) && !persisted.needsReauth) {
        try {
          updateLiveCredentials(persisted.claudeAiOauth, persisted.organizationUuidRoot ?? persisted.organizationUuid);
        } catch (e) {
          logger.error('sync rotated active token to live failed', e);
        }
      }
    },
    [reloadClaudeStore],
  );

  const profiles = store.profiles;
  const selected = profiles[cursor];
  const active = getActive(store);
  const codexProfiles = codexStore.profiles;
  const codexSelected = codexProfiles[codexCursor];
  const codexActive = codexProfiles.find((p) => p.id === codexStore.activeProfileId);
  const listCapacity = Math.max(1, Math.min(20, rows - (rows < 24 ? 12 : 18)));
  const claudeViewport = viewportFor(profiles.length, cursor, listCapacity);
  const codexViewport = viewportFor(codexProfiles.length, codexCursor, listCapacity);

  const startCodexAdd = useCallback(async () => {
    const controller = new AbortController();
    codexAddAbortRef.current = controller;
    codexRedirectRef.current = null;
    setMode('codexAdding');
    setBuffer('');
    setCodexCallbackBusy(false);
    setBusy('Waiting for ChatGPT login…');
    setCodexAddLines(['Starting the official Codex ChatGPT login…']);
    try {
      const result = await addCodexAccount(async (url) => {
        codexRedirectRef.current = codexRedirectUriFromAuthUrl(url);
        let copied = true;
        try {
          await clipboard.write(url);
        } catch {
          copied = false;
        }
        setCodexAddLines([
          copied ? 'Authorization URL copied to your clipboard. No browser was opened.' : 'Clipboard unavailable. Copy the URL shown below.',
          'Open it on the computer where the ChatGPT account is available.',
          'After authorization, copy the complete final localhost URL back here, paste it, then press Enter.',
          '',
          url,
          '',
          'Esc cancels this login cleanly.',
        ]);
      }, controller.signal);
      setCodexStore(result.store);
      setCodexCursor(result.store.profiles.findIndex((p) => p.id === result.profile.id));
      setBusy(null);
      setBuffer('');
      setMode('list');
      setStatus(`Added Codex account "${result.profile.label}".`);
    } catch (e) {
      setBusy(null);
      setBuffer('');
      if (e instanceof CodexLoginCancelledError || controller.signal.aborted) {
        setMode('list');
        setStatus('Codex login cancelled. No account was changed.');
      } else {
        showMessage('Codex login failed', [redactText(e)], 'error');
      }
    } finally {
      if (codexAddAbortRef.current === controller) codexAddAbortRef.current = null;
      codexRedirectRef.current = null;
      setCodexCallbackBusy(false);
    }
  }, [showMessage]);

  const submitCodexCallbackUrl = useCallback(async () => {
    const expectedRedirect = codexRedirectRef.current;
    const pasted = buffer.trim();
    if (!expectedRedirect || !pasted || codexCallbackBusy) return;
    const signal = codexAddAbortRef.current?.signal;
    setCodexCallbackBusy(true);
    try {
      await forwardCodexCallback(pasted, expectedRedirect, signal);
      setBuffer('');
      setCodexAddLines((lines) => [...lines, '', 'Callback accepted. Finishing Codex login…']);
    } catch (error) {
      if (!signal?.aborted) setStatus(redactText(error));
    } finally {
      setCodexCallbackBusy(false);
    }
  }, [buffer, codexCallbackBusy]);

  const refreshCodexUsage = useCallback(async (
    options: { announce?: boolean; label?: string; onlyStale?: boolean } = {},
  ): Promise<CodexProfilesStore> => {
    const existing = codexUsageRefreshRef.current;
    if (existing) {
      if (options.announce !== false) setStatus('Codex usage refresh already running; waiting for it.');
      return existing;
    }
    const controller = new AbortController();
    codexRefreshWasCancelledRef.current = false;
    bulkRefreshAbortRef.current = controller;
    const task = (async () => {
      setBusy(options.label ?? 'Refreshing Codex usage…');
      try {
        const next = await refreshAllCodexProfiles({
          onlyStale: options.onlyStale,
          signal: controller.signal,
          onProgress: (completed, total) => {
            setBusy(`${options.label ?? 'Refreshing Codex usage…'} ${completed}/${total}`);
          },
        });
        codexStoreRef.current = next;
        setCodexStore(next);
        if (controller.signal.aborted) {
          codexRefreshWasCancelledRef.current = true;
          setStatus('Codex refresh cancelled; completed account results were kept.');
        } else if (options.announce !== false) {
          const fresh = next.profiles.filter((profile) => profile.usage?.status === 'ok'
            && Date.now() - profile.usage.fetchedAt <= 10 * 60_000).length;
          const attention = next.profiles.length - fresh;
          setStatus(`Codex refresh: ${fresh}/${next.profiles.length} fresh${attention ? `, ${attention} cached/unavailable` : ''}.`);
        }
        return next;
      } catch (e) {
        codexRefreshWasCancelledRef.current = controller.signal.aborted;
        const current = loadCodexStore();
        codexStoreRef.current = current;
        setCodexStore(current);
        setStatus(controller.signal.aborted
          ? 'Codex refresh cancelled; completed account results were kept.'
          : `Codex refresh failed: ${redactText(e)}`);
        return current;
      } finally {
        if (bulkRefreshAbortRef.current === controller) bulkRefreshAbortRef.current = null;
        setBusy(null);
      }
    })();
    codexUsageRefreshRef.current = task;
    try {
      return await task;
    } finally {
      if (codexUsageRefreshRef.current === task) codexUsageRefreshRef.current = null;
    }
  }, []);

  const beginCodexSwitch = useCallback((target: CodexProfile) => {
    if (target.id === codexStoreRef.current.activeProfileId) {
      setStatus(`"${target.label}" is already the active Codex account.`);
      return;
    }
    if (target.needsReauth) {
      setStatus(`"${target.label}" needs to be re-added before switching.`);
      return;
    }
    setPendingCodexSwitch(target);
    setMode('codexConfirmSwitch');
  }, []);

  const chooseBestCodexNow = useCallback(async () => {
    const fresh = await refreshCodexUsage({ announce: false, label: 'Evaluating Codex Best Now…', onlyStale: true });
    if (codexRefreshWasCancelledRef.current) return;
    const decision = bestNowCodex(fresh.profiles, fresh.activeProfileId);
    const target = decision.target;
    if (!target) {
      setStatus(bestNowUnavailableStatus(
        'Codex',
        decision,
        (id) => fresh.profiles.find((profile) => profile.id === id)?.label,
      ));
      return;
    }
    if (decision.confidence === 'low') {
      setCodexCursor(fresh.profiles.findIndex((profile) => profile.id === target.id));
      setStatus(`Best Now did not switch: Codex did not return a fresh, complete projection for ${target.label}. Retry later or run doctor codex.`);
      return;
    }
    setCodexCursor(fresh.profiles.findIndex((profile) => profile.id === target.id));
    if (target.id === fresh.activeProfileId) {
      setStatus(`Best Now: "${target.label}" is already active — ${bestNowDetail(decision)}.`);
      return;
    }
    beginCodexSwitch(target);
  }, [beginCodexSwitch, refreshCodexUsage]);

  const doCodexSwitch = useCallback(async (target: CodexProfile) => {
    setMode('list');
    setBusy(`Switching Codex to ${target.label}…`);
    try {
      const job = startCodexSwitchWorker(target.id);
      const result = await waitForCodexSwitchResult(job.resultPath);
      reloadCodexStore();
      setPendingCodexSwitch(null);
      setBusy(null);
      showMessage(result.ok ? `Switched Codex to ${target.label}` : 'Codex switch failed', [redactText(result.message)], result.ok ? 'success' : 'error');
    } catch (e) {
      setBusy(null);
      showMessage('Codex switch failed', [redactText(e)], 'error');
    }
  }, [reloadCodexStore, showMessage]);

  const exportSelectedCodex = useCallback(async () => {
    if (!codexSelected) return;
    try {
      const file = await exportCodexProfile(codexSelected, { processInventory: findCodexProcesses });
      clipboard.write(file).catch(() => {});
      showMessage('Codex account exported', [file, '', 'Path copied. This file contains login secrets. Keep it private.'], 'success', exportDir());
    } catch (e) {
      showMessage('Codex export failed', [redactText(e)], 'error');
    }
  }, [codexSelected, showMessage]);

  const exportAllCodex = useCallback(async () => {
    try {
      const file = await exportAllCodexProfiles(codexStore, { processInventory: findCodexProcesses });
      clipboard.write(file).catch(() => {});
      showMessage('All Codex accounts exported', [file, '', 'Path copied. This file contains login secrets. Keep it private.'], 'success', exportDir());
    } catch (e) {
      showMessage('Codex export failed', [redactText(e)], 'error');
    }
  }, [codexStore, showMessage]);

  const restoreCodexRecovery = useCallback(async () => {
    setBusy('Checking Codex recovery archives…');
    try {
      const result = await restoreLatestCodexRecovery();
      codexStoreRef.current = result.store;
      setCodexStore(result.store);
      if (result.source === 'none') {
        setStatus('No archived Codex profile or recoverable abandoned login was found.');
        return;
      }
      setCodexCursor(Math.max(0, result.store.profiles.findIndex((profile) => profile.id === result.profile.id)));
      if (result.source === 'tombstone') {
        setStatus(`Restored archived Codex profile "${result.profile.label}".`);
        return;
      }
      showMessage(
        'Recovered abandoned Codex login',
        [
          `Recovered "${result.profile.label}" as a saved, inactive Codex profile.`,
          'The original diagnostic archive was retained:',
          result.archive.directory,
          ...(result.archiveMarkedRecovered
            ? []
            : ['', 'Warning: recovery succeeded, but the archive could not be marked as recovered; doctor may still offer it.']),
        ],
        result.archiveMarkedRecovered ? 'success' : 'info',
      );
    } catch (error) {
      showMessage('Codex recovery failed', [redactText(error), 'No abandoned archive was deleted.'], 'error');
    } finally {
      setBusy(null);
    }
  }, [showMessage]);

  // The running `claude` CLI session (if any) refreshes its OWN token independently
  // while it's alive, which rotates the refresh token server-side and can desync our
  // cached copy for the ACTIVE profile — a background refresh attempt here would then
  // get rejected (invalid_grant) even though the account is perfectly fine live. Re-sync
  // from the live files first (cheap, local-only) before touching the active profile.
  const reconcileActiveIfLive = useCallback((s: ProfilesStore, p: Profile) => {
    if (p.id !== s.activeProfileId) return;
    try {
      const next = reconcileStoreWithProviderProof();
      storeRef.current = next;
      const persisted = next.profiles.find((candidate) => candidate.id === p.id);
      if (persisted) Object.assign(p, persisted);
      setStore(next);
    } catch (e) {
      logger.error('reconcile before usage fetch failed', e);
    }
  }, []);

  // On open, populate usage for EVERY account (not just the active one) so the whole
  // table is fresh immediately — no more "I have to press refresh myself". The active
  // account goes first (fast, most relevant); the rest follow staggered so we stay gentle
  // on the rate-limited usage endpoint. fetchUsage's own cache means already-fresh rows
  // don't re-hit the network.
  useEffect(() => {
    (async () => {
      let s: ProfilesStore;
      try {
        s = reconcileStoreWithProviderProof();
        const metadata = await recoverMissingClaudeProfileMetadata(claudeVersion);
        s = metadata.store;
        storeRef.current = s;
        setStore(s);
      } catch (error) {
        logger.error('mount reconciliation failed; parked-account refresh aborted', error);
        return;
      }
      const a = getActive(s);
      if (a) {
        try {
          const info = await fetchUsage(a, claudeVersion, {
            onRotate,
            allowRefresh: false,
            activeRefresh: true,
          });
          persistUsage(a.id, info);
        } catch (e) {
          logger.error('mount usage fetch failed', e);
        }
      }
      for (const p of s.profiles) {
        if (p.id === s.activeProfileId || !hasCliAuth(p)) continue;
        try {
          const info = await fetchUsage(p, claudeVersion, { onRotate });
          persistUsage(p.id, info);
        } catch (e) {
          logger.error('mount usage fetch failed', e, { email: p.email });
        }
        await sleep(600); // be gentle with the rate-limited endpoint
      }
      // A quota read may have safely renewed an expired parked token. Retry unresolved
      // identity once with that newest access token, still without rotating anything here.
      try {
        const metadata = await recoverMissingClaudeProfileMetadata(claudeVersion);
        storeRef.current = metadata.store;
        setStore(metadata.store);
      } catch (error) {
        logger.warn('post-refresh Claude metadata recovery unavailable', { error: String(error) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep-alive: every 10 minutes, proactively refresh the OAuth token of ANY account whose
  // token expires within the next ~30 minutes — parked accounts included. This only touches
  // the token endpoint, rotating and persisting before access expiry. Anthropic's finite
  // login lifetime and server-side revocations still require an official login renewal.
  useEffect(() => {
    const KEEP_ALIVE_LEAD_MS = 30 * 60 * 1000;
    // Stable rotate handler (reads live store via ref) so this effect doesn't re-subscribe
    // on every persist. Persists the rotation and, if the rotated account is the active one,
    // syncs it into the live credentials so a running `claude` session stays valid.
    const rotate = (p: Profile) => {
      const s = loadStore();
      storeRef.current = s;
      const persisted = s.profiles.find((candidate) => candidate.id === p.id) ?? p;
      if (persisted.id === s.activeProfileId && hasCliAuth(persisted) && !persisted.needsReauth) {
        try {
          updateLiveCredentials(persisted.claudeAiOauth, persisted.organizationUuidRoot ?? persisted.organizationUuid);
        } catch {
          /* ignore */
        }
      }
    };
    const run = () => {
      (async () => {
        let safeStore: ProfilesStore;
        try {
          safeStore = reconcileStoreWithProviderProof();
          storeRef.current = safeStore;
          setStore(safeStore);
        } catch (error) {
          logger.error('keep-alive reconciliation failed; parked-account refresh aborted', error);
          return;
        }
        for (const p of safeStore.profiles) {
          if (!hasCliAuth(p) || p.needsReauth) continue;
          if (p.id === safeStore.activeProfileId) {
            // After a reboot there is no in-memory official owner. Renew the live token
            // under the provider/process guards; if Claude is running, this safely no-ops.
            await keepActiveTokenAlive(p, KEEP_ALIVE_LEAD_MS, rotate);
          } else {
            await keepTokenAlive(p, KEEP_ALIVE_LEAD_MS, rotate);
          }
        }
        await recoverMissingClaudeProfileMetadata(claudeVersion).catch((error) => {
          logger.warn('background Claude imported-profile metadata remains unavailable', { error: String(error) });
        });
        await refreshClaudePlanProjection().catch((error) => {
          logger.warn('background Claude plan refresh unavailable', { error: String(error) });
        });
        reloadClaudeStore();
      })().catch((e) => logger.error('keep-alive failed', e));
    };
    run(); // once shortly after open, then on the interval
    const t = setInterval(run, 10 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeVersion]);

  // As you move the cursor (hover, no need to press Enter), preview that account's
  // usage in the panel below. fetchUsage's own 10-minute cache means flicking through
  // many rows quickly won't spam the rate-limited endpoint — it only actually fetches
  // when that specific account's cached usage is missing or stale. The extra 250ms
  // debounce avoids firing a request for every row you pass through while holding ↑/↓.
  useEffect(() => {
    const p = profiles[cursor];
    if (!p || (!hasCliAuth(p) && !p.needsReauth)) return;
    const t = setTimeout(() => {
      reconcileActiveIfLive(storeRef.current, p);
      fetchUsage(p, claudeVersion, {
        onRotate,
        allowRefresh: p.id !== storeRef.current.activeProfileId,
        activeRefresh: p.id === storeRef.current.activeProfileId ? true : undefined,
      })
        .then((info) => {
          persistUsage(p.id, info);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, claudeVersion, reconcileActiveIfLive, persistUsage, onRotate]);

  // Codex gets the same cursor-preview behaviour without forcing a token rotation.
  // The live account is inspected through the real CODEX_HOME; parked accounts use
  // their isolated home with account/read(refreshToken=false).
  useEffect(() => {
    if (provider !== 'codex') return;
    const selectedId = codexProfiles[codexCursor]?.id;
    if (!selectedId) return;
    const t = setTimeout(() => {
      void (async () => {
        if (codexUsageRefreshRef.current) return;
        const current = loadCodexStore();
        const profile = current.profiles.find((candidate) => candidate.id === selectedId);
        if (!profile || profile.needsReauth) return;
        try {
          const next = profile.id === current.activeProfileId
            ? (await reconcileLiveCodex(false)).store
            : profile.usage?.status === 'ok' && Date.now() - profile.usage.fetchedAt < 10 * 60 * 1000
              ? current
              : await refreshCodexProfile(profile.id, { forceTokenRefresh: false });
          codexStoreRef.current = next;
          setCodexStore(next);
        } catch (error) {
          logger.error('Codex cursor usage preview failed', error, { email: profile.email });
        }
      })();
    }, 250);
    return () => clearTimeout(t);
    // Store changes intentionally do not re-trigger preview; cursor/tab changes do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, codexCursor]);

  // First run: offer the one-click setup (shortcuts + auto keep-alive) exactly once.
  useEffect(() => {
    if (shouldOfferSetup()) {
      markSetupOffered();
      setMode('setup');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check for a newer published version (best-effort, silent on failure).
  useEffect(() => {
    checkForUpdate(APP_VERSION)
      .then((r) => {
        if (r.available && r.remoteVersion) setNewVersion(r.remoteVersion);
      })
      .catch(() => {});
  }, []);

  // Auto-clear transient status notifications after 5 seconds.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(''), 5000);
    return () => clearTimeout(t);
  }, [status]);

  // Auto-refresh the ACTIVE account's usage every 2 minutes (one lightweight request;
  // the 30s floor + 10min cache in fetchUsage keep us well within the rate limit).
  useEffect(() => {
    const t = setInterval(() => {
      const s = storeRef.current;
      const a = getActive(s);
      if (!a) return;
      reconcileActiveIfLive(s, a);
      void fetchUsage(a, claudeVersion, {
        force: true,
        allowRefresh: false,
        activeRefresh: true,
        onRotate: (p) => {
          const current = loadStore();
          storeRef.current = current;
          const persisted = current.profiles.find((candidate) => candidate.id === p.id) ?? p;
          if (persisted.id === current.activeProfileId && hasCliAuth(persisted) && !persisted.needsReauth) {
            try {
              updateLiveCredentials(persisted.claudeAiOauth, persisted.organizationUuidRoot ?? persisted.organizationUuid);
            } catch {
              /* ignore */
            }
          }
        },
      })
        .then((info) => {
          persistUsage(a.id, info);
        })
        .catch(() => {});
    }, 120_000);
    return () => clearInterval(t);
  }, [claudeVersion, persistUsage, reconcileActiveIfLive]);

  const refreshAllUsage = useCallback(async (
    options: { announce?: boolean; label?: string; onlyStale?: boolean } = {},
  ): Promise<ProfilesStore> => {
    const existing = claudeUsageRefreshRef.current;
    if (existing) {
      if (options.announce !== false) setStatus('Usage refresh already running; waiting for it.');
      return existing;
    }
    const controller = new AbortController();
    claudeRefreshWasCancelledRef.current = false;
    bulkRefreshAbortRef.current = controller;
    const task = (async () => {
      const label = options.label ?? 'Refreshing usage…';
      setBusy(label);
      try {
        let reconciled = reconcileStoreWithProviderProof();
        const metadata = await recoverMissingClaudeProfileMetadata(claudeVersion, {
          signal: controller.signal,
        });
        reconciled = metadata.store;
        storeRef.current = reconciled;
        setStore(reconciled);
        const observedAt = Date.now();
        const ids = reconciled.profiles
          .filter((profile) => hasCliAuth(profile) || profile.needsReauth)
          .filter((profile) => !options.onlyStale || !hasFreshCompleteClaudeUsage(profile, observedAt))
          .map((profile) => profile.id);
        setBusy(`${label} 0/${ids.length}`);
        for (let index = 0; index < ids.length; index++) {
          if (controller.signal.aborted) break;
          let current = loadStore();
          let profile = current.profiles.find((candidate) => candidate.id === ids[index]);
          if (!profile) {
            setBusy(`${label} ${index + 1}/${ids.length}`);
            continue;
          }
          if (profile.id === current.activeProfileId) {
            reconcileActiveIfLive(current, profile);
            current = loadStore();
            profile = current.profiles.find((candidate) => candidate.id === ids[index]);
            if (!profile) {
              setBusy(`${label} ${index + 1}/${ids.length}`);
              continue;
            }
          }
          try {
            const info = await fetchUsage(profile, claudeVersion, {
              force: true,
              onRotate,
              allowRefresh: profile.id !== current.activeProfileId,
              activeRefresh: profile.id === current.activeProfileId ? true : undefined,
            });
            persistUsage(profile.id, info);
          } catch (e) {
            logger.error('usage refresh failed', e, { email: profile.email });
          }
          setBusy(`${label} ${index + 1}/${ids.length}`);
          if (controller.signal.aborted) break;
          if (index < ids.length - 1) await sleep(500); // gentle global pacing
        }
        if (!controller.signal.aborted) {
          await refreshClaudePlanProjection(controller.signal).catch((error) => {
            if (!controller.signal.aborted) {
              logger.warn('manual Claude plan refresh unavailable', { error: String(error) });
            }
          });
          await recoverMissingClaudeProfileMetadata(claudeVersion, {
            signal: controller.signal,
          }).catch((error) => {
            if (!controller.signal.aborted) {
              logger.warn('post-refresh Claude metadata recovery unavailable', { error: String(error) });
            }
          });
        }
        const next = loadStore();
        storeRef.current = next;
        setStore(next);
        if (controller.signal.aborted) {
          claudeRefreshWasCancelledRef.current = true;
          setStatus('Claude refresh cancelled; completed account results were kept.');
        } else if (options.announce !== false) {
          setStatus(describeClaudeRefreshResult(next.profiles, next.activeProfileId));
        }
        return next;
      } catch (error) {
        claudeRefreshWasCancelledRef.current = controller.signal.aborted;
        logger.error('manual usage refresh failed', error);
        const current = loadStore();
        storeRef.current = current;
        setStore(current);
        setStatus(controller.signal.aborted
          ? 'Claude refresh cancelled; completed account results were kept.'
          : `Usage refresh failed: ${redactText(error)}`);
        return current;
      } finally {
        if (bulkRefreshAbortRef.current === controller) bulkRefreshAbortRef.current = null;
        setBusy(null);
      }
    })();
    claudeUsageRefreshRef.current = task;
    try {
      return await task;
    } finally {
      if (claudeUsageRefreshRef.current === task) claudeUsageRefreshRef.current = null;
    }
  }, [claudeVersion, persistUsage, onRotate, reconcileActiveIfLive, refreshClaudePlanProjection]);

  const doSwitch = useCallback(
    async (requestedTarget: Profile) => {
      setMode('list');
      setBusy(`Switching to ${requestedTarget.label}…`);
      try {
        await withFileLock('claude-provider-switch', async () => {
          const lines: string[] = [];

      // A Claude process can retain the outgoing rotating refresh token in memory and
      // later overwrite the account we install. Detection is repeated immediately before
      // any write; inspection failure and any remaining process both fail closed.
      try {
        const running = findClaudeProcesses();
        if (running.length) {
          setBusy(null);
          showMessage(
            'Switch blocked',
            [
              `Close Claude normally first (${running.length} process${running.length === 1 ? '' : 'es'} still running).`,
              'No credentials or active-account marker were changed.',
            ],
            'info',
          );
          return;
        }
      } catch (error) {
        setBusy(null);
        showMessage('Switch blocked', [redactText(error), 'No credentials were changed.'], 'error');
        return;
      }

      let target = requestedTarget;
      let claudeBackupDir: string | undefined;
      let desktopBackupDir: string | undefined;
      const commitActiveTarget = (): ProfilesStore => mutateStore((fresh) => {
        const persisted = fresh.profiles.find((profile) => profile.id === target.id);
        if (!persisted) throw new Error('The switched profile disappeared before the active-account commit.');
        persisted.lastUsedAt = Date.now();
        persisted.updatedAt = Date.now();
        fresh.activeProfileId = persisted.id;
      });

      if (hasCliAuth(target)) {
        // Capture the outgoing (currently live) account's latest tokens first.
        try {
          const reconciled = reconcileStoreWithProviderProof();
          const persistedTarget = reconciled.profiles.find((profile) => profile.id === target.id);
          if (!persistedTarget) throw new Error('The target profile disappeared while preparing the switch.');
          target = persistedTarget;
        } catch (e) {
          logger.error('reconcile before switch failed', e);
          setBusy(null);
          showMessage(
            'Switch blocked',
            ['Could not durably save the outgoing account. The live login was left unchanged.', redactText(e)],
            'error',
          );
          return;
        }
        // Proactively refresh the target's token if it's expired, so it works instantly.
        // Routed through the single-flighted ensureFreshToken so it can't race (and burn
        // the token against) a background refresh of this same account.
        let hasFreshToken = false;
        try {
          hasFreshToken = await ensureFreshToken(target, onRotate, { providerLockHeld: true });
        } catch (e) {
          logger.warn('proactive refresh on switch failed', { email: target.email });
        }
        if (!hasFreshToken || target.needsReauth) {
          setBusy(null);
          showMessage('Switch failed', ['This account login has expired. Re-add it with "a" before switching.'], 'error');
          return;
        }
        // ensureFreshToken may have rotated the target and persisted a newer generation.
        // Always apply that durable copy, never the pre-refresh React object.
        target = loadStore().profiles.find((profile) => profile.id === target.id) ?? target;
        try {
          const runningBeforeWrite = findClaudeProcesses();
          if (runningBeforeWrite.length) {
            setBusy(null);
            showMessage(
              'Switch blocked',
              [
                `Claude started while the target was being prepared (${runningBeforeWrite.length} process${runningBeforeWrite.length === 1 ? '' : 'es'} detected).`,
                'No live credentials were changed.',
              ],
              'info',
            );
            return;
          }
        } catch (error) {
          setBusy(null);
          showMessage('Switch blocked', [redactText(error), 'No live credentials were changed.'], 'error');
          return;
        }
        const res = applyProfile(target);
        if (!res.ok) {
          setBusy(null);
          const recovery = res.rollback === 'succeeded'
            ? 'The previous Claude CLI login was restored from backup.'
            : res.rollback === 'failed'
              ? `Automatic rollback failed. Manual recovery is required${res.backupDir ? ` from ${res.backupDir}` : ''}.`
              : 'The live Claude CLI login was not changed.';
          showMessage(res.rollback === 'failed' ? 'Switch failed — manual recovery required' : 'Switch failed', [res.error ?? 'unknown error', recovery], 'error');
          return;
        }
        claudeBackupDir = res.backupDir;
        lines.push(
          `Claude Code CLI: now authenticated as ${target.email} (${target.subscriptionType ?? 'unknown plan'})`,
          '• Claude was confirmed closed before the atomic credential swap.',
        );
      }

      // Close the last race between the pre-write scan and Desktop's LevelDB/SQLite
      // replacement. If Claude appeared after a successful CLI swap, keep that proven
      // live target as active (rather than restoring beneath a process that may own it)
      // and leave Desktop untouched. The outgoing CLI chain was already journaled.
      let processRace: string | null = null;
      try {
        const appeared = findClaudeProcesses();
        if (appeared.length) processRace = `Claude started during the transaction (${appeared.map((proc) => proc.pid).join(', ')}).`;
      } catch (error) {
        processRace = `Claude process state could not be re-verified: ${redactText(error)}`;
      }
      if (processRace && target.desktopSnapshotDir) {
        if (!claudeBackupDir) {
          setBusy(null);
          showMessage('Desktop switch blocked', [processRace, 'No Desktop or CLI credentials were changed.'], 'error');
          return;
        }
        try {
          const partial = commitActiveTarget();
          storeRef.current = partial;
          setStore(partial);
          setBusy(null);
          showMessage(
            'Partial switch — close Claude before retrying',
            [processRace, `Claude CLI remains safely authenticated as ${target.email}.`, 'Claude Desktop was not modified.'],
            'error',
          );
        } catch (error) {
          setBusy(null);
          showMessage(
            'Partial switch — manual recovery required',
            [processRace, 'The CLI target is live, Desktop was not modified, and the active metadata commit failed.', redactText(error)],
            'error',
          );
        }
        return;
      }
      if (processRace) lines.push(`• Warning: ${processRace} The validated CLI target was retained.`);

      if (target.desktopSnapshotDir) {
        const res = applyDesktopSnapshot(target.desktopSnapshotDir);
        if (!res.ok) {
          const recoveryLines = [res.error ?? 'Claude Desktop session swap failed.'];
          let manualRecovery = res.rollback === 'failed';
          recoveryLines.push(
            res.rollback === 'succeeded'
              ? 'The previous Desktop session was restored.'
              : res.rollback === 'deferred'
                ? `Desktop rollback was deferred because Claude became active${res.backupDir ? `; protected backup: ${res.backupDir}` : ''}. Close Claude and relaunch the switcher to recover automatically.`
              : res.rollback === 'failed'
                ? `Desktop rollback failed${res.backupDir ? `; backup retained at ${res.backupDir}` : ''}.`
                : 'The Desktop session was not changed.',
          );
          if (claudeBackupDir) {
            try {
              restoreFromBackup(claudeBackupDir);
              recoveryLines.push('The previous Claude CLI login was restored.');
            } catch (rollbackError) {
              markManualRecovery(claudeBackupDir, 'Combined Claude CLI/Desktop rollback failed; manual recovery required.');
              logger.error('combined CLI/Desktop rollback failed', rollbackError, { backupDir: claudeBackupDir });
              manualRecovery = true;
              recoveryLines.push(
                `CLI rollback also failed: ${String((rollbackError as Error).message ?? rollbackError)}`,
                `CLI backup retained at: ${claudeBackupDir}`,
              );
            }
          } else {
            recoveryLines.push('The Claude CLI login was not changed.');
          }
          setBusy(null);
          showMessage(
            manualRecovery ? 'Switch failed — manual recovery required' : 'Desktop switch failed',
            recoveryLines,
            'error',
          );
          return;
        }
        desktopBackupDir = res.backupDir;
        lines.push('', `Claude Desktop: session swapped to ${target.email}. Reopen Claude Desktop when ready.`);
      }

      let next: ProfilesStore;
      try {
        next = commitActiveTarget();
      } catch (commitError) {
        const committedPrimary = loadStore();
        if (committedPrimary.activeProfileId === target.id) {
          // mutateStore commits profiles.json before its recovery sidecar. A sidecar-only
          // failure is degraded redundancy, not a failed active-account commit; rolling
          // live auth back here would contradict the authoritative primary metadata.
          logger.warn('Claude active profile committed but sidecar repair is pending', { profileId: target.id });
          lines.push('• Recovery sidecar update failed; the authoritative active profile is committed and doctor can repair redundancy.');
          next = committedPrimary;
        } else {
        const rollbackErrors: string[] = [];
        if (desktopBackupDir) {
          try {
            restoreDesktopBackup(desktopBackupDir);
          } catch (error) {
            markManualRecovery(desktopBackupDir, 'Metadata commit rollback failed for Claude Desktop.');
            rollbackErrors.push(`Desktop: ${redactText(error)} (backup: ${desktopBackupDir})`);
          }
        }
        if (claudeBackupDir) {
          try {
            restoreFromBackup(claudeBackupDir);
          } catch (error) {
            markManualRecovery(claudeBackupDir, 'Metadata commit rollback failed for Claude CLI.');
            rollbackErrors.push(`CLI: ${redactText(error)} (backup: ${claudeBackupDir})`);
          }
        }
        setBusy(null);
        showMessage(
          rollbackErrors.length ? 'Metadata commit failed — manual recovery required' : 'Metadata commit failed',
          [
            String((commitError as Error).message ?? commitError),
            ...(rollbackErrors.length
              ? ['Some automatic rollbacks failed:', ...rollbackErrors]
              : ['The previous Claude sessions were restored; the active-account marker was not committed.']),
          ],
          'error',
        );
        return;
        }
      }
      storeRef.current = next;
      setStore(next);
      setBusy(null);
      showMessage(
        `Switched to ${target.label}`,
        [...lines, '', 'This switcher stays open — no web login needed.'].filter(Boolean),
        'success',
      );
      void refreshClaudePlanProjection().catch(() => undefined);
        });
      } catch (error) {
        logger.error('Claude switch transaction failed', error, { targetId: requestedTarget.id });
        setBusy(null);
        showMessage(
          'Switch transaction failed',
          [redactText(error), 'Inspect the retained backups and log before retrying.'],
          'error',
        );
      }
    },
    [onRotate, refreshClaudePlanProjection, showMessage],
  );

  const beginSwitch = useCallback(
    (target: Profile) => {
      if (target.id === storeRef.current.activeProfileId) {
        setStatus(`"${target.label}" is already the active account.`);
        return;
      }
      if (!hasCliAuth(target) && !target.desktopSnapshotDir) {
        setStatus(`"${target.label}" has no usable login. Press "a" to re-add it.`);
        return;
      }
      setStatus('Scanning running claude processes...');
      let pids: ProcInfo[] = [];
      try {
        pids = findClaudeProcesses();
      } catch (e) {
        logger.error('findClaudeProcesses failed', e);
        showMessage('Switch blocked', [redactText(e), 'Process safety could not be verified.'], 'error');
        return;
      }
      setPendingSwitch({ profile: target, pids });
      setStatus('');
      setMode('confirmSwitch');
    },
    [],
  );

  const chooseBestClaudeNow = useCallback(async () => {
    const fresh = await refreshAllUsage({ announce: false, label: 'Evaluating Claude Best Now…', onlyStale: true });
    if (claudeRefreshWasCancelledRef.current) return;
    const decision = bestNow(fresh.profiles, fresh.activeProfileId);
    const target = decision.target;
    if (!target) {
      setStatus(bestNowUnavailableStatus(
        'Claude',
        decision,
        (id) => fresh.profiles.find((profile) => profile.id === id)?.label,
      ));
      return;
    }
    if (decision.confidence === 'low') {
      setCursor(fresh.profiles.findIndex((profile) => profile.id === target.id));
      setStatus(`Best Now did not switch: Claude did not return a fresh, complete projection for ${target.label}. Retry later or run doctor claude.`);
      return;
    }
    setCursor(fresh.profiles.findIndex((profile) => profile.id === target.id));
    if (target.id === fresh.activeProfileId) {
      setStatus(`Best Now: "${target.label}" is already active — ${bestNowDetail(decision)}.`);
      return;
    }
    beginSwitch(target);
  }, [beginSwitch, refreshAllUsage]);

  const startAdd = useCallback(
    async (reauthEmail?: string) => {
      if (!supportsIsolatedClaudeAuth()) {
        showMessage(
          'Claude add unavailable on macOS',
          ['Claude OAuth lives in the login Keychain and cannot be proven isolated by CLAUDE_CONFIG_DIR. No live credentials were touched.'],
          'error',
        );
        return;
      }
      setMode('adding');
      setBuffer('');
      setAddBusy(false);
      claudeAddSubmissionRef.current = false;
      try {
        const auth = buildManualAuth(DEFAULT_SCOPES);
        authRef.current = auth;
        let copied = true;
        try {
          await clipboard.write(auth.url);
        } catch {
          copied = false;
        }
        setAddLines([
          reauthEmail
            ? `Re-authorize "${reauthEmail}" on the remote computer where that account is available.`
            : 'Authorize the Claude account on any computer:',
          '',
          copied ? '1. Authorization URL copied to your clipboard. No browser was opened.' : '1. Clipboard unavailable. Copy the URL shown below.',
          '2. Open it on the remote computer and approve the account.',
          '3. Copy the authorization code shown at the end, paste it here, then press Enter.',
          '',
          auth.url,
          '',
          'Esc cancels before submission without changing any account.',
        ]);
      } catch (e) {
        authRef.current = null;
        showMessage('Could not start Claude authorization', [redactText(e)], 'error');
      }
    },
    [showMessage],
  );

  const submitAddCode = useCallback(async () => {
    const auth = authRef.current;
    const pastedCode = buffer.trim();
    if (!auth || !pastedCode || claudeAddSubmissionRef.current) return;
    claudeAddSubmissionRef.current = true;
    setAddBusy(true);
    setAddLines(['Exchanging the Claude authorization code…']);
    let checkpointedProfile: Profile | undefined;
    try {
      const tokens = await exchangeCode(pastedCode, auth.verifier, auth.state);
      const checkpoint = checkpointClaudeAuthorization({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes ?? DEFAULT_SCOPES.split(' '),
      });
      checkpointedProfile = checkpoint.profile;
      storeRef.current = checkpoint.store;
      setStore(checkpoint.store);
      setAddLines(['Resolving the Claude account identity in an isolated profile…']);
      let finalized: { store: ProfilesStore; profile: Profile } | undefined;
      primeIdentity(tokens, findClaudeExe(), DEFAULT_SCOPES, (ident) => {
        const fields = identityToFields(ident);
        finalized = finalizeClaudeAuthorization(checkpoint.profile.id, fields);
      });
      const profile = finalized?.profile;
      let next = finalized?.store;
      if (!profile) throw new Error('Claude account was not added after authorization.');
      if (!next) throw new Error('Claude account metadata was not committed after authorization.');
      let liveWarning: string | undefined;
      try {
        next = mutateStoreWithLiveAccount((fresh, live) => {
          const liveMatches = hasRefreshableOauth(live.claudeAiOauth)
            && !!live.oauthAccount?.accountUuid
            && live.oauthAccount.accountUuid === profile.accountUuid;
          if (fresh.activeProfileId === profile.id && !liveMatches) fresh.activeProfileId = null;
        });
      } catch (error) {
        // The new authorization is already parked. A damaged, unrelated live file must
        // not turn a successful one-shot OAuth exchange into account loss.
        liveWarning = `Live Claude state could not be inspected: ${redactText(error)}`;
      }
      authRef.current = null;
      storeRef.current = next;
      setStore(next);
      setCursor(next.profiles.findIndex((candidate) => candidate.id === profile!.id));
      setBuffer('');
      showMessage(
        'Claude account added',
        [
          `${profile.label} (${profile.email})`,
          `Plan: ${profile.subscriptionType ?? 'unknown'}`,
          ...(profile.needsReauth
            ? ['', 'Credentials are safely parked, but identity resolution is incomplete. Re-add this row to finish recovery.']
            : []),
          ...(liveWarning ? ['', liveWarning] : []),
          '',
          next.activeProfileId === profile.id ? 'This account is already live.' : 'Select it and press Enter to apply it to Claude.',
        ],
        'success',
      );
    } catch (error) {
      authRef.current = null;
      if (checkpointedProfile) {
        const recovered = loadStore();
        const safeError = redactText(error);
        const isolatedHomeRetained = /isolated recovery home was retained/i.test(safeError);
        storeRef.current = recovered;
        setStore(recovered);
        showMessage(
          isolatedHomeRetained
            ? 'Claude authorization needs recovery'
            : 'Claude authorization saved — identity recovery needed',
          [
            safeError,
            '',
            isolatedHomeRetained
              ? 'The pre-probe checkpoint may have been superseded by a provider rotation. The retained isolated home is the recovery source of truth; it was not deleted.'
              : `The new refresh credential is preserved as "${checkpointedProfile.label}" and was not discarded.`,
          ],
          'error',
        );
      } else {
        showMessage(
          'Claude authorization failed',
          [redactText(error), '', 'The existing accounts were not changed. Press a to start a fresh authorization.'],
          'error',
        );
      }
    } finally {
      claudeAddSubmissionRef.current = false;
      setAddBusy(false);
    }
  }, [buffer, showMessage]);

  const startCaptureDesktop = useCallback(() => {
    try {
      if (!isDesktopInstalled()) {
        setStatus('Claude Desktop data folder was not found on this machine.');
        return;
      }
    } catch (error) {
      showMessage('Desktop capture blocked', [redactText(error)], 'error');
      return;
    }
    setBuffer('');
    setMode('capturingDesktopConfirm');
  }, [showMessage]);

  const finalizeDesktopCapture = useCallback(
    async (email: string) => {
      setDesktopBusy(true);
      try {
        let p: Profile | undefined;
        const next = await withFileLock('claude-provider-switch', async () => {
          const running = findClaudeProcesses();
          if (running.length) {
            throw new Error(`Claude is still running (${running.map((process) => process.pid).join(', ')}). Close it normally before capturing Desktop.`);
          }
          return mutateStore((fresh) => {
            p = captureDesktopAccount(fresh, desktopLabelRef.current, email);
          });
        });
        if (!p) throw new Error('Desktop account was not captured.');
        storeRef.current = next;
        setStore(next);
        setCursor(next.profiles.findIndex((x) => x.id === p!.id));
        setMode('list');
        showMessage(
          'Desktop session captured',
          [
            `${p.label} (${p.email})`,
            '',
            'This capture was saved as an independent Desktop profile; a typed email is never used to auto-link credentials.',
            'Usage/quota is not available for Desktop accounts (tokens are OS-encrypted).',
            'This session is tied to this machine — it cannot be exported/imported to another PC.',
          ],
          'success',
        );
      } catch (e) {
        showMessage('Capture failed', [redactText(e)], 'error');
      } finally {
        setDesktopBusy(false);
        setBuffer('');
      }
    },
    [showMessage],
  );

  const openImportMenu = useCallback(() => {
    try {
      const items: ImportInboxItem[] = provider === 'claude'
        ? groupClaudeImportCandidates(scanImportDir()).map((group) => ({
            key: group.key,
            title: group.source,
            detail: `${group.candidates.length} account${group.candidates.length === 1 ? '' : 's'} · ${group.candidates
              .slice(0, 2)
              .map((candidate) => candidate.fields.email)
              .join(', ')}${group.candidates.length > 2 ? ', …' : ''}`,
            sourcePaths: group.consumedPaths,
            format: group.format,
            claudeGroup: group,
          }))
        : scanCodexImportDir().map((file) => ({
            key: path.resolve(file),
            title: path.basename(file),
            detail: file.toLowerCase().endsWith('.codexswitch.json') ? 'Codex switcher export' : 'Official Codex auth.json cache',
            sourcePaths: [file],
            format: file.toLowerCase().endsWith('.codexswitch.json') ? 'switch-export' : 'raw-credentials',
            codexPath: file,
          }));
      setImportItems(items);
    } catch (e) {
      logger.error('provider import inbox scan failed', e, { provider });
      setImportItems([]);
    }
    setImportCursor(0);
    setMode('importMenu');
  }, [provider]);

  const doImportItem = useCallback(
    async (item: ImportInboxItem) => {
      try {
        setMode('importing');
        if (item.claudeGroup) {
          const metadata = await recoverClaudeImportMetadata(item.claudeGroup.candidates, claudeVersion);
          const imported: Profile[] = [];
          const next = mutateStore((fresh) => {
            for (const candidate of metadata.candidates) {
              imported.push(addOrUpdateProfile(fresh, candidate.fields, candidate.label, {
                credentialSource: candidate.format === 'raw-credentials' ? 'raw-import' : 'portable-import',
              }));
            }
          });
          const uniqueProfiles = [...new Map(imported.map((profile) => [profile.id, profile])).values()];
          const disposition = archiveImportedSources('claude', item.sourcePaths, uniqueProfiles);
          storeRef.current = next;
          setStore(next);
          const first = uniqueProfiles[0];
          if (first) setCursor(next.profiles.findIndex((profile) => profile.id === first.id));
          showMessage(
            `Imported ${uniqueProfiles.length} Claude account${uniqueProfiles.length === 1 ? '' : 's'}`,
            [
              importDispositionSummary(disposition),
              providerMetadataSummary(metadata.verifiedCount, metadata.candidates.length),
              ...(item.format === 'raw-credentials'
                ? ['Only .credentials.json was required; .claude.json was optional identity metadata.']
                : []),
              '⧉ Imported session: another active PC can make token renewal less reliable.',
              ...disposition.errors.map((error) => `Cleanup warning: ${redactText(error)}`),
            ],
            'success',
            disposition.receiptPath ? path.dirname(disposition.receiptPath) : undefined,
          );
          return;
        }

        if (!item.codexPath) throw new Error('The selected Codex import source disappeared.');
        let imported = await importCodexFromPath(item.codexPath);
        if (!imported.length) throw new Error('No reusable Codex account was found in that source.');
        const importedCount = imported.length;
        const metadata = await recoverImportedCodexMetadata(imported);
        const refreshedProfiles = imported
          .map((profile) => metadata.store.profiles.find((candidate) => candidate.id === profile.id))
          .filter((profile): profile is CodexProfile => !!profile);
        if (refreshedProfiles.length) imported = refreshedProfiles;
        const disposition = archiveImportedSources('codex', item.sourcePaths, imported);
        const next = reloadCodexStore();
        if (imported[0]) setCodexCursor(next.profiles.findIndex((profile) => profile.id === imported[0].id));
        showMessage(
          `Imported ${imported.length} Codex account${imported.length === 1 ? '' : 's'}`,
          [
            importDispositionSummary(disposition),
            providerMetadataSummary(metadata.verifiedCount, importedCount),
            '⧉ Imported session: another active PC can make token renewal less reliable.',
            ...disposition.errors.map((error) => `Cleanup warning: ${redactText(error)}`),
          ],
          'success',
          disposition.receiptPath ? path.dirname(disposition.receiptPath) : undefined,
        );
      } catch (e) {
        showMessage('Import failed', [redactText(e)], 'error');
      }
    },
    [claudeVersion, reloadCodexStore, showMessage],
  );

  const doImportPath = useCallback(async (rawTarget: string) => {
    const target = normalizeImportPath(rawTarget);
    if (!target) {
      openImportMenu();
      return;
    }
    setMode('importing');
    try {
      if (provider === 'claude') {
        const discovered = importFromPath(target);
        const metadata = await recoverClaudeImportMetadata(discovered, claudeVersion);
        const candidates = metadata.candidates;
        if (!candidates.length) throw new Error('No reusable Claude credential or switcher export was found at that path.');
        const imported: Profile[] = [];
        const next = mutateStore((fresh) => {
          for (const candidate of candidates) {
            imported.push(addOrUpdateProfile(fresh, candidate.fields, candidate.label, {
              credentialSource: candidate.format === 'raw-credentials' ? 'raw-import' : 'portable-import',
            }));
          }
        });
        const uniqueProfiles = [...new Map(imported.map((profile) => [profile.id, profile])).values()];
        const sources = [...new Set(candidates.flatMap((candidate) => candidate.consumedPaths))];
        const disposition = archiveImportedSources('claude', sources, uniqueProfiles);
        storeRef.current = next;
        setStore(next);
        if (uniqueProfiles[0]) setCursor(next.profiles.findIndex((profile) => profile.id === uniqueProfiles[0].id));
        showMessage(
          `Imported ${uniqueProfiles.length} Claude account${uniqueProfiles.length === 1 ? '' : 's'}`,
          [
            importDispositionSummary(disposition),
            providerMetadataSummary(metadata.verifiedCount, candidates.length),
            ...(candidates.some((candidate) => candidate.format === 'raw-credentials')
              ? ['Only .credentials.json is required; .claude.json is optional identity metadata.']
              : []),
            '⧉ Imported session: another active PC can make token renewal less reliable.',
            ...disposition.errors.map((error) => `Cleanup warning: ${redactText(error)}`),
          ],
          'success',
          disposition.receiptPath ? path.dirname(disposition.receiptPath) : undefined,
        );
        return;
      }

      const sources = discoverCodexImportFiles(target);
      let imported = await importCodexFromPath(target);
      if (!imported.length) throw new Error('No reusable Codex auth.json or switcher export was found at that path.');
      const importedCount = imported.length;
      const metadata = await recoverImportedCodexMetadata(imported);
      const refreshedProfiles = imported
        .map((profile) => metadata.store.profiles.find((candidate) => candidate.id === profile.id))
        .filter((profile): profile is CodexProfile => !!profile);
      if (refreshedProfiles.length) imported = refreshedProfiles;
      const disposition = archiveImportedSources('codex', sources, imported);
      const next = reloadCodexStore();
      if (imported[0]) setCodexCursor(next.profiles.findIndex((profile) => profile.id === imported[0].id));
      showMessage(
        `Imported ${imported.length} Codex account${imported.length === 1 ? '' : 's'}`,
        [
          importDispositionSummary(disposition),
          providerMetadataSummary(metadata.verifiedCount, importedCount),
          '⧉ Imported session: another active PC can make token renewal less reliable.',
          ...disposition.errors.map((error) => `Cleanup warning: ${redactText(error)}`),
        ],
        'success',
        disposition.receiptPath ? path.dirname(disposition.receiptPath) : undefined,
      );
    } catch (error) {
      showMessage('Import failed', [redactText(error)], 'error');
    }
  }, [claudeVersion, openImportMenu, provider, reloadCodexStore, showMessage]);

  const exportSelected = useCallback(async () => {
    if (!selected) return;
    try {
      const file = await exportProfile(selected);
      clipboard.write(file).catch(() => {});
      showMessage(
        'Exported',
        [
          'Portable file written (path copied to clipboard):',
          '',
          file,
          '',
          'This file contains login secrets. Keep it private.',
          'Copy it to another PC and press "i" (Import) there.',
        ],
        'success',
        exportDir(),
      );
    } catch (e) {
      showMessage('Export failed', [redactText(e)], 'error');
    }
  }, [selected, showMessage]);

  const exportAllAccounts = useCallback(async () => {
    if (!store.profiles.length) {
      setStatus('No accounts to export.');
      return;
    }
    try {
      const result = await exportAllProfiles(store);
      clipboard.write(result.file).catch(() => {});
      showMessage(
        'Claude Code portable export created',
        [
          `${result.exportedCount} Claude Code account credential(s) written (path copied):`,
          '',
          result.file,
          '',
          ...(result.skippedDesktopOnly.length
            ? [`${result.skippedDesktopOnly.length} Desktop-only session(s) were NOT exported because they are encrypted and machine-bound.`, '']
            : []),
          'This file contains login secrets for the exported Claude Code accounts. Keep it private.',
          'Copy it to another PC and press "i" (Import) to restore those portable credentials.',
        ],
        'success',
        exportDir(),
      );
    } catch (e) {
      showMessage('Export failed', [redactText(e)], 'error');
    }
  }, [store, showMessage]);

  // ---------- input handling ----------
  useInput((input, key) => {
    if (mode === 'list') {
      if (key.leftArrow) {
        setProvider(switchProviderTab({ provider, cursors: { claude: cursor, codex: codexCursor } }, 'left').provider);
        setStatus('Claude accounts');
        return;
      }
      if (key.rightArrow) {
        setProvider(switchProviderTab({ provider, cursors: { claude: cursor, codex: codexCursor } }, 'right').provider);
        setStatus('Codex accounts');
        return;
      }
      if (busy && key.escape && bulkRefreshAbortRef.current) {
        const controller = bulkRefreshAbortRef.current;
        if (!controller.signal.aborted) {
          controller.abort();
          setStatus('Cancelling quota refresh after the current account…');
        }
        return;
      }
      const navigationOnly = key.upArrow || key.downArrow || key.pageUp || key.pageDown
        || input === 'j' || input === 'k' || input === 'g' || input === 'G' || input === 'l' || input === '/'
        || input === '?';
      if (busy && !navigationOnly) {
        setStatus(`${busy} Wait for the current transaction to finish; navigation remains available.`);
        return;
      }
      if (input === '?') {
        setHelpPage(0);
        setMode('help');
        return;
      }
      if (input === '/') {
        setBuffer(lastSearch);
        setMode('search');
        return;
      }
      if (provider === 'codex') {
        if (key.upArrow || input === 'k') {
          setCodexCursor((c) => moveCursor(codexProfiles.length, c, 'prev', listCapacity));
        } else if (key.downArrow || input === 'j') {
          setCodexCursor((c) => moveCursor(codexProfiles.length, c, 'next', listCapacity));
        } else if (key.pageUp) {
          setCodexCursor((c) => moveCursor(codexProfiles.length, c, 'pagePrev', listCapacity));
        } else if (key.pageDown) {
          setCodexCursor((c) => moveCursor(codexProfiles.length, c, 'pageNext', listCapacity));
        } else if (input === 'g') {
          setCodexCursor((c) => moveCursor(codexProfiles.length, c, 'first', listCapacity));
        } else if (input === 'G') {
          setCodexCursor((c) => moveCursor(codexProfiles.length, c, 'last', listCapacity));
        } else if (key.return && codexSelected) beginCodexSwitch(codexSelected);
        else if (input === 'a') void startCodexAdd();
        else if (input === 'i') openImportMenu();
        else if (input === 'I') {
          setBuffer('');
          setMode('importPath');
        } else if (input === 'e') exportSelectedCodex();
        else if (input === 'E') exportAllCodex();
        else if (input === 'r' && codexSelected) {
          setBuffer(codexSelected.label);
          setMode('codexRename');
        } else if (input === 'd' && codexSelected) {
          if (codexSelected.id === codexStore.activeProfileId) setStatus('Cannot delete the active Codex account. Switch away first.');
          else setMode('codexConfirmDelete');
        } else if (input === 'z') {
          void restoreCodexRecovery();
        } else if (input === 'l') {
          const target = leastLoadedCodex(codexProfiles);
          if (!target) setStatus('No Codex usage data yet. Press "u" to refresh.');
          else {
            setCodexCursor(codexProfiles.findIndex((p) => p.id === target.id));
            setStatus(`Most Codex headroom: ${target.label}.`);
          }
        } else if (input === 'b') void chooseBestCodexNow();
        else if (input === 'u') void refreshCodexUsage();
        else if (input === 'S') openSetup();
        else if (input === 'q' || key.escape) exit();
        return;
      }
      if (key.upArrow || input === 'k') setCursor((c) => moveCursor(profiles.length, c, 'prev', listCapacity));
      else if (key.downArrow || input === 'j') setCursor((c) => moveCursor(profiles.length, c, 'next', listCapacity));
      else if (key.pageUp) setCursor((c) => moveCursor(profiles.length, c, 'pagePrev', listCapacity));
      else if (key.pageDown) setCursor((c) => moveCursor(profiles.length, c, 'pageNext', listCapacity));
      else if (input === 'g') setCursor((c) => moveCursor(profiles.length, c, 'first', listCapacity));
      else if (input === 'G') setCursor((c) => moveCursor(profiles.length, c, 'last', listCapacity));
      else if (key.return) {
        if (selected) beginSwitch(selected);
      } else if (input === 'a') void startAdd(selected?.needsReauth ? selected.email : undefined);
      else if (input === 'A') startCaptureDesktop();
      else if (input === 'i') openImportMenu();
      else if (input === 'I') {
        setBuffer('');
        setMode('importPath');
      }
      else if (input === 'e') exportSelected();
      else if (input === 'E') exportAllAccounts();
      else if (input === 'r') {
        if (selected) {
          setBuffer(selected.label);
          setMode('rename');
        }
      } else if (input === 'd') {
        if (!selected) return;
        if (selected.id === store.activeProfileId) {
          setStatus('Cannot delete the active account. Switch away first.');
        } else {
          setMode('confirmDelete');
        }
      } else if (input === 'z') {
        let restored: Profile | undefined;
        const next = mutateStore((fresh) => { restored = restoreLatestDeletedProfile(fresh); });
        storeRef.current = next;
        setStore(next);
        if (restored) {
          setCursor(next.profiles.findIndex((profile) => profile.id === restored!.id));
          setStatus(`Restored archived profile "${restored.label}".`);
        } else setStatus('No archived Claude profile to restore.');
      } else if (input === 'l') {
        const target = leastLoaded(store.profiles);
        if (target) {
          setCursor(store.profiles.findIndex((p) => p.id === target.id));
          setStatus(`Least-loaded: ${target.label}. Press Enter to switch.`);
        } else {
          setStatus('No usage data yet. Press "u" to refresh usage first.');
        }
      } else if (input === 'b') {
        void chooseBestClaudeNow();
      } else if (input === 'u') void refreshAllUsage();
      else if (input === 'S') openSetup();
      else if (input === 'q' || key.escape) exit();
      return;
    }

    if (mode === 'help') {
      const pageCount = commandHelpPages(provider).length;
      const directPage = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
      if (directPage >= 0 && directPage < pageCount) {
        setHelpPage(directPage);
      } else if (input === 'g') {
        setHelpPage(0);
      } else if (input === 'G') {
        setHelpPage(pageCount - 1);
      } else if (key.leftArrow || key.upArrow || key.pageUp || input === 'k') {
        setHelpPage((page) => (page - 1 + pageCount) % pageCount);
      } else if (key.rightArrow || key.downArrow || key.pageDown || input === 'j') {
        setHelpPage((page) => (page + 1) % pageCount);
      } else if (key.return || key.escape || input === '?' || input === 'q') {
        setMode('list');
      }
      return;
    }

    if (mode === 'search') {
      if (key.escape) {
        setBuffer('');
        setMode('list');
      } else if (key.return) {
        const query = buffer.trim().toLowerCase();
        if (query) setLastSearch(buffer.trim());
        const collection = provider === 'claude' ? profiles : codexProfiles;
        const current = provider === 'claude' ? cursor : codexCursor;
        const matchAt = query
          ? Array.from({ length: collection.length }, (_, offset) => (current + 1 + offset) % collection.length)
            .find((index) => {
              const profile = collection[index];
              const plan = profile.provider === 'claude' ? profile.subscriptionType : profile.planType;
              return [profile.label, profile.email, plan ?? '']
                .some((value) => value.toLowerCase().includes(query));
            })
          : undefined;
        if (matchAt === undefined) setStatus(query ? `No ${providerName} account matches "${buffer.trim()}".` : 'Search cancelled.');
        else {
          if (provider === 'claude') setCursor(matchAt);
          else setCodexCursor(matchAt);
          setStatus(`Found ${collection[matchAt].label}. Press / and Enter again to find the next match.`);
        }
        setBuffer('');
        setMode('list');
      } else if (key.backspace || key.delete) {
        setBuffer((value) => value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((value) => value + input.replace(/[\r\n]/g, ''));
      }
      return;
    }

    if (mode === 'setup') {
      if (busy) return;
      if (input === 'i') runInstall();
      else if (input === 'x') runUninstall();
      else if (input === 'q' || key.escape || key.return) {
        setSetupReport(null);
        setMode('list');
      }
      return;
    }

    if (mode === 'codexAdding') {
      if (key.escape) {
        codexAddAbortRef.current?.abort();
        setBuffer('');
        setBusy('Cancelling Codex login…');
      } else if (key.return) {
        void submitCodexCallbackUrl();
      } else if (!codexCallbackBusy && (key.backspace || key.delete)) {
        setBuffer((value) => value.slice(0, -1));
      } else if (!codexCallbackBusy && input && !key.ctrl && !key.meta) {
        setBuffer((value) => (value + input).replace(/[\r\n]/g, ''));
      }
      return;
    }

    if (mode === 'codexConfirmSwitch') {
      if ((input === 'y' || key.return) && pendingCodexSwitch) void doCodexSwitch(pendingCodexSwitch);
      else if (input === 'n' || key.escape) {
        setPendingCodexSwitch(null);
        setMode('list');
      }
      return;
    }

    if (mode === 'codexConfirmDelete') {
      if (input === 'y' && codexSelected) {
        const label = codexSelected.label;
        const profileId = codexSelected.id;
        void (async () => {
          try {
            setCodexStore(await archiveCodexProfile(profileId));
            setCodexCursor((c) => Math.max(0, Math.min(c, codexProfiles.length - 2)));
            setStatus(`Archived Codex profile "${label}". Press z to restore it.`);
          } catch (error) {
            setStatus(`Codex archive failed: ${redactText(error)}`);
          }
        })();
        setMode('list');
      } else if (input === 'n' || key.escape) setMode('list');
      return;
    }

    if (mode === 'codexRename') {
      if (key.return) {
        if (codexSelected && buffer.trim()) setCodexStore(renameCodexProfile(codexSelected.id, buffer.trim()));
        setMode('list');
      } else if (key.escape) setMode('list');
      else if (key.backspace || key.delete) setBuffer((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuffer((value) => value + input);
      return;
    }

    if (mode === 'confirmSwitch') {
      if (input === 'y' || key.return) {
        if (pendingSwitch) void doSwitch(pendingSwitch.profile);
      } else if (input === 'n' || key.escape) {
        setPendingSwitch(null);
        setMode('list');
      }
      return;
    }

    if (mode === 'confirmDelete') {
      if (input === 'y') {
        if (selected) {
          const label = selected.label;
          try {
            const next = archiveClaudeProfile(selected.id);
            storeRef.current = next;
            setStore(next);
            setCursor((c) => Math.max(0, Math.min(c, next.profiles.length - 1)));
            setStatus(`Archived "${label}". Press z to restore it.`);
          } catch (error) {
            setStatus(`Archive failed: ${redactText(error)}`);
          }
        }
        setMode('list');
      } else if (input === 'n' || key.escape) {
        setMode('list');
      }
      return;
    }

    if (mode === 'rename') {
      if (key.return) {
        if (selected && buffer.trim()) {
          const next = mutateStore((fresh) => {
            const profile = fresh.profiles.find((candidate) => candidate.id === selected.id);
            if (profile) {
              profile.label = buffer.trim();
              profile.updatedAt = Date.now();
            }
          });
          storeRef.current = next;
          setStore(next);
          setStatus('Renamed.');
        }
        setMode('list');
      } else if (key.escape) {
        setMode('list');
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
      return;
    }

    if (mode === 'importMenu') {
      const total = importItems.length;
      if (key.upArrow) setImportCursor((c) => (c > 0 ? c - 1 : Math.max(0, total - 1)));
      else if (key.downArrow) setImportCursor((c) => (c < total - 1 ? c + 1 : 0));
      else if (key.return) {
        if (importItems[importCursor]) void doImportItem(importItems[importCursor]);
      } else if (input === 'o') {
        openFolder(providerImportDir(provider));
      } else if (input === 'p') {
        setBuffer('');
        setMode('importPath');
      } else if (input === 'r') {
        openImportMenu();
      } else if (key.escape || input === 'q') {
        setMode('list');
      }
      return;
    }

    if (mode === 'importPath') {
      if (key.return) {
        void doImportPath(buffer);
      } else if (key.escape) {
        setMode('importMenu');
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
      return;
    }

    if (mode === 'adding') {
      if (claudeAddSubmissionRef.current || addBusy) {
        if (key.escape) {
          setAddLines([
            'The authorization exchange was already submitted.',
            'This one-shot request cannot be cancelled safely; waiting for its result…',
          ]);
        }
        return;
      }
      if (key.escape) {
        authRef.current = null;
        setBuffer('');
        setMode('list');
        setStatus('Claude authorization cancelled. No account was changed.');
      } else if (key.return) {
        void submitAddCode();
      } else if (key.backspace || key.delete) {
        setBuffer((value) => value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((value) => (value + input).replace(/[\r\n]/g, ''));
      }
      return;
    }

    if (mode === 'capturingDesktopConfirm') {
      if (key.escape) {
        setMode('list');
        setStatus('Desktop capture cancelled.');
      } else if (key.return) {
        setBuffer('');
        setMode('capturingDesktopLabel');
      }
      return;
    }

    if (mode === 'capturingDesktopLabel') {
      if (key.escape) {
        setMode('list');
        setStatus('Desktop capture cancelled.');
      } else if (key.return) {
        desktopLabelRef.current = buffer.trim();
        setBuffer('');
        setMode('capturingDesktopEmail');
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
      return;
    }

    if (mode === 'capturingDesktopEmail') {
      if (desktopBusy) return;
      if (key.escape) {
        setMode('list');
        setStatus('Desktop capture cancelled.');
      } else if (key.return) {
        void finalizeDesktopCapture(buffer.trim());
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
      return;
    }

    if (mode === 'message') {
      if (input === 'o' && message?.openFolder) {
        openFolder(message.openFolder);
      } else if (key.return || key.escape || input === 'q') {
        setMessage(null);
        setMode('list');
      }
      return;
    }
  });

  // ---------- rendering ----------
  const tone = message?.tone === 'success' ? 'green' : message?.tone === 'error' ? 'red' : 'cyan';
  const W = Math.max(16, Math.min(cols - 1, 150));
  const compactHero = W < 80 || rows < 24;
  const ultraCompactTable = W < 52;
  const compactTable = W < 96;
  const leftW = Math.min(30, Math.max(22, Math.floor((W - 4) * 0.29)));
  const activeGlyph = motionFrame % 4 === 2 ? '◉' : '●';
  const cursorGlyph = motionFrame % 2 === 0 ? '❯ ' : '› ';
  const claudeBest = bestNow(profiles, store.activeProfileId);
  const codexBest = bestNowCodex(codexProfiles, codexStore.activeProfileId);
  const codexSelectedQuota = codexSelected ? effectiveCodexQuota(codexSelected) : null;
  const freshCodexQuotaProfiles = codexProfiles.filter((profile) =>
    profile.usage?.status === 'ok' && Date.now() - profile.usage.fetchedAt <= 10 * 60_000);
  const codexQuotaEvidence = freshCodexQuotaProfiles.length ? freshCodexQuotaProfiles : codexProfiles;
  const codexQuotaColumnEvidence = (['primary', 'secondary'] as const).flatMap((key) => {
    const visibleWindows = codexQuotaEvidence
      .map((profile) => effectiveCodexQuota(profile)[key])
      .filter((candidate) => candidate !== null);
    if (!visibleWindows.length) return [];
    const durationWindows = codexProfiles
      .map((profile) => effectiveCodexQuota(profile)[key])
      .filter((candidate) => candidate !== null);
    return [{
      key,
      durations: (durationWindows.length ? durationWindows : visibleWindows)
        .map((window) => window.windowDurationMins),
    }];
  });
  const codexQuotaColumns = codexQuotaColumnEvidence.map((column, index, columns) => ({
    ...column,
    ...quotaColumnPresentation(column.durations, index, columns.length),
  }));
  const claudeTableLayout = accountTableLayout(W, profiles.length, 2);
  const codexTableLayout = accountTableLayout(W, codexProfiles.length, codexQuotaColumns.length);
  const headerPrefix = (layout: ReturnType<typeof accountTableLayout>) => layout.showIndex
    ? `${'  '}${pad('#', layout.indexWidth + 1)}${'  '}`
    : '    ';
  const claudeHeaderPrefix = headerPrefix(claudeTableLayout);
  const codexHeaderPrefix = headerPrefix(codexTableLayout);
  const codexBestQuota = codexBest.target ? effectiveCodexQuota(codexBest.target) : null;
  const codexBestLabels = {
    primary: codexBestQuota?.primary
      ? formatQuotaWindowLabel(codexBestQuota.primary.windowDurationMins).toLowerCase()
      : 'primary',
    secondary: codexBestQuota?.secondary
      ? formatQuotaWindowLabel(codexBestQuota.secondary.windowDurationMins).toLowerCase()
      : 'secondary',
  };
  const providerColor = provider === 'claude' ? CLAUDE_ORANGE : CODEX_BLUE;
  const providerName = provider === 'claude' ? 'Claude' : 'Codex';
  const helpPages = commandHelpPages(provider);
  const visibleHelpPage = helpPages[Math.max(0, Math.min(helpPage, helpPages.length - 1))];
  const visibleHelpEntries = visibleHelpPage?.sections.flatMap((section) => section.entries) ?? [];
  const longestHelpKey = visibleHelpEntries.reduce((length, entry) => Math.max(length, entry.key.length), 0);
  const compactHelp = rows < 24;
  const stackedHelpRows = W < 76;
  const helpKeyWidth = stackedHelpRows
    ? Math.max(12, W - 4)
    : Math.max(14, Math.min(36, longestHelpKey + 2, Math.floor(W * 0.42)));
  const importViewport = viewportFor(importItems.length, importCursor, Math.max(2, Math.min(8, rows - 16)));

  return (
    <Box flexDirection="column">
      <Box width={W} justifyContent="center">
        {mode === 'help' ? (
          <Text dimColor>← previous help page  ·  next help page →</Text>
        ) : (
          <>
            <Text dimColor={provider !== 'claude'} color={provider === 'claude' ? CLAUDE_ORANGE : undefined}>← Claude</Text>
            <Text dimColor>  │  </Text>
            <Text dimColor={provider !== 'codex'} color={provider === 'codex' ? CODEX_BLUE : undefined}>Codex →</Text>
          </>
        )}
      </Box>
      {mode === 'list' ? (provider === 'claude' ? (
        <Box width={W} borderStyle="round" borderColor={CLAUDE_ORANGE} paddingX={1} flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold><Text color={CLAUDE_ORANGE}>Claude</Text> Account Switch <Text dimColor>v{APP_VERSION}</Text></Text>
            <Text dimColor>{profiles.length} accounts · AGPL</Text>
          </Box>
          {newVersion ? <Text color="yellow">Update available: v{newVersion}</Text> : null}
          {compactHero ? (
            <Box marginTop={1} flexDirection="column">
              <Text wrap="truncate-end"><Text dimColor>active  </Text>{active ? <><Text color="green">{activeGlyph} </Text><Text bold>{accountListLabel(active.label, active.email, !!active.importedSession)}</Text>{' '}<Text color={planColor(active.subscriptionType)}>{formatPlanLabel(active.subscriptionType)}</Text></> : <Text dimColor>none</Text>}</Text>
              {selected ? <Text><Text dimColor>quota   </Text><Text color={utilColor(selected.usage?.five_hour?.utilization ?? null)}>5h {fmtPct(selected.usage?.five_hour?.utilization)}</Text><Text dimColor> · </Text><Text color={utilColor(selected.usage?.seven_day?.utilization ?? null)}>7d {fmtPct(selected.usage?.seven_day?.utilization)}</Text>{selected.usage?.status === 'stale' ? <Text dimColor> · cached</Text> : null}</Text> : null}
              {claudeBest.target ? <Text><Text dimColor>best    </Text><Text color={claudeBest.confidence === 'high' ? 'green' : 'yellow'}>{claudeBest.target.label}</Text><Text dimColor> · {bestNowDetail(claudeBest)}</Text></Text> : null}
            </Box>
          ) : (
            <Box marginTop={1} width={W - 2}>
              <Box width={leftW} flexDirection="column" alignItems="center">
                <ClaudePulseMark frame={motionFrame} />
                {active ? (
                  <Box marginTop={1} flexDirection="column" alignItems="center" width={leftW - 2}>
                    <Text wrap="truncate-end"><Text color="green">{activeGlyph} </Text><Text bold>{accountListLabel(active.label, active.email, !!active.importedSession)}</Text></Text>
                    <Text color={planColor(active.subscriptionType)}>CLAUDE {formatPlanLabel(active.subscriptionType)}</Text>
                  </Box>
                ) : <Text dimColor>No active account</Text>}
              </Box>
              <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" borderTop={false} borderRight={false} borderBottom={false} paddingLeft={2}>
                <Text bold color="white">SELECTED ACCOUNT</Text>
                {selected ? (
                  <Box flexDirection="column">
                    <Text wrap="truncate-end"><Text color={selected.id === store.activeProfileId ? 'green' : 'cyanBright'}>{selected.id === store.activeProfileId ? activeGlyph : '○'} </Text><Text bold>{accountListLabel(selected.label, selected.email, !!selected.importedSession)}</Text>{'  '}<Text color={planColor(selected.subscriptionType)}>{formatPlanLabel(selected.subscriptionType)}</Text></Text>
                    <Text dimColor>{accountSecondaryIdentity(selected.label, selected.email) ? `${accountSecondaryIdentity(selected.label, selected.email)} · ` : ''}{selected.id === store.activeProfileId ? 'active' : 'ready to switch'}{selected.planObservedAt ? ` · plan checked ${relMs(selected.planObservedAt)} via ${selected.planSource === 'claude-auth-status' ? 'official CLI' : selected.planSource === 'claude-profile' ? 'provider profile' : 'saved OAuth'}` : ''}</Text>
                    {selected.importedSession ? <Text dimColor>⧉ imported session · another active PC can make token renewal less reliable</Text> : null}
                    {hasCliAuth(selected) && selected.usage && (selected.usage.status === 'ok' || selected.usage.status === 'stale') ? (
                      <>
                        <HeroQuotaLine label="5h" usedPercent={selected.usage.five_hour?.utilization} reset={quotaResetLabel(selected.usage.five_hour?.utilization, selected.usage.five_hour?.resets_at)} />
                        <HeroQuotaLine label="7d" usedPercent={selected.usage.seven_day?.utilization} reset={quotaResetLabel(selected.usage.seven_day?.utilization, selected.usage.seven_day?.resets_at)} />
                        {selected.usage.status === 'stale' ? <Text dimColor>cached · live refresh unavailable</Text> : null}
                      </>
                    ) : selected.needsReauth ? <Text color="red">⚠ Login renewal required — press a to re-add</Text> : !hasCliAuth(selected) ? <Text dimColor>Desktop-only · quota unavailable</Text> : <Text dimColor>Press u to load quota</Text>}
                    {asTime(selected.claudeAiOauth?.refreshTokenExpiresAt) ? <Text dimColor>login renewal {relMs(asTime(selected.claudeAiOauth?.refreshTokenExpiresAt))}</Text> : null}
                  </Box>
                ) : <Text dimColor>No account selected</Text>}
                {claudeBest.target ? <Text><Text dimColor>best now  </Text><Text color={claudeBest.confidence === 'high' ? 'green' : 'yellow'}>{claudeBest.target.label}</Text><Text dimColor> · {bestNowDetail(claudeBest)}</Text></Text> : null}
              </Box>
            </Box>
          )}
        </Box>
      ) : (
        <Box width={W} borderStyle="round" borderColor={CODEX_BLUE} paddingX={1} flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold><Text color={CODEX_BLUE}>Codex</Text> Account Switch <Text dimColor>v{APP_VERSION}</Text></Text>
            <Text dimColor>{codexProfiles.length} accounts · AGPL</Text>
          </Box>
          {newVersion ? <Text color="yellow">Update available: v{newVersion}</Text> : null}
          {compactHero ? (
            <Box marginTop={1} flexDirection="column">
              <Text wrap="truncate-end"><Text dimColor>active  </Text>{codexActive ? <><Text color="green">{activeGlyph} </Text><Text bold>{accountListLabel(codexActive.label, codexActive.email, !!codexActive.importedSession)}</Text>{' '}<Text color={planColor(codexActive.planType)}>{formatPlanLabel(codexActive.planType)}</Text></> : <Text dimColor>none</Text>}</Text>
              {codexSelected ? <Text><Text dimColor>quota   </Text>{codexQuotaColumns.length ? codexQuotaColumns.map((column, index) => {
                const window = codexSelectedQuota?.[column.key] ?? null;
                const label = window ? formatQuotaWindowLabel(window.windowDurationMins).toLowerCase() : column.compactLabel.toLowerCase();
                return <Text key={column.key}>{index ? <Text dimColor> · </Text> : null}<Text color={utilColor(window?.usedPercent ?? null)}>{label} {fmtPct(window?.usedPercent)}</Text></Text>;
              }) : <Text dimColor>no rolling window returned</Text>}{codexSelected.usage?.status === 'stale' ? <Text dimColor> · cached</Text> : null}</Text> : null}
              {codexBest.target ? <Text><Text dimColor>best    </Text><Text color={codexBest.confidence === 'high' ? 'green' : 'yellow'}>{codexBest.target.label}</Text><Text dimColor> · {bestNowDetail(codexBest, codexBestLabels)}</Text></Text> : null}
            </Box>
          ) : (
            <Box marginTop={1} width={W - 2}>
              <Box width={leftW} flexDirection="column" alignItems="center">
                <CodexBotMark frame={motionFrame} />
                {codexActive ? (
                  <Box marginTop={1} flexDirection="column" alignItems="center" width={leftW - 2}>
                    <Text wrap="truncate-end"><Text color="green">{activeGlyph} </Text><Text bold>{accountListLabel(codexActive.label, codexActive.email, !!codexActive.importedSession)}</Text></Text>
                    <Text color={planColor(codexActive.planType)}>CODEX {formatPlanLabel(codexActive.planType)}</Text>
                  </Box>
                ) : <Text dimColor>No active account</Text>}
              </Box>
              <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" borderTop={false} borderRight={false} borderBottom={false} paddingLeft={2}>
                <Text bold color="white">SELECTED ACCOUNT</Text>
                {codexSelected ? (
                  <Box flexDirection="column">
                    <Text wrap="truncate-end"><Text color={codexSelected.id === codexStore.activeProfileId ? 'green' : 'cyanBright'}>{codexSelected.id === codexStore.activeProfileId ? activeGlyph : '○'} </Text><Text bold>{accountListLabel(codexSelected.label, codexSelected.email, !!codexSelected.importedSession)}</Text>{'  '}<Text color={planColor(codexSelected.planType)}>{formatPlanLabel(codexSelected.planType)}</Text></Text>
                    <Text dimColor>{accountSecondaryIdentity(codexSelected.label, codexSelected.email) ? `${accountSecondaryIdentity(codexSelected.label, codexSelected.email)} · ` : ''}{codexSelected.id === codexStore.activeProfileId ? 'active' : 'ready to switch'}{codexSelected.planObservedAt ? ` · plan checked ${relMs(codexSelected.planObservedAt)} via ${codexSelected.planSource === 'codex-rate-limits' ? 'quota entitlement' : codexSelected.planSource === 'codex-account' ? 'account service' : 'saved OAuth'}` : ''}</Text>
                    {codexSelected.importedSession ? <Text dimColor>⧉ imported session · another active PC can make token renewal less reliable</Text> : null}
                    {codexQuotaColumns.some((column) => codexSelectedQuota?.[column.key]) ? (
                      <>
                        {codexQuotaColumns.map((column) => {
                          const window = codexSelectedQuota?.[column.key] ?? null;
                          return window ? <HeroQuotaLine key={column.key} label={formatQuotaWindowLabel(window.windowDurationMins).toLowerCase()} usedPercent={window.usedPercent} reset={quotaResetLabel(window.usedPercent, window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null)} /> : null;
                        })}
                        {codexSelected.usage?.status === 'stale' ? <Text dimColor>cached · live refresh unavailable</Text> : null}
                      </>
                    ) : codexSelected.needsReauth ? <Text color="red">⚠ Login renewal required — press a to re-add</Text> : codexSelected.usage?.status === 'ok' ? <Text dimColor>Provider currently returned no rolling quota window</Text> : <Text dimColor>Press u to load quota</Text>}
                  </Box>
                ) : <Text dimColor>No account selected</Text>}
                {codexBest.target ? <Text><Text dimColor>best now  </Text><Text color={codexBest.confidence === 'high' ? 'green' : 'yellow'}>{codexBest.target.label}</Text><Text dimColor> · {bestNowDetail(codexBest, codexBestLabels)}</Text></Text> : null}
              </Box>
            </Box>
          )}
        </Box>
      )) : (
        <Box flexDirection="column">
          <Box width={W} justifyContent="space-between">
            <Text bold>
              <Text color={providerColor}>{providerName}</Text> <Text color="white">Account Switch</Text>
            </Text>
            {provider === 'claude' && active ? <Text dimColor>active: {active.label}</Text> : null}
            {provider === 'codex' && codexActive ? <Text dimColor>active: {codexActive.label}</Text> : null}
          </Box>
          <Divider width={W} color="gray" />
        </Box>
      )}

      {mode === 'help' && visibleHelpPage ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={providerColor} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={providerColor}>COMPLETE HELP · {providerName.toUpperCase()}</Text>
            <Text dimColor>{helpPage + 1}/{helpPages.length} · {visibleHelpPage.title}</Text>
          </Box>
          {!compactHelp ? <Text dimColor wrap="wrap">Every public TUI and CLI action is listed. Contextual keys say where they work.</Text> : null}
          <Box flexWrap="wrap">
            <Text dimColor>Pages  </Text>
            {helpPages.map((page, index) => (
              <Text key={page.shortTitle} color={index === helpPage ? providerColor : undefined} dimColor={index !== helpPage}>
                {index ? ' · ' : ''}{index + 1} {page.shortTitle}
              </Text>
            ))}
          </Box>
          <Box marginTop={compactHelp ? 0 : 1} flexDirection="column">
            {visibleHelpPage.sections.map((section) => (
              <Box key={section.title} flexDirection="column" marginBottom={compactHelp ? 0 : 1}>
                <Text bold color={providerColor}>{section.title}</Text>
                {section.entries.map((entry) => (
                  <Box key={entry.id} flexDirection={stackedHelpRows ? 'column' : 'row'} marginBottom={stackedHelpRows ? 1 : 0}>
                    <Box width={helpKeyWidth}><Text bold color="white">{entry.key}</Text></Box>
                    <Text wrap="wrap">{entry.description}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
          <Text dimColor wrap="wrap">Arrows/PgUp/PgDn/j/k pages · 1-9 jump · g/G ends · Enter/Esc/?/q back</Text>
        </Box>
      ) : mode === 'message' && message ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
          <Text bold color={tone}>
            {message.tone === 'success' ? '✓ ' : message.tone === 'error' ? '✗ ' : ''}
            {message.title}
          </Text>
          {message.lines.map((l, i) => (
            <Text key={i} wrap="wrap">{l}</Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>[Enter] back{message.openFolder ? ' · [o] open folder' : ''}</Text>
          </Box>
        </Box>
      ) : mode === 'setup' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={CLAUDE_ORANGE} paddingX={1}>
          <Text bold color={CLAUDE_ORANGE}>
            Set up {APP_NAME}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text wrap="wrap">
              Make this feel like a real app and keep saved accounts refreshed safely:
            </Text>
            <Text>
              {'  • '}A <Text bold>Desktop + menu shortcut</Text> to launch the switcher.
            </Text>
            <Text>
              {'  • '}An explicit, backed-up <Text bold>Codex auth.json credential store</Text> when Codex accounts exist.
            </Text>
            <Text>
              {'  • '}An <Text bold>automatic keep-alive</Text> (every 6h) to refresh tokens before access expiry —
            </Text>
            <Text>{'    '}and warn when either provider requires a real login renewal.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {(() => {
              const st = installState();
              return (
                <Text dimColor>
                  Current: shortcuts {st.shortcuts ? '✓' : '—'} · auto keep-alive {st.scheduler ? '✓' : '—'}
                </Text>
              );
            })()}
          </Box>
          {setupReport ? (
            <Box marginTop={1} flexDirection="column">
              {setupReport.steps.map((s, i) => (
                <Text key={i} color={s.ok ? 'green' : 'red'}>
                  {s.ok ? '✓' : '✗'} {s.name}
                  {s.detail ? <Text dimColor> — {s.detail}</Text> : null}
                </Text>
              ))}
            </Box>
          ) : null}
          <Box marginTop={1}>
            {busy ? (
              <Spinner label={busy} />
            ) : (
              <Text dimColor>
                <Text color="green">[i]</Text> install ·{' '}
                <Text color="yellow">[x]</Text> uninstall ·{' '}
                <Text color="cyan">[Esc]</Text> {setupReport ? 'close' : 'skip'}
              </Text>
            )}
          </Box>
        </Box>
      ) : mode === 'codexAdding' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={CODEX_BLUE} paddingX={1}>
          <Text bold color={CODEX_BLUE}>Add Codex account</Text>
          {codexAddLines.map((line, i) => <Text key={i} wrap="wrap">{line}</Text>)}
          <Box marginTop={1} flexDirection="column">
            <Text>
              Callback: <Text color="blueBright">{buffer ? `<pasted ${buffer.length} characters>` : '(paste the final localhost URL here)'}</Text>
            </Text>
            {busy ? <Spinner label={codexCallbackBusy ? 'Submitting localhost callback…' : busy} color={CODEX_BLUE} /> : null}
            <Text dimColor>Enter submits the callback · Esc cancels</Text>
          </Box>
        </Box>
      ) : mode === 'adding' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={CLAUDE_ORANGE} paddingX={1}>
          <Text bold color="cyanBright">
            Add account
          </Text>
          {addLines.map((l, i) => (
            <Text key={i} wrap="wrap">
              {l}
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text>
              Code: <Text color="green">{buffer ? `<pasted ${buffer.length} characters>` : '(paste authorization code here)'}</Text>
            </Text>
            {addBusy ? <Spinner label="Validating Claude authorization…" /> : null}
            <Text dimColor>
              {addBusy
                ? 'Authorization submitted · waiting for a durable result (Esc cannot cancel now)'
                : 'Enter validates the code · Esc cancels before submission'}
            </Text>
          </Box>
        </Box>
      ) : mode === 'capturingDesktopConfirm' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={CLAUDE_ORANGE} paddingX={1}>
          <Text bold color="cyanBright">
            Add a Claude Desktop account (capture)
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text wrap="wrap">
              Desktop's login can't be done remotely (no code to paste) — it must happen once, right here on this machine:
            </Text>
            <Text>
              {'  1. '}Open Claude Desktop and log in with the account you want to add.
            </Text>
            <Text>
              {'  2. '}Once connected, <Text bold>fully close Claude Desktop</Text> (quit it — check the tray too).
            </Text>
            <Text>{'  3. '}Come back here and press Enter. We'll save this session as a new account.</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Not portable to another PC (session is tied to this machine).</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter when Desktop is closed and ready · Esc to cancel</Text>
          </Box>
        </Box>
      ) : mode === 'capturingDesktopLabel' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">
            Label for this account
          </Text>
          <Text>
            Label: <Text color="green">{buffer}</Text>
            <Text>▎</Text>
          </Text>
          <Box marginTop={1}>
            <Text dimColor>Enter to continue · Esc to cancel</Text>
          </Box>
        </Box>
      ) : mode === 'capturingDesktopEmail' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">
            Email for this account (used to link with a CLI profile, optional)
          </Text>
          <Text>
            Email: <Text color="green">{buffer}</Text>
            <Text>▎</Text>
          </Text>
          <Box marginTop={1}>
            {desktopBusy ? <Spinner label="Capturing Desktop session…" /> : <Text dimColor>Enter to save · Esc to cancel</Text>}
          </Box>
        </Box>
      ) : mode === 'importMenu' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={providerColor} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={providerColor}>IMPORT · {providerName.toUpperCase()}</Text>
            <Text dimColor>{importItems.length} source{importItems.length === 1 ? '' : 's'} ready</Text>
          </Box>
          <Text dimColor wrap="wrap">
            {provider === 'claude'
              ? '.credentials.json is enough by itself · .claude.json is optional identity metadata · *.ccswitch.json is the preferred portable format'
              : 'auth.json requires Codex file-backed credential storage · *.codexswitch.json is the preferred portable format'}
          </Text>
          <Text dimColor wrap="wrap">⧉ marks an imported session; another active PC can make token renewal less reliable.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text><Text color={providerColor}>INBOX</Text> · copy/drop files here, then press r:</Text>
            <Text color="green" wrap="wrap">{providerImportDir(provider)}</Text>
            <Text dimColor wrap="wrap">After every represented account commits, inbox files move to processed evidence with a receipt. External paths are never moved.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>DETECTED</Text>
            {importItems.length === 0 ? (
              <Text dimColor>(none · press o to open the inbox, add a file, then press r)</Text>
            ) : (
              importItems.slice(importViewport.start, importViewport.end).map((item, offset) => {
                const index = importViewport.start + offset;
                return (
                  <Text key={item.key} wrap="truncate-end" color={index === importCursor ? 'white' : undefined} backgroundColor={index === importCursor ? '#1A1A1D' : undefined}>
                    <Text bold color={providerColor}>{index === importCursor ? '❯ ' : '  '}</Text>
                    <Text bold={index === importCursor}>{item.title}</Text>
                    <Text dimColor> · {item.detail}</Text>
                  </Text>
                );
              })
            )}
            {importItems.length > importViewport.end ? <Text dimColor>showing {importViewport.start + 1}–{importViewport.end} of {importItems.length}</Text> : null}
          </Box>
          <Box marginTop={1}><Text dimColor>↑/↓ select · Enter import whole source · o open inbox · r rescan · p paste/drag path · Esc back</Text></Box>
        </Box>
      ) : mode === 'importing' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={providerColor} paddingX={1}>
          <Spinner label={`Importing ${providerName} credentials safely…`} color={providerColor} />
          <Text dimColor>Validating the complete source before commit; cleanup runs only after success.</Text>
        </Box>
      ) : mode === 'importPath' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={providerColor} paddingX={1}>
          <Text bold color={providerColor}>IMPORT PATH · {providerName.toUpperCase()}</Text>
          <Text wrap="wrap">Path: <Text color="green">{buffer}</Text><Text>▎</Text></Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Type, paste, or drag one file/folder into this terminal.</Text>
            <Text dimColor>Enter imports every valid account · external source stays untouched · Esc returns</Text>
          </Box>
        </Box>
      ) : mode === 'search' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={providerColor} paddingX={1}>
          <Text bold color={providerColor}>Find a {providerName} account</Text>
          <Text>Label, email or plan: <Text color="green">{buffer}</Text><Text>▎</Text></Text>
          <Text dimColor>Enter jumps to the next match · Esc cancels</Text>
        </Box>
      ) : provider === 'codex' ? (
        <Box flexDirection="column" marginTop={1}>
          {codexProfiles.length === 0 ? (
            <Box marginY={1}>
              <Text dimColor>No Codex accounts yet. Press </Text><Text color={CODEX_BLUE}>a</Text><Text dimColor> to add one.</Text>
            </Box>
          ) : (
            <>
              <Text dimColor>
                {compactTable
                  ? ultraCompactTable
                    ? `${codexHeaderPrefix}${pad('ACCOUNT', codexTableLayout.accountWidth)}│ ${pad('PLAN', codexTableLayout.planWidth)}`
                    : `${codexHeaderPrefix}${pad('ACCOUNT', codexTableLayout.accountWidth)}│ ${pad('PLAN', codexTableLayout.planWidth)}${codexQuotaColumns.map((column) => `│ ${pad(column.compactLabel, codexTableLayout.usageWidth)}`).join('')}`
                  : `${codexHeaderPrefix}${pad('ACCOUNT', codexTableLayout.accountWidth)}│ ${pad('PLAN', codexTableLayout.planWidth)}${codexQuotaColumns.map((column) => `│ ${pad(column.longLabel, codexTableLayout.usageWidth)}`).join('')}│ ${pad('STATE', codexTableLayout.stateWidth)}`}
              </Text>
              <Divider width={W} color="#27272A" />
              {codexProfiles.slice(codexViewport.start, codexViewport.end).map((profile, offset) => {
                const i = codexViewport.start + offset;
                const isActive = profile.id === codexStore.activeProfileId;
                const isCursor = i === codexCursor;
                const quota = effectiveCodexQuota(profile);
                return (
                  <Text key={profile.id} backgroundColor={isCursor ? '#1A1A1D' : i % 2 ? '#101010' : undefined}>
                    <Text color={CODEX_BLUE} bold>{isCursor ? cursorGlyph : '  '}</Text>
                    {codexTableLayout.showIndex ? <Text dimColor>{formatAccountOrdinal(i, codexTableLayout.indexWidth)}{' '}</Text> : null}
                    <Text color={profile.needsReauth ? 'red' : isActive ? 'green' : 'gray'}>{profile.needsReauth ? '⚠' : isActive ? activeGlyph : '○'}{' '}</Text>
                    {compactTable ? (
                      <>
                        <Text bold={isCursor} color={profile.needsReauth ? 'red' : isCursor ? 'white' : undefined}>{pad(accountListLabel(profile.label, profile.email, !!profile.importedSession), codexTableLayout.accountWidth)}</Text>
                        <ColumnRule />
                        <Text color={planColor(profile.planType)}>{pad(formatPlanLabel(profile.planType), codexTableLayout.planWidth)}</Text>
                        {!ultraCompactTable ? codexQuotaColumns.map((column) => {
                          const window = quota[column.key];
                          const value = column.mixedDuration && window
                            ? `${formatQuotaWindowLabel(window.windowDurationMins).toLowerCase()} ${fmtPct(window.usedPercent)}`
                            : fmtPct(window?.usedPercent);
                          return <Text key={column.key}><ColumnRule /><Text color={utilColor(window?.usedPercent ?? null)}>{pad(value, codexTableLayout.usageWidth)}</Text></Text>;
                        }) : null}
                      </>
                    ) : (
                      <>
                        <Text bold={isCursor} color={profile.needsReauth ? 'red' : isCursor ? 'white' : undefined}>{pad(accountListLabel(profile.label, profile.email, !!profile.importedSession), codexTableLayout.accountWidth)}</Text>
                        <ColumnRule />
                        <Text color={planColor(profile.planType)}>{pad(formatPlanLabel(profile.planType), codexTableLayout.planWidth)}</Text>
                        {codexQuotaColumns.map((column) => {
                          const window = quota[column.key];
                          return <Text key={column.key}><ColumnRule /><UsageCell
                            win={window ? { utilization: window.usedPercent } : null}
                            windowLabel={column.mixedDuration && window ? formatQuotaWindowLabel(window.windowDurationMins) : null}
                          /></Text>;
                        })}
                        <ColumnRule />
                        {profile.needsReauth ? <Text color="red">{pad('REAUTH', codexTableLayout.stateWidth)}</Text> : isActive ? <Text color="green">{pad('ACTIVE', codexTableLayout.stateWidth)}</Text> : <Text dimColor>{pad(relTime(profile.lastUsedAt), codexTableLayout.stateWidth)}</Text>}
                      </>
                    )}
                  </Text>
                );
              })}
              {codexProfiles.length > listCapacity ? (
                <Text dimColor>showing {codexViewport.start + 1}–{codexViewport.end} of {codexProfiles.length} · PgUp/PgDn · g/G</Text>
              ) : null}
            </>
          )}

          {mode === 'codexConfirmSwitch' && pendingCodexSwitch ? (
            <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold color="yellow">Switch Codex to "{pendingCodexSwitch.label}" ({pendingCodexSwitch.email})?</Text>
              <Text>Codex Desktop and CLI sessions will be closed before the switch.</Text>
              <Text dimColor>Unsaved Codex work can be lost. Claude processes are never force-quit.</Text>
              <Box marginTop={1}><Text color="yellow">[y/Enter]</Text><Text dimColor> confirm · [n/Esc] cancel</Text></Box>
            </Box>
          ) : null}

          {mode === 'codexConfirmDelete' && codexSelected ? (
            <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
              <Text color="red">Archive Codex profile "{codexSelected.label}" ({codexSelected.email})? Credentials are retained. [y] yes · [n] no</Text>
            </Box>
          ) : null}

          {mode === 'codexRename' ? (
            <Box marginTop={1} borderStyle="round" borderColor={CODEX_BLUE} paddingX={1}>
              <Text>Rename Codex profile to: <Text color="green">{buffer}</Text><Text>▎</Text> <Text dimColor>(Enter to save · Esc to cancel)</Text></Text>
            </Box>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {profiles.length === 0 ? (
            <Box marginY={1}>
              <Text dimColor>No accounts yet. Press </Text>
              <Text color="cyanBright">a</Text>
              <Text dimColor> to add one, or </Text>
              <Text color="cyanBright">i</Text>
              <Text dimColor> to import from another PC.</Text>
            </Box>
          ) : (
            <>
              <Text dimColor>
                {compactTable
                  ? ultraCompactTable
                    ? `${claudeHeaderPrefix}${pad('ACCOUNT', claudeTableLayout.accountWidth)}│ ${pad('PLAN', claudeTableLayout.planWidth)}`
                    : `${claudeHeaderPrefix}${pad('ACCOUNT', claudeTableLayout.accountWidth)}│ ${pad('PLAN', claudeTableLayout.planWidth)}│ ${pad('5H', claudeTableLayout.usageWidth)}│ ${pad('7D', claudeTableLayout.usageWidth)}`
                  : `${claudeHeaderPrefix}${pad('ACCOUNT', claudeTableLayout.accountWidth)}│ ${pad('PLAN', claudeTableLayout.planWidth)}│ ${pad('5-HOUR', claudeTableLayout.usageWidth)}│ ${pad('7-DAY', claudeTableLayout.usageWidth)}│ ${pad('STATE', claudeTableLayout.stateWidth)}`}
              </Text>
              <Divider width={W} color="#27272A" />
              {profiles.slice(claudeViewport.start, claudeViewport.end).map((p, offset) => {
                const i = claudeViewport.start + offset;
                const isActive = p.id === store.activeProfileId;
                const isCursor = i === cursor;
                const linked = [hasCliAuth(p) ? 'CLI' : null, p.desktopSnapshotDir ? 'DSK' : null].filter(Boolean).join('+');
                return (
                  <Text key={p.id} backgroundColor={isCursor ? '#1A1A1D' : i % 2 ? '#101010' : undefined}>
                    <Text color="cyanBright" bold>
                      {isCursor ? cursorGlyph : '  '}
                    </Text>
                    {claudeTableLayout.showIndex ? <Text dimColor>{formatAccountOrdinal(i, claudeTableLayout.indexWidth)}{' '}</Text> : null}
                    <Text color={p.needsReauth ? 'red' : isActive ? 'green' : 'gray'}>
                      {p.needsReauth ? '⚠' : isActive ? activeGlyph : '○'}{' '}
                    </Text>
                    {compactTable ? (
                      <>
                        <Text bold={isCursor} color={p.needsReauth ? 'red' : isCursor ? 'white' : undefined}>{pad(accountListLabel(p.label, p.email, !!p.importedSession), claudeTableLayout.accountWidth)}</Text>
                        <ColumnRule />
                        <Text color={planColor(p.subscriptionType)}>{pad(formatPlanLabel(p.subscriptionType), claudeTableLayout.planWidth)}</Text>
                        {!ultraCompactTable ? <>
                          <ColumnRule />
                          <Text color={utilColor(p.usage?.five_hour?.utilization ?? null)}>{pad(fmtPct(p.usage?.five_hour?.utilization), claudeTableLayout.usageWidth)}</Text>
                          <ColumnRule />
                          <Text color={utilColor(p.usage?.seven_day?.utilization ?? null)}>{pad(fmtPct(p.usage?.seven_day?.utilization), claudeTableLayout.usageWidth)}</Text>
                        </> : null}
                      </>
                    ) : (
                      <>
                        <Text bold={isCursor} color={p.needsReauth ? 'red' : isCursor ? 'white' : undefined}>{pad(accountListLabel(p.label, p.email, !!p.importedSession), claudeTableLayout.accountWidth)}</Text>
                        <ColumnRule />
                        <Text color={planColor(p.subscriptionType)}>{pad(formatPlanLabel(p.subscriptionType), claudeTableLayout.planWidth)}</Text>
                        <ColumnRule />
                        <UsageCell win={p.usage?.five_hour} />
                        <ColumnRule />
                        <UsageCell win={p.usage?.seven_day} />
                        <ColumnRule />
                        {p.needsReauth ? <Text color="red">{pad('REAUTH', claudeTableLayout.stateWidth)}</Text> : isActive ? <Text color="green">{pad('ACTIVE', claudeTableLayout.stateWidth)}</Text> : <Text dimColor>{pad(linked || relTime(p.lastUsedAt), claudeTableLayout.stateWidth)}</Text>}
                      </>
                    )}
                  </Text>
                );
              })}
              {profiles.length > listCapacity ? (
                <Text dimColor>showing {claudeViewport.start + 1}–{claudeViewport.end} of {profiles.length} · PgUp/PgDn · g/G</Text>
              ) : null}
            </>
          )}

          {mode === 'confirmSwitch' && pendingSwitch ? (
            <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold color="yellow">
                Switch to "{pendingSwitch.profile.label}" ({pendingSwitch.profile.email})?
              </Text>
              {hasCliAuth(pendingSwitch.profile) ? (
                pendingSwitch.pids.length ? (
                  <Text color="yellow">
                    Close Claude normally before confirming. Still detected: {pendingSwitch.pids.map((p) => p.pid).join(', ')}.
                  </Text>
                ) : (
                  <Text dimColor>No running Claude process detected. This is rechecked before any write.</Text>
                )
              ) : null}
              {pendingSwitch.profile.desktopSnapshotDir ? (
                <Text color="yellow">
                  ⚠ Make sure Claude Desktop is fully closed (quit it — check the tray) before confirming.
                </Text>
              ) : null}
              <Text dimColor>A backup is taken automatically before any change.</Text>
              <Box marginTop={1}>
                <Text color="yellow">[y]</Text>
                <Text dimColor> confirm · </Text>
                <Text dimColor>[n] cancel</Text>
              </Box>
            </Box>
          ) : null}

          {mode === 'confirmDelete' && selected ? (
            <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
              <Text color="red">
                Archive profile "{selected.label}" ({selected.email})? Credentials are retained. [y] yes · [n] no
              </Text>
            </Box>
          ) : null}

          {mode === 'rename' ? (
            <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
              <Text>
                Rename to: <Text color="green">{buffer}</Text>
                <Text>▎</Text> <Text dimColor>(Enter to save · Esc to cancel)</Text>
              </Text>
            </Box>
          ) : null}
        </Box>
      )}

      {/* footer */}
      <Box marginTop={1} flexDirection="column">
        <Divider width={W} color="gray" />
        {busy ? (
          <Box flexDirection="column">
            <Spinner label={busy} />
            {bulkRefreshAbortRef.current ? <Text dimColor>Esc cancel after current account · / find while refresh continues</Text> : null}
          </Box>
        ) : status ? <Text color="yellow">{status}</Text> : null}
        {mode === 'list' ? (
          <Text dimColor>
            <Text color={providerColor}>↑/↓</Text> select · <Text color={providerColor}>⏎</Text> switch ·{' '}
            <Text color={providerColor}>b</Text> best · <Text color={providerColor}>u</Text> refresh ·{' '}
            <Text color={providerColor}>a</Text> add · <Text color={providerColor}>/</Text> find ·{' '}
            <Text color={providerColor}>?</Text> all commands · <Text color={providerColor}>q</Text> quit
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

// ---------- non-interactive commands + entry ----------

function printHelp(): void {
  console.log(`Claude + Codex Account Switch

Usage:
  switch.cmd                 Launch the interactive account switcher (TUI)
  switch.cmd login [provider] Add an account via the official Claude/Codex login
  switch.cmd import [--provider claude|codex] <path>
                             Import one file; external sources remain untouched
  switch.cmd import-all [--provider claude|codex] <bundle-or-folder>
                             Validate and import every account represented by the source
  switch.cmd export-all [claude|codex]
                             Write a new timestamped provider-tagged bundle
  switch.cmd doctor [all|claude|codex]  Diagnose accounts without printing secrets
  switch.cmd --dry-run       Show exactly which keys a switch would change (no writes)
  switch.cmd restore <claude|codex> [backup-path]
                             Restore one provider's live auth transactionally
  switch.cmd install         Configure Codex auth + shortcuts + auto keep-alive
  switch.cmd uninstall       Remove shortcuts + the scheduled keep-alive job
  switch.cmd keep-alive          Refresh due tokens now and report accounts needing renewal
  switch.cmd keep-alive install|uninstall
                             Add/remove only the keep-alive schedule (no shortcuts)
  switch.cmd --help          This help

Interactive transfer:
  i                          Open the current provider's managed import inbox
  I                          Paste or drag an existing file/folder path
  Successful inbox sources move to import/processed with a receipt.

Data & logs live in ~/.claude-switch/

Copyright (C) 2026 LightZirconite
License: AGPL-3.0-or-later (see LICENSE; no warranty)
Source: https://git.justw.tf/LightZirconite/claude-account-switch`);
}

function asTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function relMs(ms: number | null): string {
  if (ms == null) return 'unknown';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const unit =
    abs >= 86_400_000 ? `${Math.round(diff / 86_400_000)}d` :
    abs >= 3_600_000 ? `${Math.round(diff / 3_600_000)}h` :
    `${Math.round(diff / 60_000)}m`;
  return diff >= 0 ? `in ${unit}` : `${unit.replace('-', '')} ago`;
}

function usageAge(p: Profile): string {
  if (!p.usage?.fetchedAt) return 'none';
  return `${p.usage.status}, fetched ${relMs(p.usage.fetchedAt)}`;
}

async function printClaudeDoctor(): Promise<void> {
  const store = loadStore();
  const liveAuthRecovery = inspectClaudeLiveAuthRecovery();
  console.log(`Claude provider`);
  console.log(`Claude Code version: ${liveAuthRecovery.pending ? 'withheld while live-auth recovery is pending' : detectClaudeVersion()}`);
  console.log(`Profiles: ${store.profiles.length}`);
  console.log(`Restorable archives: ${(store.tombstones ?? []).filter((t) => t.archivedProfile?.provider === 'claude' && (!t.restoredAt || t.deletedAt > t.restoredAt)).length}`);
  console.log(`Active profile id: ${store.activeProfileId ?? '(none)'}`);
  console.log(`Untracked credential envelopes: ${orphanedClaudeCredentialIds(store).length}`);
  console.log(`Untracked Desktop bundles: ${orphanedClaudeDesktopIds(store).length}`);
  console.log(
    `CLI live-auth recovery journal: ${liveAuthRecovery.pending
      ? `ATTENTION (damaged=${liveAuthRecovery.damaged}, state=${liveAuthRecovery.state ?? 'unreadable'})`
      : 'clean'}`,
  );
  const desktopRecovery = inspectDesktopRecovery();
  console.log(
    `Desktop recovery journal: ${desktopRecovery.livePending || desktopRecovery.capturePending || desktopRecovery.damaged
      ? `ATTENTION (live=${desktopRecovery.livePending}, capture=${desktopRecovery.capturePending}, damaged=${desktopRecovery.damaged})`
      : 'clean'}`,
  );
  try {
    console.log(`Claude Desktop data store: ${desktopUserDataDir() ?? '(not installed)'}`);
  } catch (error) {
    console.log(`Claude Desktop data store: AMBIGUOUS (${redactText(error)})`);
  }

  const envAuth = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']
    .filter((k) => !!process.env[k]);
  console.log(`Auth env override: ${envAuth.length ? envAuth.join(', ') : 'none'}`);
  if (process.platform === 'darwin') {
    console.log('Official credential store: macOS Keychain');
  } else {
    console.log(`Official credential file: ${credentialsPath()}`);
    const undottedCredentials = undottedClaudeCredentialsPath();
    console.log(`Undotted credential artifact: ${fs.existsSync(undottedCredentials) ? `present and ignored (${undottedCredentials})` : 'absent'}`);
  }
  if (liveAuthRecovery.pending) {
    console.log('Official auth status: withheld while the CLI live-auth transaction is unresolved');
  } else {
    const official = await readClaudeAuthStatus();
    console.log(`Official auth status: ${official ? (official.loggedIn ? 'logged in' : 'logged out') : 'unavailable on this Claude version'}`);
    if (official?.subscriptionType) console.log(`Official live plan: ${official.subscriptionType}`);
  }

  console.log('\nLive Claude files:');
  if (liveAuthRecovery.pending) {
    console.log('  withheld: resolve the CLI live-auth recovery journal before trusting the two-file identity');
  } else {
    try {
      const live = getLiveAccount();
      const liveOauth = live.claudeAiOauth;
      console.log(`  email: ${live.oauthAccount?.emailAddress ?? '(unknown)'}`);
      console.log(`  refreshable: ${hasRefreshableOauth(liveOauth) ? 'yes' : 'NO'}`);
      console.log(`  access token: ${liveOauth?.accessToken ? `present, expires ${relMs(asTime(liveOauth.expiresAt))}` : 'missing'}`);
      console.log(`  login expiry: ${relMs(asTime(liveOauth?.refreshTokenExpiresAt))}`);
    } catch (error) {
      // Doctor is an inventory command: one provider fault must remain visible without
      // preventing the rest of `doctor all` from running. Mutating commands continue to
      // fail closed on this same ambiguity.
      console.log(`  unavailable: ${redactText(error)}`);
    }
  }

  console.log('\nSaved profiles:');
  for (const p of store.profiles) {
    const oauth = p.claudeAiOauth;
    const refreshable = hasCliAuth(p);
    const flags = [
      p.id === store.activeProfileId ? 'active' : null,
      p.needsReauth ? 'needs re-add' : null,
      refreshable ? 'cli' : null,
      p.desktopSnapshotDir ? 'desktop' : null,
      p.importedSession ? `imported ${p.importedSession.format}` : null,
    ].filter(Boolean).join(', ') || 'saved';
    console.log(`  - ${p.label} <${p.email}> [${flags}]`);
    console.log(`    access: ${oauth?.accessToken ? relMs(asTime(oauth.expiresAt)) : 'missing'}; login: ${relMs(asTime(oauth?.refreshTokenExpiresAt))}; usage: ${usageAge(p)}`);
  }
}

async function printCodexDoctor(): Promise<void> {
  const store = loadCodexStore();
  const pending = listPendingCodexHomes();
  let abandoned: ReturnType<typeof listAbandonedCodexLoginArchives> | null = null;
  let abandonedError: string | null = null;
  try {
    abandoned = listAbandonedCodexLoginArchives();
  } catch (error) {
    abandonedError = redactText(error);
  }
  console.log(`Codex`);
  console.log(`Codex version: ${detectCodexVersion()}`);
  console.log(`Profiles: ${store.profiles.length}`);
  console.log(`Restorable archives: ${store.tombstones.filter((t) => t.archivedProfile?.provider === 'codex' && (!t.restoredAt || t.deletedAt > t.restoredAt)).length}`);
  console.log(`Active profile id: ${store.activeProfileId ?? '(none)'}`);
  console.log(`Pending login sandboxes: ${pending.length}`);
  if (abandoned) {
    const recoverable = abandoned.filter((archive) => archive.recoverable).length;
    const invalidManifests = abandoned.filter((archive) => archive.manifestStatus !== 'valid').length;
    const invalidAuth = abandoned.filter((archive) => archive.authStatus !== 'valid').length;
    console.log(`Archived abandoned logins: ${abandoned.length} total; ${recoverable} recoverable with z`);
    if (invalidManifests || invalidAuth) {
      console.log(`  evidence requiring manual inspection: ${invalidManifests} invalid manifest; ${invalidAuth} missing/invalid auth.json`);
    }
  } else {
    console.log(`Archived abandoned logins: unavailable (${abandonedError})`);
  }
  const liveAuth = readCodexAuth(codexHome());
  const savedLiveProfile = liveAuth
    ? store.profiles.find((profile) => profile.accountId === liveAuth.tokens.account_id)
    : null;
  try {
    const live = await inspectCodexHome(codexHome(), false, { forceFileCredentials: false });
    console.log(`Effective credential store: ${live.credentialStore ?? 'auto/default'}`);
    if (liveAuth) {
      const email = live.account?.email ?? savedLiveProfile?.email ?? '(unknown)';
      const plan = resolveCodexPlan(live, savedLiveProfile?.planType);
      const planLabel = formatPlanLabel(plan.planType);
      const providerDetail = plan.planType && planLabel.toLowerCase() !== plan.planType.toLowerCase()
        ? `; provider=${plan.planType}`
        : '';
      console.log(`Live account: ${email} (${planLabel}; source=${plan.source ?? savedLiveProfile?.planSource ?? 'saved'}${providerDetail})`);
    } else {
      console.log('Live account: not logged in with ChatGPT');
    }
  } catch (e) {
    if (liveAuth) {
      console.log(`Live account: ${savedLiveProfile?.email ?? '(managed ChatGPT auth saved)'} (status check unavailable)`);
    } else {
      console.log(`Live account: unavailable (${redactText(e)})`);
    }
  }
  console.log('Saved profiles:');
  for (const profile of store.profiles) {
    const bucket = effectiveCodexQuota(profile);
    const windows = (['primary', 'secondary'] as const).flatMap((key) => {
      const window = bucket[key];
      if (window) return [`${formatQuotaWindowLabel(window.windowDurationMins).toLowerCase()}=${window.usedPercent}%`];
      const complete = key === 'primary' ? bucket.primaryComplete : bucket.secondaryComplete;
      return complete ? [] : [`${key}=?`];
    });
    const flags = [
      profile.id === store.activeProfileId ? 'active' : null,
      profile.needsReauth ? 'needs re-add' : null,
      profile.importedSession ? `imported ${profile.importedSession.format}` : null,
    ]
      .filter(Boolean).join(', ') || 'saved';
    const planLabel = formatPlanLabel(profile.planType);
    const providerDetail = profile.planType && planLabel.toLowerCase() !== profile.planType.toLowerCase()
      ? ` [provider=${profile.planType}]`
      : '';
    console.log(`  - ${profile.label} <${profile.email}> [${flags}] plan=${planLabel}${providerDetail}`);
    console.log(`    usage: ${profile.usage?.status ?? 'never'}; ${windows.join('; ') || 'no rolling window'}`);
  }
}

function printDryRun(target: Profile, rep: DryRunReport): void {
  console.log(`Dry-run: simulate switching to "${target.label}" (${target.email})\n`);
  console.log('.credentials.json');
  console.log('  will set   :', rep.credentials.willSet.join(', '));
  console.log('  preserved  :', rep.credentials.preserved.join(', ') || '(none)');
  console.log('\n.claude.json');
  console.log('  will set   :', rep.claudeJson.willSet.join(', '));
  console.log(`  preserved  : ${rep.claudeJson.preserved.length} other top-level keys (untouched)`);
  console.log('  still valid:', rep.claudeJson.stillValid ? 'yes' : 'NO');
  console.log('\nNo files were written.');
}

/**
 * Headless keep-alive: refresh every account's OAuth token that's near expiry and persist
 * the rotation — so accounts stay alive even when the switcher UI isn't open. Run by the OS
 * scheduler (see keep-alive install). The ACTIVE account is renewed only when process
 * inventory proves that no official Claude client can hold its rotating token in memory.
 */
async function runKeepAliveOnce(): Promise<void> {
  const liveRecovery = recoverClaudeLiveAuthTransaction();
  if (liveRecovery.recovered) {
    logger.warn('headless keep-alive recovered an interrupted Claude live-auth transaction', { ...liveRecovery });
  }
  let store = loadStore();
  if (!store.profiles.length) {
    console.log('keep-alive: no accounts saved.');
    return;
  }
  const LEAD_MS = 60 * 60 * 1000; // refresh anything expiring within the next hour
  try {
    store = reconcileStoreWithProviderProof();
  } catch (error) {
    logger.error('headless keep-alive reconciliation failed; refresh aborted', error);
    throw new Error('keep-alive aborted because the live Claude identity could not be reconciled safely.', { cause: error });
  }
  const onRotate = (p: Profile) => {
    const fresh = loadStore();
    const persisted = fresh.profiles.find((candidate) => candidate.id === p.id) ?? p;
    if (persisted.id === fresh.activeProfileId && hasCliAuth(persisted) && !persisted.needsReauth) {
      try {
        updateLiveCredentials(persisted.claudeAiOauth, persisted.organizationUuidRoot ?? persisted.organizationUuid);
      } catch {
        /* ignore */
      }
    }
  };
  let refreshed = 0;
  let dead = 0;
  for (const p of store.profiles) {
    if (p.needsReauth) {
      dead++;
      continue;
    }
    if (!hasCliAuth(p)) continue;
    const before = p.claudeAiOauth.refreshToken;
    if (p.id === store.activeProfileId) {
      await keepActiveTokenAlive(p, LEAD_MS, onRotate);
    } else {
      await keepTokenAlive(p, LEAD_MS, onRotate);
    }
    if (p.claudeAiOauth.refreshToken !== before) refreshed++;
    if (p.needsReauth) dead++;
  }
  await recoverMissingClaudeProfileMetadata(detectClaudeVersion()).catch((error) => {
    logger.warn('headless Claude imported-profile metadata remains unavailable', { error: String(error) });
  });
  store = loadStore();
  logger.info('keep-alive run complete', { refreshed, dead, total: store.profiles.length });
  console.log(`keep-alive: refreshed ${refreshed} token(s)${dead ? `, ${dead} account(s) need re-add` : ''}.`);
}

/** Print an install/uninstall report to the console. */
function printReport(title: string, report: InstallReport): void {
  console.log(title);
  for (const s of report.steps) {
    console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args: string[] = [];
  const pathFlags: Record<string, 'CLAUDE_SWITCH_HOME' | 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'CODEX_BIN'> = {
    '--switch-home': 'CLAUDE_SWITCH_HOME',
    '--claude-config': 'CLAUDE_CONFIG_DIR',
    '--codex-home': 'CODEX_HOME',
    '--codex-bin': 'CODEX_BIN',
  };
  for (let index = 0; index < rawArgs.length; index++) {
    const envName = pathFlags[rawArgs[index]];
    if (!envName) {
      args.push(rawArgs[index]);
      continue;
    }
    const value = rawArgs[++index]?.trim();
    if (!value) throw new Error(`${rawArgs[index - 1]} requires a non-empty path.`);
    process.env[envName] = value;
  }

  if (args.includes('--scheduler-probe')) {
    const claude = loadStore();
    const codex = loadCodexStore();
    let codexVersion = 'not-required';
    if (process.env.CODEX_BIN?.trim()) {
      codexVersion = detectCodexVersion();
      if (codexVersion === 'unknown') {
        throw new Error('scheduler probe could not execute the persisted --codex-bin executable.');
      }
    } else if (codex.profiles.length > 0) {
      throw new Error('scheduler probe requires a working persisted --codex-bin executable for saved Codex profiles.');
    }
    console.log(`homes verified: switch=${dataDir()} claude=${claudeConfigDir()} codex=${codexHome()} profiles=${claude.profiles.length}/${codex.profiles.length} codex-cli=${codexVersion}`);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args[0] === 'codex-switch-worker' && args[1] && args[2]) {
    await runCodexSwitchWorker(args[1], args[2]);
    return;
  }

  if (args[0] === 'doctor') {
    const scope = args[1] ?? 'all';
    console.log('Claude + Codex Account Switch doctor\n');
    if (scope === 'all' || scope === 'claude') await printClaudeDoctor();
    if (scope === 'all') console.log('');
    if (scope === 'all' || scope === 'codex') await printCodexDoctor();
    return;
  }

  if (args[0] === 'restore') {
    const provider = args[1];
    const selected = args[2];
    if (provider === 'claude') {
      const recovered = recoverClaudeLiveAuthTransaction();
      if (recovered.recovered) {
        console.log(`Recovered interrupted Claude live-auth transaction from: ${recovered.backupDir ?? '(protected backup)'}`);
      }
      if (selected) {
        restoreFromBackup(selected);
        console.log(`Restored Claude credentials from backup: ${selected}`);
      } else {
        const dir = restoreLatestBackup();
        console.log(dir ? `Restored Claude credentials from backup: ${dir}` : 'No Claude live-auth backups found.');
      }
      return;
    }
    if (provider === 'codex') {
      if (selected) {
        await restoreCodexLiveBackup(selected);
        console.log(`Restored Codex credentials from backup: ${selected}`);
      } else {
        const dir = await restoreLatestCodexLiveBackup();
        console.log(dir ? `Restored Codex credentials from backup: ${dir}` : 'No Codex live-auth backups found.');
      }
      return;
    }
    console.error('Restore provider is required: switch.cmd restore <claude|codex> [backup-path]');
    process.exitCode = 2;
    return;
  }

  if (args[0] === 'install') {
    printReport(`Setting up ${APP_NAME}…`, installAll());
    console.log('\nDone. Undo any time with:  switch.cmd uninstall');
    return;
  }
  if (args[0] === 'uninstall') {
    printReport(`Removing ${APP_NAME} shortcuts & scheduled job…`, uninstallAll());
    console.log('\nYour saved accounts were NOT touched.');
    return;
  }

  if (args[0] === 'keep-alive') {
    if (args[1] === 'install') {
      const s = schedulerOnlyInstall();
      console.log(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
      return;
    }
    if (args[1] === 'uninstall') {
      const s = schedulerOnlyUninstall();
      console.log(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
      return;
    }
    const failures: string[] = [];
    try {
      await runKeepAliveOnce();
    } catch (e) {
      const detail = redactText(e);
      failures.push(`Claude: ${detail}`);
      console.log(`claude keep-alive failed: ${detail}`);
    }
    try {
      const savedCodex = loadCodexStore();
      if (!savedCodex.profiles.length) {
        console.log('codex keep-alive: skipped (no saved Codex accounts).');
      } else {
        if (args.includes('--scheduler-runtime') && !process.env.CODEX_BIN?.trim()) {
          throw new Error('saved Codex accounts now exist, but this scheduled action has no pinned Codex executable; reinstall keep-alive from the setup screen.');
        }
        const codex = await refreshAllCodexProfiles();
        const dead = codex.profiles.filter((profile) => profile.needsReauth).length;
        console.log(`codex keep-alive: checked ${codex.profiles.length} account(s)${dead ? `, ${dead} need re-add` : ''}.`);
      }
    } catch (e) {
      const detail = redactText(e);
      failures.push(`Codex: ${detail}`);
      console.log(`codex keep-alive failed: ${detail}`);
    }
    if (failures.length) {
      logger.error('provider-isolated keep-alive completed with failures', undefined, { failures });
      console.log(`keep-alive completed with ${failures.length} provider failure(s); the other provider still ran.`);
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === 'login') {
    if (args[1] === 'codex') {
      console.log('Starting official Codex ChatGPT login...\n');
      const result = await addCodexAccount(async (url) => {
        try {
          await clipboard.write(url);
          console.log('Authorization URL copied to the clipboard. No browser was opened.');
        } catch {
          console.log('Clipboard unavailable. Copy the URL below.');
        }
        console.log(`${url}\n`);
        console.log('Complete authorization remotely, then open the final localhost callback URL on this computer.');
      });
      console.log(`Added Codex account "${result.profile.label}" (${result.profile.email}).`);
      return;
    }
    console.log('Starting official claude login in an isolated sandbox...\n');
    let committed: { store: ProfilesStore; profile: Profile } | undefined;
    const ident = await loginViaClaudeCli(findClaudeExe(), undefined, (identity) => {
      const fields = identityToFields(identity);
      let profile: Profile | undefined;
      const store = mutateStore((fresh) => {
        profile = addOrUpdateProfile(fresh, fields, undefined, { credentialSource: 'validated-login' });
      });
      if (!profile) throw new Error('Claude account was not committed after official login.');
      committed = { store, profile };
    });
    if (!ident || !hasRefreshableOauth(ident.claudeAiOauth)) {
      console.log('\nLogin did not complete. Nothing imported.');
      return;
    }
    if (!committed) throw new Error('Claude account was not imported after login.');
    console.log(`\n✓ Added "${committed.profile.label}" (${committed.profile.email}). Launch the switcher to use it.`);
    return;
  }

  if (args[0] === 'import' || args[0] === 'import-all') {
    const providerArg = args[1] === '--provider' ? args[2] : args[1] === 'codex' || args[1] === 'claude' ? args[1] : 'claude';
    const rawTarget = args[1] === '--provider' ? args[3] : args[1] === 'codex' || args[1] === 'claude' ? args[2] : args[1];
    const target = rawTarget ? normalizeImportPath(rawTarget) : '';
    if (!target) {
      console.log('Import path is required.');
      return;
    }
    if (providerArg !== 'claude' && providerArg !== 'codex') {
      throw new Error(`Unsupported import provider "${providerArg}". Use claude or codex.`);
    }
    if (providerArg === 'codex') {
      const sources = discoverCodexImportFiles(target);
      let imported = await importCodexFromPath(target);
      if (!imported.length) {
        console.log(`Nothing importable at: ${target}`);
        return;
      }
      const importedCount = imported.length;
      const metadata = await recoverImportedCodexMetadata(imported);
      const refreshedProfiles = imported
        .map((profile) => metadata.store.profiles.find((candidate) => candidate.id === profile.id))
        .filter((profile): profile is CodexProfile => !!profile);
      if (refreshedProfiles.length) imported = refreshedProfiles;
      for (const profile of imported) console.log(`Imported Codex "${profile.label}" (${profile.email})`);
      console.log(providerMetadataSummary(metadata.verifiedCount, importedCount));
      console.log('⧉ Imported session: another active PC can make token renewal less reliable.');
      const disposition = archiveImportedSources('codex', sources, imported);
      console.log(importDispositionSummary(disposition));
      for (const error of disposition.errors) console.log(`Cleanup warning: ${redactText(error)}`);
      return;
    }
    const discovered = importFromPath(target);
    if (!discovered.length) {
      console.log(`Nothing importable at: ${target}`);
      return;
    }
    const metadata = await recoverClaudeImportMetadata(discovered, detectClaudeVersion());
    const cands = metadata.candidates;
    const imported: Profile[] = [];
    mutateStore((store) => {
      for (const c of cands) {
        imported.push(addOrUpdateProfile(store, c.fields, c.label, {
          credentialSource: c.format === 'raw-credentials' ? 'raw-import' : 'portable-import',
        }));
      }
    });
    const uniqueProfiles = [...new Map(imported.map((profile) => [profile.id, profile])).values()];
    for (const profile of uniqueProfiles) console.log(`Imported "${profile.label}" (${profile.email})`);
    console.log(providerMetadataSummary(metadata.verifiedCount, cands.length));
    console.log('⧉ Imported session: another active PC can make token renewal less reliable.');
    const disposition = archiveImportedSources(
      'claude',
      [...new Set(cands.flatMap((candidate) => candidate.consumedPaths))],
      uniqueProfiles,
    );
    console.log(importDispositionSummary(disposition));
    for (const error of disposition.errors) console.log(`Cleanup warning: ${redactText(error)}`);
    return;
  }

  if (args[0] === 'export-all') {
    if (args[1] === 'codex') {
      const codexStore = loadCodexStore();
      if (!codexStore.profiles.length) {
        console.log('No Codex accounts to export.');
        return;
      }
      const file = await exportAllCodexProfiles(codexStore, { processInventory: findCodexProcesses });
      console.log(`Exported ${codexStore.profiles.length} Codex account(s) to:\n${file}`);
      return;
    }
    const recovered = recoverClaudeLiveAuthTransaction();
    if (recovered.recovered) {
      console.log(`Recovered interrupted Claude live-auth transaction before export: ${recovered.backupDir ?? '(protected backup)'}`);
    }
    const store = loadStore();
    if (!store.profiles.length) {
      console.log('No accounts to export.');
      return;
    }
    const result = await exportAllProfiles(store);
    console.log(`Exported ${result.exportedCount} portable Claude Code account(s) to:\n${result.file}`);
    if (result.skippedDesktopOnly.length) {
      console.log(`Skipped ${result.skippedDesktopOnly.length} Desktop-only session(s): machine-bound Desktop data is not portable.`);
    }
    return;
  }

  // Finish any CLI transaction interrupted between `.credentials.json` and
  // `.claude.json` before reconciliation can observe a hybrid identity.
  const claudeLiveRecovery = recoverClaudeLiveAuthTransaction();
  if (claudeLiveRecovery.recovered) {
    logger.warn('recovered interrupted Claude CLI live-auth transaction at startup', { ...claudeLiveRecovery });
  }

  // Finish any Desktop transaction that was interrupted by a crash/power loss before
  // loading interactive state. Never touch its live Chromium store while any Claude
  // process may still have LevelDB/SQLite files open.
  const desktopRecovery = inspectDesktopRecovery();
  if (desktopRecovery.livePending || desktopRecovery.capturePending || desktopRecovery.damaged) {
    if (desktopRecovery.livePending || desktopRecovery.damaged) {
      const running = findClaudeProcesses();
      if (running.length) {
        throw new Error(
          `Claude Desktop recovery is pending, but Claude is still running (${running.map((process) => process.pid).join(', ')}). Close it normally and relaunch the switcher.`,
        );
      }
    }
    const recovered = recoverDesktopTransactions();
    logger.warn('recovered interrupted Claude Desktop transactions at startup', { ...recovered });
  }

  // Load + reconcile with the live account before doing anything interactive.
  let store = loadStore();
  const claudeVersion = detectClaudeVersion();
  try {
    store = reconcileStoreWithProviderProof((fresh) => {
      fresh.claudeVersion = claudeVersion;
      for (const p of fresh.profiles) {
        if (!p.subscriptionType && p.claudeAiOauth) {
          const derived = subscriptionOf(p.claudeAiOauth, p.organizationType);
          if (derived) p.subscriptionType = derived;
        }
      }
    });
  } catch (e) {
    logger.error('startup reconcile failed', e);
  }

  const recoveredPending = recoverAbandonedCodexHomes();
  if (recoveredPending.length) {
    logger.warn('startup recovered abandoned Codex login sandboxes', { count: recoveredPending.length });
  }
  let codexStore = loadCodexStore();
  try {
    codexStore = (await reconcileLiveCodex()).store;
  } catch (e) {
    logger.warn('startup Codex reconcile failed', { error: String(e) });
  }

  if (args.includes('--dry-run')) {
    const target = store.profiles.find((p) => p.id !== store.activeProfileId) ?? getActive(store);
    if (!target) {
      console.log('No profile available to dry-run. Are you logged into Claude Code?');
      return;
    }
    printDryRun(target, dryRunApply(target));
    return;
  }

  render(<App initialStore={store} initialCodexStore={codexStore} claudeVersion={claudeVersion} />);
}

main().catch((e) => {
  logger.error('fatal', e);
  console.error(redactText(e));
  process.exit(1);
});
