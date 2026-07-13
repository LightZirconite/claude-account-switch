// Keyboard-driven TUI for switching Claude Code and Codex accounts. UI is in English.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';
import clipboard from 'clipboardy';

import { logFile, findClaudeExe, importDir } from './paths';
import { logger } from './logger';
import { checkForUpdate } from './updateCheck';
import pkg from '../package.json';
const APP_VERSION: string = pkg.version;
import {
  loadStore,
  mutateStore,
  reconcileWithLive,
  getActive,
  addOrUpdateProfile,
  captureDesktopAccount,
  deleteProfile,
  restoreLatestDeletedProfile,
  exportProfile,
  scanImportDir,
  importFromPath,
  subscriptionOf,
  exportAllProfiles,
  type ImportCandidate,
} from './profiles';
import {
  applyProfile,
  getLiveAccount,
  restoreLatestBackup,
  dryRunApply,
  updateLiveCredentials,
  type DryRunReport,
} from './claudeStore';
import { applyDesktopSnapshot, isDesktopInstalled } from './desktopStore';
import { bestNow, ensureFreshToken, fetchUsage, keepTokenAlive, leastLoaded } from './usage';
import { findClaudeProcesses, closeProcesses, detectClaudeVersion, type ProcInfo } from './processes';
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
  DEFAULT_SCOPES,
  type ManualAuth,
  type PrimedIdentity,
} from './oauth';
import { hasCliAuth, hasRefreshableOauth, type Profile, type ProfilesStore } from './types';
import type { CodexProfile, CodexProfilesStore, ProviderId } from './types';
import {
  addCodexAccount,
  bestNowCodex,
  deleteCodexProfile,
  exportAllCodexProfiles,
  exportCodexProfile,
  importCodexFromPath,
  leastLoadedCodex,
  loadCodexStore,
  listPendingCodexHomes,
  readCodexAuth,
  recoverAbandonedCodexHomes,
  restoreLatestDeletedCodexProfile,
  reconcileLiveCodex,
  refreshCodexProfile,
  refreshAllCodexProfiles,
  renameCodexProfile,
} from './codexProfiles';
import {
  CodexLoginCancelledError,
  codexRedirectUriFromAuthUrl,
  detectCodexVersion,
  inspectCodexHome,
  submitCodexCallback as forwardCodexCallback,
} from './codexAppServer';
import { codexHome } from './paths';
import {
  findCodexProcesses,
  runCodexSwitchWorker,
  startCodexSwitchWorker,
  waitForCodexSwitchResult,
} from './codexSwitch';
import { switchProviderTab } from './navigation';
import type { BestNowDecision } from './scheduling';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function identityToFields(id: PrimedIdentity) {
  const oa = id.oauthAccount;
  return {
    email: oa.emailAddress ?? '(new account)',
    accountUuid: oa.accountUuid || id.claudeAiOauth.accessToken.slice(-12),
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
    if (process.platform === 'win32') {
      spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
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
const CodexTerminalMark = () => (
  <Box flexDirection="column" alignItems="center">
    <Text bold color={CODEX_BLUE}>{'      .-~~~~-.'}</Text>
    <Text bold color={CODEX_BLUE}>{"   .-'        '-."}</Text>
    <Text bold color={CODEX_BLUE}>{" .'      "}<Text color="white">{'>_'}</Text>{"       '."}</Text>
    <Text bold color={CODEX_BLUE}>{'(        ______     )'}</Text>
    <Text bold color={CODEX_BLUE}>{" '.              .'"}</Text>
    <Text bold color={CODEX_BLUE}>{"   '-.________.-'"}</Text>
  </Box>
);
// Fable promo: keep the per-model bucket visible through July 19, then auto-hide.
const FABLE_PROMO_END = new Date('2026-07-20T00:00:00').getTime();

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
function currentCols(): number {
  return process.stdout.columns || Number(process.env.COLUMNS) || 100;
}
function useTerminalSize(): number {
  const [cols, setCols] = useState<number>(currentCols());
  useEffect(() => {
    const onResize = () => setCols(currentCols());
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return cols;
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

function bestNowDetail(decision: BestNowDecision<unknown>): string {
  if (decision.reason === 'primary-reset-soon' && decision.primaryResetsAt) {
    return `5h ${Math.round(decision.primaryUsedPercent ?? 0)}% · resets in ${resetIn(new Date(decision.primaryResetsAt).toISOString())}`;
  }
  if (decision.reason === 'secondary-reset-soon' && decision.secondaryResetsAt) {
    return `7d ${Math.round(decision.secondaryUsedPercent ?? 0)}% · resets in ${resetIn(new Date(decision.secondaryResetsAt).toISOString())}`;
  }
  return 'most usable headroom';
}

function planColor(sub?: string): string {
  if (!sub) return 'gray';
  if (/max/i.test(sub)) return 'magenta';
  if (/pro/i.test(sub)) return 'blueBright';
  return 'cyan';
}

// A fixed 12-char cell: "  46% ██████" — number first so it aligns under its header.
function UsageCell({ win }: { win?: { utilization: number | null } | null }) {
  const u = win?.utilization ?? null;
  const width = 6;
  const filled = u == null ? 0 : Math.max(0, Math.min(width, Math.round((u / 100) * width)));
  const bar = u == null ? '─'.repeat(width) : '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (u == null ? '·' : `${Math.round(u)}%`).padStart(4);
  const color = utilColor(u);
  return (
    <Text>
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
  | 'importMenu'
  | 'importPath'
  | 'adding'
  | 'capturingDesktopConfirm'
  | 'capturingDesktopLabel'
  | 'capturingDesktopEmail'
  | 'setup'
  | 'codexAdding'
  | 'codexConfirmSwitch'
  | 'codexConfirmDelete'
  | 'codexRename'
  | 'codexImportPath'
  | 'message';
type Tone = 'success' | 'error' | 'info';

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
  const [pendingSwitch, setPendingSwitch] = useState<{ profile: Profile; pids: ProcInfo[] } | null>(null);
  const [pendingCodexSwitch, setPendingCodexSwitch] = useState<CodexProfile | null>(null);
  const [importCands, setImportCands] = useState<ImportCandidate[]>([]);
  const [importCursor, setImportCursor] = useState(0);
  const [addLines, setAddLines] = useState<string[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [codexAddLines, setCodexAddLines] = useState<string[]>([]);
  const [codexCallbackBusy, setCodexCallbackBusy] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const desktopLabelRef = useRef('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [setupReport, setSetupReport] = useState<InstallReport | null>(null);
  const [message, setMessage] = useState<{ title: string; lines: string[]; tone: Tone } | null>(null);
  const authRef = useRef<ManualAuth | null>(null);
  const claudeReauthEmailRef = useRef<string | null>(null);
  const codexAddAbortRef = useRef<AbortController | null>(null);
  const codexRedirectRef = useRef<string | null>(null);
  const claudeUsageRefreshRef = useRef<Promise<ProfilesStore> | null>(null);
  const codexUsageRefreshRef = useRef<Promise<CodexProfilesStore> | null>(null);
  const cols = useTerminalSize();
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

  const showMessage = useCallback((title: string, lines: string[], tone: Tone) => {
    setMessage({ title, lines, tone });
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
        showMessage('Codex login failed', [String((e as Error).message ?? e)], 'error');
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
      if (!signal?.aborted) setStatus(String((error as Error).message ?? error));
    } finally {
      setCodexCallbackBusy(false);
    }
  }, [buffer, codexCallbackBusy]);

  const refreshCodexUsage = useCallback(async (
    options: { announce?: boolean; label?: string } = {},
  ): Promise<CodexProfilesStore> => {
    const existing = codexUsageRefreshRef.current;
    if (existing) {
      if (options.announce !== false) setStatus('Codex usage refresh already running; waiting for it.');
      return existing;
    }
    const task = (async () => {
      setBusy(options.label ?? 'Refreshing Codex usage…');
      try {
        const next = await refreshAllCodexProfiles();
        codexStoreRef.current = next;
        setCodexStore(next);
        if (options.announce !== false) setStatus('Codex usage updated.');
        return next;
      } catch (e) {
        const current = loadCodexStore();
        codexStoreRef.current = current;
        setCodexStore(current);
        setStatus(`Codex refresh failed: ${String((e as Error).message ?? e)}`);
        return current;
      } finally {
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
    const fresh = await refreshCodexUsage({ announce: false, label: 'Evaluating Codex Best Now…' });
    const decision = bestNowCodex(fresh.profiles, fresh.activeProfileId);
    const target = decision.target;
    if (!target) {
      if (decision.reason === 'all-exhausted' && decision.nextAvailableAt) {
        const next = fresh.profiles.find((profile) => profile.id === decision.nextAvailableId);
        setStatus(`No Codex account is available. ${next?.label ?? 'Next account'} resets in ${resetIn(new Date(decision.nextAvailableAt).toISOString())}.`);
      } else {
        setStatus(decision.reason === 'no-eligible-account'
          ? 'No usable Codex account is available.'
          : 'Codex quota data is unavailable; press "u" to retry.');
      }
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
      showMessage(result.ok ? `Switched Codex to ${target.label}` : 'Codex switch failed', [result.message], result.ok ? 'success' : 'error');
    } catch (e) {
      setBusy(null);
      showMessage('Codex switch failed', [String((e as Error).message ?? e)], 'error');
    }
  }, [reloadCodexStore, showMessage]);

  const exportSelectedCodex = useCallback(() => {
    if (!codexSelected) return;
    try {
      const file = exportCodexProfile(codexSelected);
      showMessage('Codex account exported', [file, '', 'This file contains login secrets. Keep it private.'], 'success');
    } catch (e) {
      showMessage('Codex export failed', [String((e as Error).message ?? e)], 'error');
    }
  }, [codexSelected, showMessage]);

  const exportAllCodex = useCallback(() => {
    try {
      const file = exportAllCodexProfiles(codexStore);
      showMessage('All Codex accounts exported', [file, '', 'This file contains login secrets. Keep it private.'], 'success');
    } catch (e) {
      showMessage('Codex export failed', [String((e as Error).message ?? e)], 'error');
    }
  }, [codexStore, showMessage]);

  // The running `claude` CLI session (if any) refreshes its OWN token independently
  // while it's alive, which rotates the refresh token server-side and can desync our
  // cached copy for the ACTIVE profile — a background refresh attempt here would then
  // get rejected (invalid_grant) even though the account is perfectly fine live. Re-sync
  // from the live files first (cheap, local-only) before touching the active profile.
  const reconcileActiveIfLive = useCallback((s: ProfilesStore, p: Profile) => {
    if (p.id !== s.activeProfileId) return;
    try {
      const next = mutateStore((fresh) => {
        reconcileWithLive(fresh);
      });
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
      const s = storeRef.current;
      const a = getActive(s);
      if (a) {
        reconcileActiveIfLive(s, a);
        try {
          const info = await fetchUsage(a, claudeVersion, { onRotate, allowRefresh: false });
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
        for (const p of storeRef.current.profiles) {
          if (!hasCliAuth(p) || p.needsReauth) continue;
          // Skip the ACTIVE account: a running `claude` session rotates its token
          // independently, so refreshing our (possibly already-stale) copy here could
          // desync and falsely flag it. The 2-min active-usage interval — which
          // reconciles from the live files first — keeps the active account alive.
          if (p.id === storeRef.current.activeProfileId) continue;
          await keepTokenAlive(p, KEEP_ALIVE_LEAD_MS, rotate);
        }
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
        if (profile.usage?.status === 'ok' && Date.now() - profile.usage.fetchedAt < 10 * 60 * 1000) return;
        try {
          const next = profile.id === current.activeProfileId
            ? (await reconcileLiveCodex(false)).store
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
    options: { announce?: boolean; label?: string } = {},
  ): Promise<ProfilesStore> => {
    const existing = claudeUsageRefreshRef.current;
    if (existing) {
      if (options.announce !== false) setStatus('Usage refresh already running; waiting for it.');
      return existing;
    }
    const task = (async () => {
      setBusy(options.label ?? 'Refreshing usage…');
      try {
        const ids = loadStore().profiles
          .filter((profile) => hasCliAuth(profile) || profile.needsReauth)
          .map((profile) => profile.id);
        for (let index = 0; index < ids.length; index++) {
          let current = loadStore();
          let profile = current.profiles.find((candidate) => candidate.id === ids[index]);
          if (!profile) continue;
          if (profile.id === current.activeProfileId) {
            reconcileActiveIfLive(current, profile);
            current = loadStore();
            profile = current.profiles.find((candidate) => candidate.id === ids[index]);
            if (!profile) continue;
          }
          try {
            const info = await fetchUsage(profile, claudeVersion, {
              force: true,
              onRotate,
              allowRefresh: profile.id !== current.activeProfileId,
            });
            persistUsage(profile.id, info);
          } catch (e) {
            logger.error('usage refresh failed', e, { email: profile.email });
          }
          if (index < ids.length - 1) await sleep(500); // gentle global pacing
        }
        const next = loadStore();
        storeRef.current = next;
        setStore(next);
        if (options.announce !== false) setStatus('Usage is up to date.');
        return next;
      } catch (error) {
        logger.error('manual usage refresh failed', error);
        const current = loadStore();
        storeRef.current = current;
        setStore(current);
        setStatus(`Usage refresh failed: ${String((error as Error).message ?? error)}`);
        return current;
      } finally {
        setBusy(null);
      }
    })();
    claudeUsageRefreshRef.current = task;
    try {
      return await task;
    } finally {
      if (claudeUsageRefreshRef.current === task) claudeUsageRefreshRef.current = null;
    }
  }, [claudeVersion, persistUsage, onRotate, reconcileActiveIfLive]);

  const doSwitch = useCallback(
    async (target: Profile, pids: ProcInfo[]) => {
      setMode('list');
      setBusy(`Switching to ${target.label}…`);
      const lines: string[] = [];

      if (hasCliAuth(target)) {
        // Capture the outgoing (currently live) account's latest tokens first.
        try {
          reconcileWithLive(store);
        } catch (e) {
          logger.error('reconcile before switch failed', e);
        }
        // Proactively refresh the target's token if it's expired, so it works instantly.
        // Routed through the single-flighted ensureFreshToken so it can't race (and burn
        // the token against) a background refresh of this same account.
        let hasFreshToken = false;
        try {
          hasFreshToken = await ensureFreshToken(target, onRotate);
        } catch (e) {
          logger.warn('proactive refresh on switch failed', { email: target.email });
        }
        if (!hasFreshToken || target.needsReauth) {
          setBusy(null);
          showMessage('Switch failed', ['This account login has expired. Re-add it with "a" before switching.'], 'error');
          return;
        }
        const res = applyProfile(target);
        if (!res.ok) {
          setBusy(null);
          showMessage('Switch failed', [res.error ?? 'unknown error', 'Your previous account was restored from backup.'], 'error');
          return;
        }
        const autoClose = store.closeClaudeOnSwitch ?? true;
        const { closed, failed } =
          autoClose && pids.length ? closeProcesses(pids.map((p) => p.pid)) : { closed: [] as number[], failed: [] as number[] };
        lines.push(
          target.needsReauth ? '⚠ This account\'s login has expired — it may not work. Re-add it with "a".' : '',
          `Claude Code CLI: now authenticated as ${target.email} (${target.subscriptionType ?? 'unknown plan'})`,
          autoClose
            ? closed.length
              ? `• Closed ${closed.length} running claude CLI process(es) — just relaunch \`claude\`.`
              : '• No running claude CLI process was found to close.'
            : '• Auto-close is OFF: close/relaunch your open `claude` CLI sessions yourself.',
          failed.length ? `• Could not close: ${failed.join(', ')} (close them manually).` : '',
        );
      }

      if (target.desktopSnapshotDir) {
        const res = applyDesktopSnapshot(target.desktopSnapshotDir);
        if (!res.ok) {
          setBusy(null);
          showMessage('Desktop switch failed', [res.error ?? 'unknown error', 'Your previous Desktop session was restored from backup.'], 'error');
          return;
        }
        lines.push('', `Claude Desktop: session swapped to ${target.email}. Reopen Claude Desktop when ready.`);
      }

      setBusy(null);
      const next = mutateStore((fresh) => {
        const persisted = fresh.profiles.find((profile) => profile.id === target.id);
        if (persisted) {
          persisted.lastUsedAt = Date.now();
          persisted.updatedAt = Date.now();
          fresh.activeProfileId = persisted.id;
        }
      });
      storeRef.current = next;
      setStore(next);
      showMessage(
        `Switched to ${target.label}`,
        [...lines, '', 'This switcher stays open — no web login needed.'].filter(Boolean),
        'success',
      );
    },
    [store, showMessage],
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
      }
      setPendingSwitch({ profile: target, pids });
      setStatus('');
      setMode('confirmSwitch');
    },
    [],
  );

  const chooseBestClaudeNow = useCallback(async () => {
    const fresh = await refreshAllUsage({ announce: false, label: 'Evaluating Claude Best Now…' });
    const decision = bestNow(fresh.profiles, fresh.activeProfileId);
    const target = decision.target;
    if (!target) {
      if (decision.reason === 'all-exhausted' && decision.nextAvailableAt) {
        const next = fresh.profiles.find((profile) => profile.id === decision.nextAvailableId);
        setStatus(`No Claude account is available. ${next?.label ?? 'Next account'} resets in ${resetIn(new Date(decision.nextAvailableAt).toISOString())}.`);
      } else {
        setStatus(decision.reason === 'no-eligible-account'
          ? 'No usable Claude account is available.'
          : 'Claude quota data is unavailable; press "u" to retry.');
      }
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
      setMode('adding');
      setBuffer('');
      setAddBusy(false);
      claudeReauthEmailRef.current = reauthEmail ?? null;
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
          'Esc cancels without changing any account.',
        ]);
      } catch (e) {
        authRef.current = null;
        showMessage('Could not start Claude authorization', [String((e as Error)?.message ?? e)], 'error');
      }
    },
    [showMessage],
  );

  const submitAddCode = useCallback(async () => {
    const auth = authRef.current;
    const pastedCode = buffer.trim();
    if (!auth || !pastedCode || addBusy) return;
    setAddBusy(true);
    setAddLines(['Exchanging the Claude authorization code…']);
    try {
      const tokens = await exchangeCode(pastedCode, auth.verifier, auth.state);
      setAddLines(['Resolving the Claude account identity in an isolated profile…']);
      const ident = primeIdentity(tokens, findClaudeExe(), DEFAULT_SCOPES);
      const fields = identityToFields(ident);
      if (claudeReauthEmailRef.current && fields.email === '(new account)') {
        fields.email = claudeReauthEmailRef.current;
        fields.oauthAccount.emailAddress = claudeReauthEmailRef.current;
      }
      let profile: Profile | undefined;
      const live = getLiveAccount();
      const next = mutateStore((fresh) => {
        profile = addOrUpdateProfile(fresh, fields);
        const liveMatches = hasRefreshableOauth(live.claudeAiOauth)
          && !!live.oauthAccount?.accountUuid
          && live.oauthAccount.accountUuid === profile.accountUuid;
        if (fresh.activeProfileId === profile.id && !liveMatches) fresh.activeProfileId = null;
      });
      if (!profile) throw new Error('Claude account was not added after authorization.');
      authRef.current = null;
      claudeReauthEmailRef.current = null;
      storeRef.current = next;
      setStore(next);
      setCursor(next.profiles.findIndex((candidate) => candidate.id === profile!.id));
      setBuffer('');
      setAddBusy(false);
      showMessage(
        'Claude account added',
        [
          `${profile.label} (${profile.email})`,
          `Plan: ${profile.subscriptionType ?? 'unknown'}`,
          '',
          next.activeProfileId === profile.id ? 'This account is already live.' : 'Select it and press Enter to apply it to Claude.',
        ],
        'success',
      );
    } catch (error) {
      authRef.current = null;
      claudeReauthEmailRef.current = null;
      setAddBusy(false);
      showMessage(
        'Claude authorization failed',
        [String((error as Error).message ?? error), '', 'The existing accounts were not changed. Press a to start a fresh authorization.'],
        'error',
      );
    }
  }, [addBusy, buffer, showMessage]);

  const startCaptureDesktop = useCallback(() => {
    if (!isDesktopInstalled()) {
      setStatus('Claude Desktop data folder was not found on this machine.');
      return;
    }
    setBuffer('');
    setMode('capturingDesktopConfirm');
  }, []);

  const finalizeDesktopCapture = useCallback(
    (email: string) => {
      setDesktopBusy(true);
      try {
        let p: Profile | undefined;
        const next = mutateStore((fresh) => {
          p = captureDesktopAccount(fresh, desktopLabelRef.current, email);
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
            'Usage/quota is not available for Desktop accounts (tokens are OS-encrypted).',
            'This session is tied to this machine — it cannot be exported/imported to another PC.',
          ],
          'success',
        );
      } catch (e) {
        showMessage('Capture failed', [String((e as Error)?.message ?? e)], 'error');
      } finally {
        setDesktopBusy(false);
        setBuffer('');
      }
    },
    [showMessage],
  );

  const openImportMenu = useCallback(() => {
    let cands: ImportCandidate[] = [];
    try {
      cands = scanImportDir();
    } catch (e) {
      logger.error('scanImportDir failed', e);
    }
    setImportCands(cands);
    setImportCursor(0);
    setMode('importMenu');
  }, []);

  const doImport = useCallback(
    (cand: ImportCandidate) => {
      try {
        let p: Profile | undefined;
        const next = mutateStore((fresh) => {
          p = addOrUpdateProfile(fresh, cand.fields, cand.label);
        });
        if (!p) throw new Error('Claude account was not imported.');
        storeRef.current = next;
        setStore(next);
        setCursor(next.profiles.findIndex((x) => x.id === p!.id));
        setMode('list');
        setStatus(`Imported "${p.label}" (${p.email}).`);
      } catch (e) {
        showMessage('Import failed', [String((e as Error)?.message ?? e)], 'error');
      }
    },
    [showMessage],
  );

  const exportSelected = useCallback(() => {
    if (!selected) return;
    try {
      const file = exportProfile(selected);
      clipboard.write(file).catch(() => {});
      showMessage(
        'Exported',
        ['Portable file written (path copied to clipboard):', '', file, '', 'Copy it to another PC and press "i" (Import) there.'],
        'success',
      );
    } catch (e) {
      showMessage('Export failed', [String((e as Error)?.message ?? e)], 'error');
    }
  }, [selected, showMessage]);

  const exportAllAccounts = useCallback(() => {
    if (!store.profiles.length) {
      setStatus('No accounts to export.');
      return;
    }
    try {
      const file = exportAllProfiles(store);
      clipboard.write(file).catch(() => {});
      showMessage(
        'Exported all accounts (full backup)',
        [
          `${store.profiles.length} account(s) written to one file (path copied):`,
          '',
          file,
          '',
          'Copy it to another PC and press "i" (Import) to restore every account.',
        ],
        'success',
      );
    } catch (e) {
      showMessage('Export failed', [String((e as Error)?.message ?? e)], 'error');
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
      if (provider === 'codex') {
        if (key.upArrow || input === 'k') {
          setCodexCursor((c) => codexProfiles.length ? (c > 0 ? c - 1 : codexProfiles.length - 1) : 0);
        } else if (key.downArrow || input === 'j') {
          setCodexCursor((c) => codexProfiles.length ? (c < codexProfiles.length - 1 ? c + 1 : 0) : 0);
        } else if (key.return && codexSelected) beginCodexSwitch(codexSelected);
        else if (input === 'a') void startCodexAdd();
        else if (input === 'i') {
          setBuffer('');
          setMode('codexImportPath');
        } else if (input === 'e') exportSelectedCodex();
        else if (input === 'E') exportAllCodex();
        else if (input === 'r' && codexSelected) {
          setBuffer(codexSelected.label);
          setMode('codexRename');
        } else if (input === 'd' && codexSelected) {
          if (codexSelected.id === codexStore.activeProfileId) setStatus('Cannot delete the active Codex account. Switch away first.');
          else setMode('codexConfirmDelete');
        } else if (input === 'z') {
          const before = codexStore.profiles.length;
          const next = restoreLatestDeletedCodexProfile();
          setCodexStore(next);
          if (next.profiles.length > before) {
            setCodexCursor(next.profiles.length - 1);
            setStatus(`Restored archived Codex profile "${next.profiles.at(-1)?.label}".`);
          } else setStatus('No archived Codex profile to restore.');
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
      if (key.upArrow || input === 'k') setCursor((c) => (c > 0 ? c - 1 : profiles.length - 1));
      else if (key.downArrow || input === 'j') setCursor((c) => (c < profiles.length - 1 ? c + 1 : 0));
      else if (key.return) {
        if (selected) beginSwitch(selected);
      } else if (input === 'a') void startAdd(selected?.needsReauth ? selected.email : undefined);
      else if (input === 'A') startCaptureDesktop();
      else if (input === 'i') openImportMenu();
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
        try {
          setCodexStore(deleteCodexProfile(codexSelected.id));
          setCodexCursor((c) => Math.max(0, Math.min(c, codexProfiles.length - 2)));
          setStatus(`Archived Codex profile "${label}". Press z to restore it.`);
        } catch (error) {
          setStatus(`Codex archive failed: ${String((error as Error).message ?? error)}`);
        }
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

    if (mode === 'codexImportPath') {
      if (key.return) {
        try {
          const imported = importCodexFromPath(buffer.trim());
          reloadCodexStore();
          setMode('list');
          setStatus(`Imported ${imported.length} Codex account(s).`);
        } catch (e) {
          setStatus(`Codex import failed: ${String((e as Error).message ?? e)}`);
        }
      } else if (key.escape) setMode('list');
      else if (key.backspace || key.delete) setBuffer((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuffer((value) => value + input);
      return;
    }

    if (mode === 'confirmSwitch') {
      if (input === 'y' || key.return) {
        if (pendingSwitch) void doSwitch(pendingSwitch.profile, pendingSwitch.pids);
      } else if (input === 'c') {
        const next = mutateStore((fresh) => {
          fresh.closeClaudeOnSwitch = !(fresh.closeClaudeOnSwitch ?? true);
        });
        storeRef.current = next;
        setStore(next);
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
            const next = mutateStore((fresh) => deleteProfile(fresh, selected.id));
            storeRef.current = next;
            setStore(next);
            setCursor((c) => Math.max(0, Math.min(c, next.profiles.length - 1)));
            setStatus(`Archived "${label}". Press z to restore it.`);
          } catch (error) {
            setStatus(`Archive failed: ${String((error as Error).message ?? error)}`);
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
      const total = importCands.length;
      if (key.upArrow) setImportCursor((c) => (c > 0 ? c - 1 : Math.max(0, total - 1)));
      else if (key.downArrow) setImportCursor((c) => (c < total - 1 ? c + 1 : 0));
      else if (key.return) {
        if (importCands[importCursor]) doImport(importCands[importCursor]);
      } else if (input === 'o') {
        openFolder(importDir());
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
        const target = buffer.trim().replace(/^"(.*)"$/, '$1');
        if (target) {
          const cands = importFromPath(target);
          if (cands.length) {
            try {
              const next = mutateStore((fresh) => {
                cands.forEach((c) => addOrUpdateProfile(fresh, c.fields, c.label));
              });
              storeRef.current = next;
              setStore(next);
              setMode('list');
              setStatus(`Imported ${cands.length} account(s) from path.`);
            } catch (e) {
              showMessage('Import failed', [String((e as Error)?.message ?? e)], 'error');
            }
          } else {
            setStatus('Nothing importable at that path.');
            setMode('importMenu');
          }
        } else {
          setMode('importMenu');
        }
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
      if (addBusy) return;
      if (key.escape) {
        authRef.current = null;
        claudeReauthEmailRef.current = null;
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
        finalizeDesktopCapture(buffer.trim());
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
      return;
    }

    if (mode === 'message') {
      if (key.return || key.escape || input === 'q') {
        setMessage(null);
        setMode('list');
      }
      return;
    }
  });

  // ---------- rendering ----------
  const tone = message?.tone === 'success' ? 'green' : message?.tone === 'error' ? 'red' : 'cyan';
  const W = Math.max(72, Math.min(cols - 1, 150));
  const emailW = Math.max(16, W - (4 + 18 + 8 + 6 + 12 + 12 + 11));
  const leftW = Math.min(42, Math.max(24, Math.floor((W - 4) * 0.4)));
  const claudeBest = bestNow(profiles, store.activeProfileId);
  const codexBest = bestNowCodex(codexProfiles, codexStore.activeProfileId);
  const providerColor = provider === 'claude' ? CLAUDE_ORANGE : CODEX_BLUE;
  const providerName = provider === 'claude' ? 'Claude' : 'Codex';

  return (
    <Box flexDirection="column">
      <Box width={W} justifyContent="center">
        <Text dimColor={provider !== 'claude'} color={provider === 'claude' ? CLAUDE_ORANGE : undefined}>← Claude</Text>
        <Text dimColor>  │  </Text>
        <Text dimColor={provider !== 'codex'} color={provider === 'codex' ? CODEX_BLUE : undefined}>Codex →</Text>
      </Box>
      {mode === 'list' ? (provider === 'claude' ? (
        <Box width={W} borderStyle="round" borderColor={CLAUDE_ORANGE} paddingX={1} flexDirection="column">
          <Text bold>
            <Text color={CLAUDE_ORANGE}>Claude</Text> <Text color="white">Account Switch</Text>{' '}
            <Text dimColor>v{APP_VERSION}</Text>
            {newVersion ? <Text color="yellow"> · update available (v{newVersion})</Text> : null}
          </Text>
          <Box marginTop={1} width={W - 2}>
            <Box width={leftW} flexDirection="column" alignItems="center">
              <Box flexDirection="column">
                <Text color={CLAUDE_ORANGE}>{' ▐▛███▜▌'}</Text>
                <Text color={CLAUDE_ORANGE}>{'▝▜█████▛▘'}</Text>
                <Text color={CLAUDE_ORANGE}>{'  ▘▘ ▝▝'}</Text>
              </Box>
              <Box marginTop={1} flexDirection="column" alignItems="center">
                <Text>
                  Welcome back, <Text bold color="white">{active ? active.label : 'there'}</Text>!
                </Text>
                {active ? (
                  <Text>
                    <Text color={planColor(active.subscriptionType)}>
                      Claude {(active.subscriptionType ?? '').toUpperCase()}
                    </Text>
                    <Text dimColor> · {active.email}</Text>
                  </Text>
                ) : (
                  <Text dimColor>No account selected</Text>
                )}
              </Box>
            </Box>
            <Box
              flexDirection="column"
              flexGrow={1}
              borderStyle="single"
              borderColor="gray"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              paddingLeft={2}
            >
              <Text bold color="white">
                Your accounts <Text dimColor>· {profiles.length} saved</Text>
              </Text>
              {selected ? (
                <Box marginTop={1} flexDirection="column">
                  <Text>
                    <Text dimColor>{selected.id === store.activeProfileId ? 'active ' : 'viewing '}</Text>
                    <Text color={selected.id === store.activeProfileId ? 'green' : 'cyanBright'}>●</Text>{' '}
                    <Text bold color="white">{selected.label}</Text>{' '}
                    <Text color={planColor(selected.subscriptionType)}>{(selected.subscriptionType ?? '').toUpperCase()}</Text>
                  </Text>
                  {!hasCliAuth(selected) ? (
                    selected.needsReauth ? (
                      <Text color="red">{'   ⚠ login expired — press "a" to re-add this account'}</Text>
                    ) : (
                      <Text dimColor>{'   Desktop-only account — usage not available'}</Text>
                    )
                  ) : selected.usage && (selected.usage.status === 'ok' || selected.usage.status === 'stale') ? (
                    <>
                      <Text>
                        {'   5h  '}
                        <Text color={utilColor(selected.usage.five_hour?.utilization ?? null)}>
                          {fmtPct(selected.usage.five_hour?.utilization).padEnd(5)}
                        </Text>
                        <Text dimColor>{quotaResetLabel(selected.usage.five_hour?.utilization, selected.usage.five_hour?.resets_at)}</Text>
                      </Text>
                      <Text>
                        {'   7d  '}
                        <Text color={utilColor(selected.usage.seven_day?.utilization ?? null)}>
                          {fmtPct(selected.usage.seven_day?.utilization).padEnd(5)}
                        </Text>
                        <Text dimColor>{quotaResetLabel(selected.usage.seven_day?.utilization, selected.usage.seven_day?.resets_at)}</Text>
                      </Text>
                      {selected.needsReauth ? (
                        <Text color="red">{'   ⚠ login expired — press "a" to re-add (numbers are last-known)'}</Text>
                      ) : selected.usage.status === 'stale' ? (
                        <Text dimColor>{selected.needsReauth ? '   (cached — login renewal required)' : '   (cached — live refresh unavailable)'}</Text>
                      ) : null}
                      {/* PROMO: Fable 50% through 2026-07-19 — auto-hidden at FABLE_PROMO_END. */}
                      {(() => {
                        if (Date.now() >= FABLE_PROMO_END) return null;
                        const fable = selected.usage.models?.find((m) => /fable/i.test(m.name));
                        if (!fable) return null;
                        return (
                          <Text>
                            {'   Fable '}
                            <Text color={utilColor(fable.utilization)}>{fmtPct(fable.utilization).padEnd(5)}</Text>
                            <Text dimColor>promo (through Jul 19)</Text>
                          </Text>
                        );
                      })()}
                    </>
                  ) : selected.needsReauth ? (
                    <Text color="red">{'   ⚠ login expired — press "a" to re-add this account'}</Text>
                  ) : selected.usage?.status === 'rate_limited' ? (
                    <Text dimColor>{'   rate-limited — usage will refresh shortly'}</Text>
                  ) : (
                    <Text dimColor>{'   loading usage… (press u to force refresh)'}</Text>
                  )}
                </Box>
              ) : null}
              {claudeBest.target ? (
                <Text>
                  <Text dimColor>best now: </Text>
                  <Text color="green">{claudeBest.target.label}</Text>
                  <Text dimColor> · {bestNowDetail(claudeBest)}</Text>
                </Text>
              ) : claudeBest.reason === 'all-exhausted' && claudeBest.nextAvailableAt ? (
                <Text dimColor>best now: none · next reset in {resetIn(new Date(claudeBest.nextAvailableAt).toISOString())}</Text>
              ) : null}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box width={W} borderStyle="round" borderColor={CODEX_BLUE} paddingX={1} flexDirection="column">
          <Text bold><Text color={CODEX_BLUE}>Codex</Text> <Text color="white">Account Switch</Text>{' '}<Text dimColor>v{APP_VERSION}</Text></Text>
          <Box marginTop={1} width={W - 2}>
            <Box width={leftW} flexDirection="column" alignItems="center">
              <CodexTerminalMark />
              <Box marginTop={1} flexDirection="column" alignItems="center">
                <Text>Welcome back, <Text bold>{codexActive?.label ?? 'there'}</Text>!</Text>
                {codexActive ? <Text><Text color={planColor(codexActive.planType)}>Codex {(codexActive.planType ?? '').toUpperCase()}</Text><Text dimColor> · {codexActive.email}</Text></Text> : <Text dimColor>No Codex account selected</Text>}
              </Box>
            </Box>
            <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" borderTop={false} borderRight={false} borderBottom={false} paddingLeft={2}>
              <Text bold>Your Codex accounts <Text dimColor>· {codexProfiles.length} saved</Text></Text>
              {codexSelected ? (
                <Box marginTop={1} flexDirection="column">
                  <Text><Text dimColor>{codexSelected.id === codexStore.activeProfileId ? 'active ' : 'viewing '}</Text><Text color={codexSelected.id === codexStore.activeProfileId ? 'green' : 'cyanBright'}>●</Text>{' '}<Text bold>{codexSelected.label}</Text>{' '}<Text color={planColor(codexSelected.planType)}>{(codexSelected.planType ?? '').toUpperCase()}</Text></Text>
                  {codexSelected.usage?.bucket ? (
                    <>
                      <Text>{'   5h  '}<Text color={utilColor(codexSelected.usage.bucket.primary?.usedPercent ?? null)}>{fmtPct(codexSelected.usage.bucket.primary?.usedPercent).padEnd(5)}</Text><Text dimColor>{quotaResetLabel(codexSelected.usage.bucket.primary?.usedPercent, codexSelected.usage.bucket.primary?.resetsAt ? new Date(codexSelected.usage.bucket.primary.resetsAt * 1000).toISOString() : null)}</Text></Text>
                      <Text>{'   7d  '}<Text color={utilColor(codexSelected.usage.bucket.secondary?.usedPercent ?? null)}>{fmtPct(codexSelected.usage.bucket.secondary?.usedPercent).padEnd(5)}</Text><Text dimColor>{quotaResetLabel(codexSelected.usage.bucket.secondary?.usedPercent, codexSelected.usage.bucket.secondary?.resetsAt ? new Date(codexSelected.usage.bucket.secondary.resetsAt * 1000).toISOString() : null)}</Text></Text>
                      {codexSelected.usage.status === 'stale' ? <Text dimColor>{'   cached — live refresh unavailable'}</Text> : null}
                    </>
                  ) : codexSelected.needsReauth ? <Text color="red">{'   ⚠ login expired — press "a" to add the account again'}</Text> : <Text dimColor>{'   press u to load Codex usage'}</Text>}
                </Box>
              ) : null}
              {codexBest.target ? <Text><Text dimColor>best now: </Text><Text color="green">{codexBest.target.label}</Text><Text dimColor> · {bestNowDetail(codexBest)}</Text></Text> : codexBest.reason === 'all-exhausted' && codexBest.nextAvailableAt ? <Text dimColor>best now: none · next reset in {resetIn(new Date(codexBest.nextAvailableAt).toISOString())}</Text> : null}
            </Box>
          </Box>
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

      {mode === 'message' && message ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
          <Text bold color={tone}>
            {message.tone === 'success' ? '✓ ' : message.tone === 'error' ? '✗ ' : ''}
            {message.title}
          </Text>
          {message.lines.map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>[Enter] back</Text>
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
              {'  • '}An <Text bold>automatic keep-alive</Text> (every 6h) to refresh tokens before access expiry —
            </Text>
            <Text>{'    '}and warn when Anthropic requires a real /login renewal.</Text>
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
            <Text dimColor>Enter validates the code · Esc cancels</Text>
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
        <Box width={W} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyanBright">
            Import an account from another PC
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="cyan">1.</Text> <Text bold>On the OTHER computer</Text>, copy these 2 files:
            </Text>
            <Text>
              {'     '}
              <Text color="yellow">%USERPROFILE%\.claude\.credentials.json</Text>
            </Text>
            <Text>
              {'     '}
              <Text color="yellow">%USERPROFILE%\.claude.json</Text>
            </Text>
            <Text dimColor>{'     '}(macOS/Linux: ~/.claude/.credentials.json and ~/.claude.json)</Text>
            <Text dimColor>{'     '}(macOS keeps tokens in Keychain — there, run this tool and press "e" to export)</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="cyan">2.</Text> Put them in this folder on <Text bold>THIS</Text> PC:
            </Text>
            <Text color="green">{'     '}{importDir()}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="cyan">3.</Text> Detected accounts to import:
            </Text>
            {importCands.length === 0 ? (
              <Text dimColor>{'     '}(none yet — press "o" to open the folder, then "r" to rescan)</Text>
            ) : (
              importCands.map((c, i) => (
                <Text key={i} color={i === importCursor ? 'greenBright' : undefined}>
                  {i === importCursor ? '   ❯ ' : '     '}
                  <Text bold={i === importCursor}>{c.fields.email}</Text> <Text dimColor>— {c.source}</Text>
                </Text>
              ))
            )}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑/↓ select · ⏎ import · o open folder · r rescan · p type path · Esc back</Text>
          </Box>
        </Box>
      ) : mode === 'codexImportPath' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor={CODEX_BLUE} paddingX={1}>
          <Text bold color={CODEX_BLUE}>Import Codex account</Text>
          <Text>Path: <Text color="green">{buffer}</Text><Text>▎</Text></Text>
          <Box marginTop={1}><Text dimColor>Enter to import an auth.json or .codexswitch.json · Esc to cancel</Text></Box>
        </Box>
      ) : mode === 'importPath' ? (
        <Box width={W} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">
            Import — type a file or folder path
          </Text>
          <Text>
            Path: <Text color="green">{buffer}</Text>
            <Text>▎</Text>
          </Text>
          <Box marginTop={1}>
            <Text dimColor>Enter to import · Esc to go back</Text>
          </Box>
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
                {'    '}{pad('ACCOUNT', 18)}{pad('LINKED', 8)}{pad('EMAIL', emailW)}{pad('PLAN', 6)}{pad('5-HOUR', 12)}{pad('7-DAY', 12)}{'LAST ACTIVE'}
              </Text>
              {codexProfiles.map((profile, i) => {
                const isActive = profile.id === codexStore.activeProfileId;
                const isCursor = i === codexCursor;
                return (
                  <Box key={profile.id}>
                    <Text color={CODEX_BLUE} bold>{isCursor ? '❯ ' : '  '}</Text>
                    <Text color={profile.needsReauth ? 'red' : isActive ? 'green' : 'gray'}>{profile.needsReauth ? '⚠' : isActive ? '●' : '○'}{' '}</Text>
                    <Text bold={isCursor} color={profile.needsReauth ? 'red' : isCursor ? 'white' : undefined}>{pad(profile.label, 18)}</Text>
                    <Text dimColor>{pad('APP+CLI', 8)}</Text>
                    <Text dimColor>{pad(profile.email, emailW)}</Text>
                    <Text color={planColor(profile.planType)}>{pad((profile.planType ?? '?').toUpperCase(), 6)}</Text>
                    <UsageCell win={profile.usage?.bucket?.primary ? { utilization: profile.usage.bucket.primary.usedPercent } : null} />
                    <UsageCell win={profile.usage?.bucket?.secondary ? { utilization: profile.usage.bucket.secondary.usedPercent } : null} />
                    {isActive ? <Text color="green">{pad('in use', 11)}</Text> : <Text dimColor>{pad(relTime(profile.lastUsedAt), 11)}</Text>}
                  </Box>
                );
              })}
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
                {'    '}
                {pad('ACCOUNT', 18)}
                {pad('LINKED', 8)}
                {pad('EMAIL', emailW)}
                {pad('PLAN', 6)}
                {pad('5-HOUR', 12)}
                {pad('7-DAY', 12)}
                {'LAST ACTIVE'}
              </Text>
              {profiles.map((p, i) => {
                const isActive = p.id === store.activeProfileId;
                const isCursor = i === cursor;
                const linked = [hasCliAuth(p) ? 'CLI' : null, p.desktopSnapshotDir ? 'DSK' : null].filter(Boolean).join('+');
                return (
                  <Box key={p.id}>
                    <Text color="cyanBright" bold>
                      {isCursor ? '❯ ' : '  '}
                    </Text>
                    <Text color={p.needsReauth ? 'red' : isActive ? 'green' : 'gray'}>
                      {p.needsReauth ? '⚠' : isActive ? '●' : '○'}{' '}
                    </Text>
                    <Text bold={isCursor} color={p.needsReauth ? 'red' : isCursor ? 'white' : undefined}>
                      {pad(p.label, 18)}
                    </Text>
                    <Text dimColor>{pad(linked, 8)}</Text>
                    <Text dimColor>{pad(p.email, emailW)}</Text>
                    <Text color={planColor(p.subscriptionType)}>{pad((p.subscriptionType ?? '?').toUpperCase(), 6)}</Text>
                    <UsageCell win={p.usage?.five_hour} />
                    <UsageCell win={p.usage?.seven_day} />
                    {isActive ? (
                      <Text color="green">{pad('in use', 11)}</Text>
                    ) : (
                      <Text dimColor>{pad(relTime(p.lastUsedAt), 11)}</Text>
                    )}
                  </Box>
                );
              })}
            </>
          )}

          {mode === 'confirmSwitch' && pendingSwitch ? (
            <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold color="yellow">
                Switch to "{pendingSwitch.profile.label}" ({pendingSwitch.profile.email})?
              </Text>
              {hasCliAuth(pendingSwitch.profile) ? (
                (store.closeClaudeOnSwitch ?? true) ? (
                  pendingSwitch.pids.length ? (
                    <Text>
                      Will close {pendingSwitch.pids.length} running claude process(es):{' '}
                      <Text color="yellow">{pendingSwitch.pids.map((p) => p.pid).join(', ')}</Text>{' '}
                      <Text dimColor>(this terminal stays open)</Text>
                    </Text>
                  ) : (
                    <Text dimColor>No running claude processes detected.</Text>
                  )
                ) : (
                  <Text dimColor>Auto-close is OFF — you'll reload your Claude Code sessions yourself.</Text>
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
                <Text color="yellow">[c]</Text>
                <Text dimColor> auto-close claude: </Text>
                <Text color={(store.closeClaudeOnSwitch ?? true) ? 'green' : 'gray'}>
                  {(store.closeClaudeOnSwitch ?? true) ? 'ON' : 'OFF'}
                </Text>
                <Text dimColor> · [n] cancel</Text>
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
        {busy ? <Spinner label={busy} /> : status ? <Text color="yellow">{status}</Text> : null}
        {mode === 'list' ? (
          <>
            <Text dimColor>
              <Text color="cyan">↑/↓</Text> move · <Text color="cyan">⏎</Text> switch · <Text color="cyan">b</Text>{' '}
              best-now · <Text color="cyan">l</Text> least-loaded · <Text color="cyan">u</Text> refresh
            </Text>
            {provider === 'claude' ? (
              <Text dimColor>
                <Text color="cyan">a</Text> add · <Text color="cyan">A</Text> add Desktop · <Text color="cyan">i</Text> import ·{' '}
                <Text color="cyan">e</Text> export · <Text color="cyan">E</Text> export-all · <Text color="cyan">r</Text> rename ·{' '}
                <Text color="cyan">d</Text> archive · <Text color="cyan">z</Text> restore · <Text color="cyan">S</Text> setup · <Text color="cyan">q</Text> quit
              </Text>
            ) : (
              <Text dimColor>
                <Text color={CODEX_BLUE}>a</Text> add · <Text color={CODEX_BLUE}>i</Text> import · <Text color={CODEX_BLUE}>e</Text> export ·{' '}
                <Text color={CODEX_BLUE}>E</Text> export-all · <Text color={CODEX_BLUE}>r</Text> rename · <Text color={CODEX_BLUE}>d</Text> archive ·{' '}
                <Text color={CODEX_BLUE}>z</Text> restore ·{' '}
                <Text color={CODEX_BLUE}>S</Text> setup · <Text color={CODEX_BLUE}>q</Text> quit
              </Text>
            )}
          </>
        ) : null}
        <Text dimColor>log: {logFile()}</Text>
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
  switch.cmd export-all [claude|codex]
  switch.cmd doctor [all|claude|codex]  Diagnose accounts without printing secrets
  switch.cmd --dry-run       Show exactly which keys a switch would change (no writes)
  switch.cmd restore         Roll back the last credential change from backup
  switch.cmd install         Set up shortcuts + auto keep-alive (feels like a real app)
  switch.cmd uninstall       Remove shortcuts + the scheduled keep-alive job
  switch.cmd keep-alive          Refresh due tokens now and report accounts needing renewal
  switch.cmd keep-alive install  Schedule keep-alive only (no shortcuts)
  switch.cmd --help          This help

Data & logs live in ~/.claude-switch/`);
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

function printClaudeDoctor(): void {
  const store = loadStore();
  console.log(`Claude provider`);
  console.log(`Claude Code version: ${detectClaudeVersion()}`);
  console.log(`Profiles: ${store.profiles.length}`);
  console.log(`Restorable archives: ${(store.tombstones ?? []).filter((t) => t.archivedProfile?.provider === 'claude' && (!t.restoredAt || t.deletedAt > t.restoredAt)).length}`);
  console.log(`Active profile id: ${store.activeProfileId ?? '(none)'}`);

  const envAuth = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']
    .filter((k) => !!process.env[k]);
  console.log(`Auth env override: ${envAuth.length ? envAuth.join(', ') : 'none'}`);

  const live = getLiveAccount();
  const liveOauth = live.claudeAiOauth;
  console.log('\nLive Claude files:');
  console.log(`  email: ${live.oauthAccount?.emailAddress ?? '(unknown)'}`);
  console.log(`  refreshable: ${hasRefreshableOauth(liveOauth) ? 'yes' : 'NO'}`);
  console.log(`  access token: ${liveOauth?.accessToken ? `present, expires ${relMs(asTime(liveOauth.expiresAt))}` : 'missing'}`);
  console.log(`  login expiry: ${relMs(asTime(liveOauth?.refreshTokenExpiresAt))}`);

  console.log('\nSaved profiles:');
  for (const p of store.profiles) {
    const oauth = p.claudeAiOauth;
    const refreshable = hasCliAuth(p);
    const flags = [
      p.id === store.activeProfileId ? 'active' : null,
      p.needsReauth ? 'needs re-add' : null,
      refreshable ? 'cli' : null,
      p.desktopSnapshotDir ? 'desktop' : null,
    ].filter(Boolean).join(', ') || 'saved';
    console.log(`  - ${p.label} <${p.email}> [${flags}]`);
    console.log(`    access: ${oauth?.accessToken ? relMs(asTime(oauth.expiresAt)) : 'missing'}; login: ${relMs(asTime(oauth?.refreshTokenExpiresAt))}; usage: ${usageAge(p)}`);
  }
}

async function printCodexDoctor(): Promise<void> {
  const store = loadCodexStore();
  const pending = listPendingCodexHomes();
  console.log(`Codex`);
  console.log(`Codex version: ${detectCodexVersion()}`);
  console.log(`Profiles: ${store.profiles.length}`);
  console.log(`Restorable archives: ${store.tombstones.filter((t) => t.archivedProfile?.provider === 'codex' && (!t.restoredAt || t.deletedAt > t.restoredAt)).length}`);
  console.log(`Active profile id: ${store.activeProfileId ?? '(none)'}`);
  console.log(`Abandoned/pending login sandboxes: ${pending.length}`);
  const liveAuth = readCodexAuth(codexHome());
  const savedLiveProfile = liveAuth
    ? store.profiles.find((profile) => profile.accountId === liveAuth.tokens.account_id)
    : null;
  try {
    const live = await inspectCodexHome(codexHome(), false);
    if (liveAuth) {
      const email = live.account?.email ?? savedLiveProfile?.email ?? '(unknown)';
      const plan = live.account?.planType ?? savedLiveProfile?.planType ?? 'unknown plan';
      console.log(`Live account: ${email} (${plan})`);
    } else {
      console.log('Live account: not logged in with ChatGPT');
    }
  } catch (e) {
    if (liveAuth) {
      console.log(`Live account: ${savedLiveProfile?.email ?? '(managed ChatGPT auth saved)'} (status check unavailable)`);
    } else {
      console.log(`Live account: unavailable (${String((e as Error).message ?? e)})`);
    }
  }
  console.log('Saved profiles:');
  for (const profile of store.profiles) {
    const bucket = profile.usage?.bucket;
    const flags = [profile.id === store.activeProfileId ? 'active' : null, profile.needsReauth ? 'needs re-add' : null]
      .filter(Boolean).join(', ') || 'saved';
    console.log(`  - ${profile.label} <${profile.email}> [${flags}] plan=${profile.planType ?? 'unknown'}`);
    console.log(`    usage: ${profile.usage?.status ?? 'never'}; 5h=${bucket?.primary?.usedPercent ?? '?'}%; 7d=${bucket?.secondary?.usedPercent ?? '?'}%`);
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
 * scheduler (see keep-alive install). The ACTIVE account is always left to the official
 * Claude client: refreshing it here can invalidate a rotating token held by a live session.
 */
async function runKeepAliveOnce(): Promise<void> {
  let store = loadStore();
  if (!store.profiles.length) {
    console.log('keep-alive: no accounts saved.');
    return;
  }
  const LEAD_MS = 60 * 60 * 1000; // refresh anything expiring within the next hour
  if (getActive(store)) {
    try {
      store = mutateStore((fresh) => {
        reconcileWithLive(fresh);
      });
    } catch {
      /* continue with saved credentials */
    }
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
    const isActive = p.id === store.activeProfileId;
    if (isActive) continue; // the official Claude client exclusively owns live token rotation
    const before = p.claudeAiOauth.refreshToken;
    await keepTokenAlive(p, LEAD_MS, onRotate);
    if (p.claudeAiOauth.refreshToken !== before) refreshed++;
    if (p.needsReauth) dead++;
  }
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
  const args = process.argv.slice(2);

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
    if (scope === 'all' || scope === 'claude') printClaudeDoctor();
    if (scope === 'all') console.log('');
    if (scope === 'all' || scope === 'codex') await printCodexDoctor();
    return;
  }

  if (args[0] === 'restore') {
    const dir = restoreLatestBackup();
    console.log(dir ? `Restored credentials from backup: ${dir}` : 'No backups found.');
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
    await runKeepAliveOnce();
    try {
      const codexRunning = findCodexProcesses().length > 0;
      const codex = await refreshAllCodexProfiles({ refreshLiveActive: !codexRunning });
      const dead = codex.profiles.filter((profile) => profile.needsReauth).length;
      console.log(`codex keep-alive: checked ${codex.profiles.length} account(s)${dead ? `, ${dead} need re-add` : ''}.`);
    } catch (e) {
      console.log(`codex keep-alive failed: ${String((e as Error).message ?? e)}`);
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
    const ident = await loginViaClaudeCli(findClaudeExe());
    if (!ident || !hasRefreshableOauth(ident.claudeAiOauth)) {
      console.log('\nLogin did not complete. Nothing imported.');
      return;
    }
    const fields = identityToFields(ident);
    let p: Profile | undefined;
    mutateStore((store) => {
      p = addOrUpdateProfile(store, fields);
    });
    if (!p) throw new Error('Claude account was not imported after login.');
    console.log(`\n✓ Added "${p.label}" (${p.email}). Launch the switcher to use it.`);
    return;
  }

  if (args[0] === 'import') {
    const providerArg = args[1] === '--provider' ? args[2] : args[1] === 'codex' || args[1] === 'claude' ? args[1] : 'claude';
    const target = args[1] === '--provider' ? args[3] : args[1] === 'codex' || args[1] === 'claude' ? args[2] : args[1];
    if (!target) {
      console.log('Import path is required.');
      return;
    }
    if (providerArg === 'codex') {
      const imported = importCodexFromPath(target);
      for (const profile of imported) console.log(`Imported Codex "${profile.label}" (${profile.email})`);
      return;
    }
    const cands = importFromPath(target);
    if (!cands.length) {
      console.log(`Nothing importable at: ${target}`);
      return;
    }
    mutateStore((store) => {
      for (const c of cands) {
        try {
          const p = addOrUpdateProfile(store, c.fields, c.label);
          console.log(`Imported "${p.label}" (${p.email})`);
        } catch (e) {
          console.log(`Skipped invalid account from ${c.source}: ${(e as Error).message}`);
        }
      }
    });
    return;
  }

  if (args[0] === 'export-all') {
    if (args[1] === 'codex') {
      const codexStore = loadCodexStore();
      if (!codexStore.profiles.length) {
        console.log('No Codex accounts to export.');
        return;
      }
      console.log(`Exported ${codexStore.profiles.length} Codex account(s) to:\n${exportAllCodexProfiles(codexStore)}`);
      return;
    }
    const store = loadStore();
    if (!store.profiles.length) {
      console.log('No accounts to export.');
      return;
    }
    const file = exportAllProfiles(store);
    console.log(`Exported ${store.profiles.length} account(s) to:\n${file}`);
    return;
  }

  // Load + reconcile with the live account before doing anything interactive.
  let store = loadStore();
  const claudeVersion = detectClaudeVersion();
  try {
    store = mutateStore((fresh) => {
      fresh.claudeVersion = claudeVersion;
      reconcileWithLive(fresh);
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
  console.error(e);
  process.exit(1);
});
