// Keyboard-driven TUI for switching Claude Code accounts. UI is in English.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import clipboard from 'clipboardy';

import { logFile, findClaudeExe, importDir } from './paths';
import { logger } from './logger';
import { checkForUpdate } from './updateCheck';
import pkg from '../package.json';
const APP_VERSION: string = pkg.version;
import {
  loadStore,
  saveStore,
  reconcileWithLive,
  getActive,
  addOrUpdateProfile,
  captureDesktopAccount,
  deleteProfile,
  exportProfile,
  scanImportDir,
  importFromPath,
  subscriptionOf,
  exportAllProfiles,
  type ImportCandidate,
} from './profiles';
import {
  applyProfile,
  restoreLatestBackup,
  dryRunApply,
  updateLiveCredentials,
  type DryRunReport,
} from './claudeStore';
import { applyDesktopSnapshot, isDesktopInstalled } from './desktopStore';
import { ensureFreshToken, fetchUsage, keepTokenAlive, leastLoaded } from './usage';
import { findClaudeProcesses, closeProcesses, detectClaudeVersion, type ProcInfo } from './processes';
import {
  buildManualAuth,
  exchangeCode,
  primeIdentity,
  loginViaClaudeCli,
  DEFAULT_SCOPES,
  type ManualAuth,
  type PrimedIdentity,
} from './oauth';
import type { Profile, ProfilesStore } from './types';

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

function openUrl(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
  }
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
// Fable promo: show the Fable per-model bucket only until this date, then it auto-hides.
const FABLE_PROMO_END = new Date('2026-07-08T00:00:00').getTime();

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
  | 'message';
type Tone = 'success' | 'error' | 'info';

interface AppProps {
  initialStore: ProfilesStore;
  claudeVersion: string;
}

function App({ initialStore, claudeVersion }: AppProps) {
  const { exit } = useApp();
  const [store, setStore] = useState<ProfilesStore>(initialStore);
  const [cursor, setCursor] = useState(() => {
    const i = initialStore.profiles.findIndex((p) => p.id === initialStore.activeProfileId);
    return i >= 0 ? i : 0;
  });
  const [mode, setMode] = useState<Mode>('list');
  const [status, setStatus] = useState<string>('');
  const [buffer, setBuffer] = useState<string>('');
  const [pendingSwitch, setPendingSwitch] = useState<{ profile: Profile; pids: ProcInfo[] } | null>(null);
  const [importCands, setImportCands] = useState<ImportCandidate[]>([]);
  const [importCursor, setImportCursor] = useState(0);
  const [addLines, setAddLines] = useState<string[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const desktopLabelRef = useRef('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [message, setMessage] = useState<{ title: string; lines: string[]; tone: Tone } | null>(null);
  const authRef = useRef<ManualAuth | null>(null);
  const cols = useTerminalSize();
  const storeRef = useRef(store);
  storeRef.current = store;

  const persist = useCallback((s: ProfilesStore) => {
    saveStore(s);
    setStore({ ...s });
  }, []);

  const showMessage = useCallback((title: string, lines: string[], tone: Tone) => {
    setMessage({ title, lines, tone });
    setMode('message');
  }, []);

  // When a usage refresh rotates a token, persist it. If it's the ACTIVE account,
  // also sync it into the live credentials so Claude's running session stays valid.
  const onRotate = useCallback(
    (p: Profile) => {
      saveStore(store);
      if (p.id === store.activeProfileId && p.claudeAiOauth) {
        try {
          updateLiveCredentials(p.claudeAiOauth, p.organizationUuidRoot ?? p.organizationUuid);
        } catch (e) {
          logger.error('sync rotated active token to live failed', e);
        }
      }
    },
    [store],
  );

  const profiles = store.profiles;
  const selected = profiles[cursor];
  const active = getActive(store);

  // The running `claude` CLI session (if any) refreshes its OWN token independently
  // while it's alive, which rotates the refresh token server-side and can desync our
  // cached copy for the ACTIVE profile — a background refresh attempt here would then
  // get rejected (invalid_grant) even though the account is perfectly fine live. Re-sync
  // from the live files first (cheap, local-only) before touching the active profile.
  const reconcileActiveIfLive = useCallback((s: ProfilesStore, p: Profile) => {
    if (p.id !== s.activeProfileId) return;
    try {
      reconcileWithLive(s);
    } catch (e) {
      logger.error('reconcile before usage fetch failed', e);
    }
    // Validate needsReauth directly instead of only via the usage-cache-gated refresh
    // path below (fetchUsage short-circuits on a warm cache and would never reach it).
    if (p.needsReauth && p.claudeAiOauth && p.claudeAiOauth.expiresAt > Date.now() + 60_000) {
      p.needsReauth = false;
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
          a.usage = await fetchUsage(a, claudeVersion, { onRotate });
          persist(s);
        } catch (e) {
          logger.error('mount usage fetch failed', e);
        }
      }
      for (const p of s.profiles) {
        if (p.id === s.activeProfileId || !p.claudeAiOauth) continue;
        try {
          p.usage = await fetchUsage(p, claudeVersion, { onRotate });
          persist(storeRef.current);
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
  // the (non-rate-limited) token endpoint, rotating and persisting before expiry, so an
  // account that's just sitting there never dies. This is what makes saved accounts as
  // durable as a normal `claude login`: as long as the switcher runs periodically, the
  // token chain never breaks. (needs-reauth accounts are skipped — their token is dead.)
  useEffect(() => {
    const KEEP_ALIVE_LEAD_MS = 30 * 60 * 1000;
    // Stable rotate handler (reads live store via ref) so this effect doesn't re-subscribe
    // on every persist. Persists the rotation and, if the rotated account is the active one,
    // syncs it into the live credentials so a running `claude` session stays valid.
    const rotate = (p: Profile) => {
      const s = storeRef.current;
      saveStore(s);
      if (p.id === s.activeProfileId && p.claudeAiOauth) {
        try {
          updateLiveCredentials(p.claudeAiOauth, p.organizationUuidRoot ?? p.organizationUuid);
        } catch {
          /* ignore */
        }
      }
    };
    const run = () => {
      (async () => {
        for (const p of storeRef.current.profiles) {
          if (!p.claudeAiOauth || p.needsReauth) continue;
          // Skip the ACTIVE account: a running `claude` session rotates its token
          // independently, so refreshing our (possibly already-stale) copy here could
          // desync and falsely flag it. The 2-min active-usage interval — which
          // reconciles from the live files first — keeps the active account alive.
          if (p.id === storeRef.current.activeProfileId) continue;
          await keepTokenAlive(p, KEEP_ALIVE_LEAD_MS, rotate);
        }
        persist(storeRef.current);
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
    if (!p || !p.claudeAiOauth) return;
    const t = setTimeout(() => {
      reconcileActiveIfLive(storeRef.current, p);
      fetchUsage(p, claudeVersion, { onRotate })
        .then((info) => {
          p.usage = info;
          persist(storeRef.current);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, claudeVersion, onRotate]);

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
        onRotate: (p) => {
          saveStore(s);
          if (p.id === s.activeProfileId && p.claudeAiOauth) {
            try {
              updateLiveCredentials(p.claudeAiOauth, p.organizationUuidRoot ?? p.organizationUuid);
            } catch {
              /* ignore */
            }
          }
        },
      })
        .then((info) => {
          a.usage = info;
          persist(s);
        })
        .catch(() => {});
    }, 120_000);
    return () => clearInterval(t);
  }, [claudeVersion, persist, reconcileActiveIfLive]);

  const refreshAllUsage = useCallback(async () => {
    setBusy('Refreshing usage…');
    for (const p of store.profiles) {
      try {
        const info = await fetchUsage(p, claudeVersion, { force: true, onRotate });
        p.usage = info;
        persist(store);
      } catch (e) {
        logger.error('usage refresh failed', e, { email: p.email });
      }
      await sleep(500); // be gentle with the rate-limited endpoint
    }
    setBusy(null);
    setStatus('Usage updated.');
  }, [store, claudeVersion, persist, onRotate]);

  const doSwitch = useCallback(
    async (target: Profile, pids: ProcInfo[]) => {
      setMode('list');
      setBusy(`Switching to ${target.label}…`);
      const lines: string[] = [];

      if (target.claudeAiOauth) {
        // Capture the outgoing (currently live) account's latest tokens first.
        try {
          reconcileWithLive(store);
        } catch (e) {
          logger.error('reconcile before switch failed', e);
        }
        // Proactively refresh the target's token if it's expired, so it works instantly.
        // Routed through the single-flighted ensureFreshToken so it can't race (and burn
        // the token against) a background refresh of this same account.
        try {
          await ensureFreshToken(target, onRotate);
        } catch (e) {
          logger.warn('proactive refresh on switch failed', { email: target.email });
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
      target.lastUsedAt = Date.now();
      store.activeProfileId = target.id;
      persist(store);
      showMessage(
        `Switched to ${target.label}`,
        [...lines, '', 'This switcher stays open — no web login needed.'].filter(Boolean),
        'success',
      );
    },
    [store, persist, showMessage],
  );

  const beginSwitch = useCallback(
    (target: Profile) => {
      if (target.id === store.activeProfileId) {
        setStatus(`"${target.label}" is already the active account.`);
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
    [store.activeProfileId],
  );

  const startAdd = useCallback(
    async (reauthEmail?: string) => {
      setMode('adding');
      setBuffer('');
      setAddBusy(false);
      try {
        const auth = buildManualAuth(DEFAULT_SCOPES);
        authRef.current = auth;
        await clipboard.write(auth.url).catch(() => {});
        setAddLines([
          reauthEmail
            ? `Re-authorize "${reauthEmail}" — sign in with THAT account below.`
            : 'Add a Claude account — official login flow (works across machines):',
          '',
          '1. The authorization URL was COPIED to your clipboard. Open it in any',
          `   browser (this PC or another) and sign in${reauthEmail ? ` as ${reauthEmail}` : ' with the account you want'}.`,
          '2. After you approve, the page shows an authorization code.',
          '3. Copy that code and paste it below, then press Enter.',
          '',
          auth.url,
        ]);
      } catch (e) {
        showMessage('Could not start add', [String((e as Error)?.message ?? e)], 'error');
      }
    },
    [showMessage],
  );

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
        const p = captureDesktopAccount(store, desktopLabelRef.current, email);
        persist(store);
        setCursor(store.profiles.findIndex((x) => x.id === p.id));
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
    [store, persist, showMessage],
  );

  const submitAddCode = useCallback(async () => {
    const auth = authRef.current;
    const code = buffer.trim();
    if (!auth || !code) return;
    setAddBusy(true);
    setAddLines(['Exchanging the code for tokens...']);
    try {
      const tokens = await exchangeCode(code, auth.verifier, auth.state);
      setAddLines(['Fetching account identity...']);
      const ident = primeIdentity(tokens, findClaudeExe(), DEFAULT_SCOPES);
      const fields = identityToFields(ident);
      const p = addOrUpdateProfile(store, fields);
      persist(store);
      authRef.current = null;
      setAddBusy(false);
      setBuffer('');
      setCursor(store.profiles.findIndex((x) => x.id === p.id));
      showMessage('Account added', [`${p.label} (${p.email})`, `Plan: ${p.subscriptionType ?? 'unknown'}`], 'success');
    } catch (e) {
      setAddBusy(false);
      showMessage(
        'Add account failed',
        [
          String((e as Error)?.message ?? e),
          '',
          'Make sure you pasted the full code from the page. If it still fails,',
          'use the official fallback — quit and run:',
          '',
          '    switch.cmd login',
        ],
        'error',
      );
    }
  }, [store, buffer, persist, showMessage]);

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
      const p = addOrUpdateProfile(store, cand.fields, cand.label);
      persist(store);
      setCursor(store.profiles.findIndex((x) => x.id === p.id));
      setMode('list');
      setStatus(`Imported "${p.label}" (${p.email}).`);
    },
    [store, persist],
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
      } else if (input === 'l') {
        const target = leastLoaded(store.profiles);
        if (target) {
          setCursor(store.profiles.findIndex((p) => p.id === target.id));
          setStatus(`Least-loaded: ${target.label}. Press Enter to switch.`);
        } else {
          setStatus('No usage data yet. Press "u" to refresh usage first.');
        }
      } else if (input === 'b') {
        // Best-now: switch straight to the account with the most headroom.
        const target = leastLoaded(store.profiles);
        if (!target) setStatus('No usage data yet. Press "u" to refresh usage first.');
        else if (target.id === store.activeProfileId) setStatus('Active account already has the most headroom.');
        else beginSwitch(target);
      } else if (input === 'u') void refreshAllUsage();
      else if (input === 'q' || key.escape) exit();
      return;
    }

    if (mode === 'confirmSwitch') {
      if (input === 'y' || key.return) {
        if (pendingSwitch) void doSwitch(pendingSwitch.profile, pendingSwitch.pids);
      } else if (input === 'c') {
        store.closeClaudeOnSwitch = !(store.closeClaudeOnSwitch ?? true);
        persist(store);
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
          deleteProfile(store, selected.id);
          persist(store);
          setCursor((c) => Math.max(0, Math.min(c, store.profiles.length - 1)));
          setStatus(`Deleted "${label}".`);
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
          selected.label = buffer.trim();
          persist(store);
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
            cands.forEach((c) => addOrUpdateProfile(store, c.fields, c.label));
            persist(store);
            setMode('list');
            setStatus(`Imported ${cands.length} account(s) from path.`);
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
        setBuffer('');
        setMode('list');
        setStatus('Add cancelled.');
      } else if (key.return) {
        void submitAddCode();
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => (b + input).replace(/[\r\n]/g, ''));
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
  const least = leastLoaded(profiles);
  const leastName = least ? least.label : null;

  return (
    <Box flexDirection="column">
      {mode === 'list' ? (
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
                  {!selected.claudeAiOauth ? (
                    <Text dimColor>{'   Desktop-only account — usage not available'}</Text>
                  ) : selected.usage && (selected.usage.status === 'ok' || selected.usage.status === 'stale') ? (
                    <>
                      <Text>
                        {'   5h  '}
                        <Text color={utilColor(selected.usage.five_hour?.utilization ?? null)}>
                          {fmtPct(selected.usage.five_hour?.utilization).padEnd(5)}
                        </Text>
                        <Text dimColor>resets {resetAt(selected.usage.five_hour?.resets_at)}</Text>
                      </Text>
                      <Text>
                        {'   7d  '}
                        <Text color={utilColor(selected.usage.seven_day?.utilization ?? null)}>
                          {fmtPct(selected.usage.seven_day?.utilization).padEnd(5)}
                        </Text>
                        <Text dimColor>resets {resetAt(selected.usage.seven_day?.resets_at)}</Text>
                      </Text>
                      {selected.needsReauth ? (
                        <Text color="red">{'   ⚠ login expired — press "a" to re-add (numbers are last-known)'}</Text>
                      ) : selected.usage.status === 'stale' ? (
                        <Text dimColor>{'   (cached — refreshing…)'}</Text>
                      ) : null}
                      {/* PROMO: Fable 50% until 2026-07-07 — auto-hidden after FABLE_PROMO_END; safe to delete this block after the promo. */}
                      {(() => {
                        if (Date.now() >= FABLE_PROMO_END) return null;
                        const fable = selected.usage.models?.find((m) => /fable/i.test(m.name));
                        if (!fable) return null;
                        return (
                          <Text>
                            {'   Fable '}
                            <Text color={utilColor(fable.utilization)}>{fmtPct(fable.utilization).padEnd(5)}</Text>
                            <Text dimColor>promo (until Jul 7)</Text>
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
              {leastName ? (
                <Text>
                  <Text dimColor>most headroom: </Text>
                  <Text color="green">{leastName}</Text>
                </Text>
              ) : null}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box width={W} justifyContent="space-between">
            <Text bold>
              <Text color={CLAUDE_ORANGE}>Claude</Text> <Text color="white">Account Switch</Text>
            </Text>
            {active ? <Text dimColor>active: {active.label}</Text> : null}
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
          {!addBusy ? (
            <Box marginTop={1}>
              <Text>
                Code: <Text color="green">{buffer}</Text>
                <Text>▎</Text>
              </Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            {addBusy ? <Spinner label="Working…" /> : <Text dimColor>Paste the code above, then Enter · Esc to cancel</Text>}
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
                const linked = [p.claudeAiOauth ? 'CLI' : null, p.desktopSnapshotDir ? 'DSK' : null].filter(Boolean).join('+');
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
              {pendingSwitch.profile.claudeAiOauth ? (
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
                Delete profile "{selected.label}" ({selected.email})? [y] yes · [n] no
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
            <Text dimColor>
              <Text color="cyan">a</Text> add · <Text color="cyan">A</Text> add Desktop · <Text color="cyan">i</Text> import ·{' '}
              <Text color="cyan">e</Text> export · <Text color="cyan">E</Text> export-all · <Text color="cyan">r</Text> rename ·{' '}
              <Text color="cyan">d</Text> delete · <Text color="cyan">q</Text> quit
            </Text>
          </>
        ) : null}
        <Text dimColor>log: {logFile()}</Text>
      </Box>
    </Box>
  );
}

// ---------- non-interactive commands + entry ----------

function printHelp(): void {
  console.log(`Claude Account Switch

Usage:
  switch.cmd                 Launch the interactive account switcher (TUI)
  switch.cmd login           Add an account via the official 'claude' login (fallback)
  switch.cmd import <path>   Import account(s) from a file or folder
  switch.cmd export-all      Export ALL accounts into one portable backup file
  switch.cmd --dry-run       Show exactly which keys a switch would change (no writes)
  switch.cmd restore         Roll back the last credential change from backup
  switch.cmd keep-alive          Refresh all accounts' tokens now (keeps logins alive)
  switch.cmd keep-alive install  Schedule keep-alive every 6h (accounts never expire)
  switch.cmd keep-alive uninstall  Remove the scheduled keep-alive job
  switch.cmd --help          This help

Data & logs live in ~/.claude-switch/`);
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

const KEEPALIVE_TASK = 'ClaudeAccountSwitch-KeepAlive';

/** Absolute path to this running script (dist/cli.js), for the scheduler to invoke. */
function scriptEntry(): string {
  return path.resolve(process.argv[1] ?? '');
}

/**
 * Headless keep-alive: refresh every account's OAuth token that's near expiry and persist
 * the rotation — so accounts stay alive even when the switcher UI isn't open. Run by the OS
 * scheduler (see keep-alive install). The ACTIVE account is left to a running `claude`
 * session if one is live (it manages its own token); otherwise we reconcile + refresh it too.
 */
async function runKeepAliveOnce(): Promise<void> {
  const store = loadStore();
  if (!store.profiles.length) {
    console.log('keep-alive: no accounts saved.');
    return;
  }
  const LEAD_MS = 60 * 60 * 1000; // refresh anything expiring within the next hour
  let claudeRunning = false;
  try {
    claudeRunning = findClaudeProcesses().length > 0;
  } catch {
    /* treat as not running */
  }
  const onRotate = (p: Profile) => {
    saveStore(store);
    if (p.id === store.activeProfileId && p.claudeAiOauth) {
      try {
        updateLiveCredentials(p.claudeAiOauth, p.organizationUuidRoot ?? p.organizationUuid);
      } catch {
        /* ignore */
      }
    }
  };
  let refreshed = 0;
  let dead = 0;
  for (const p of store.profiles) {
    if (!p.claudeAiOauth) continue;
    if (p.needsReauth) {
      dead++;
      continue;
    }
    const isActive = p.id === store.activeProfileId;
    if (isActive && claudeRunning) continue; // the live session owns its own token
    if (isActive) {
      try {
        reconcileWithLive(store);
      } catch {
        /* keep going */
      }
    }
    const before = p.claudeAiOauth.refreshToken;
    await keepTokenAlive(p, LEAD_MS, onRotate);
    if (p.claudeAiOauth.refreshToken !== before) refreshed++;
    if (p.needsReauth) dead++;
  }
  saveStore(store);
  logger.info('keep-alive run complete', { refreshed, dead, total: store.profiles.length });
  console.log(`keep-alive: refreshed ${refreshed} token(s)${dead ? `, ${dead} account(s) need re-add` : ''}.`);
}

/** Register an OS scheduled job that runs `keep-alive` every 6 hours (Windows Task Scheduler). */
function keepAliveInstall(): void {
  const entry = scriptEntry();
  if (process.platform !== 'win32') {
    console.log('Add this to your crontab (macOS/Linux) to keep accounts alive while the app is closed:');
    console.log(`  0 */6 * * *  "${process.execPath}" "${entry}" keep-alive`);
    return;
  }
  const tr = `"${process.execPath}" "${entry}" keep-alive`;
  const r = spawnSync(
    'schtasks',
    ['/Create', '/F', '/SC', 'HOURLY', '/MO', '6', '/TN', KEEPALIVE_TASK, '/TR', tr],
    { encoding: 'utf8' },
  );
  if (r.status === 0) {
    console.log(`✓ Installed scheduled task "${KEEPALIVE_TASK}" (runs every 6h).`);
    console.log('  Your saved accounts now stay logged in even when the switcher is closed.');
    console.log(`  Remove it any time with:  switch.cmd keep-alive uninstall`);
  } else {
    console.log('Could not install the scheduled task (try an elevated terminal).');
    console.log((r.stderr || r.stdout || '').trim());
  }
}

/** Remove the scheduled keep-alive job. */
function keepAliveUninstall(): void {
  if (process.platform !== 'win32') {
    console.log('Remove the cron line you added for `keep-alive`.');
    return;
  }
  const r = spawnSync('schtasks', ['/Delete', '/F', '/TN', KEEPALIVE_TASK], { encoding: 'utf8' });
  console.log(r.status === 0 ? `✓ Removed scheduled task "${KEEPALIVE_TASK}".` : 'No scheduled task to remove.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args[0] === 'restore') {
    const dir = restoreLatestBackup();
    console.log(dir ? `Restored credentials from backup: ${dir}` : 'No backups found.');
    return;
  }

  if (args[0] === 'keep-alive') {
    if (args[1] === 'install') {
      keepAliveInstall();
      return;
    }
    if (args[1] === 'uninstall') {
      keepAliveUninstall();
      return;
    }
    await runKeepAliveOnce();
    return;
  }

  if (args[0] === 'login') {
    console.log('Starting official claude login in an isolated sandbox...\n');
    const ident = await loginViaClaudeCli(findClaudeExe());
    if (!ident || !ident.claudeAiOauth) {
      console.log('\nLogin did not complete. Nothing imported.');
      return;
    }
    const store = loadStore();
    const fields = identityToFields(ident);
    const p = addOrUpdateProfile(store, fields);
    saveStore(store);
    console.log(`\n✓ Added "${p.label}" (${p.email}). Launch the switcher to use it.`);
    return;
  }

  if (args[0] === 'import' && args[1]) {
    const cands = importFromPath(args[1]);
    if (!cands.length) {
      console.log(`Nothing importable at: ${args[1]}`);
      return;
    }
    const store = loadStore();
    for (const c of cands) {
      const p = addOrUpdateProfile(store, c.fields, c.label);
      console.log(`Imported "${p.label}" (${p.email})`);
    }
    saveStore(store);
    return;
  }

  if (args[0] === 'export-all') {
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
  const store = loadStore();
  const claudeVersion = detectClaudeVersion();
  store.claudeVersion = claudeVersion;
  try {
    reconcileWithLive(store);
  } catch (e) {
    logger.error('startup reconcile failed', e);
  }
  // Backfill any profile saved before the plan-detection fix (e.g. subscriptionType
  // was missing right after the manual add-account flow) using organizationType.
  for (const p of store.profiles) {
    if (!p.subscriptionType && p.claudeAiOauth) {
      const derived = subscriptionOf(p.claudeAiOauth, p.organizationType);
      if (derived) p.subscriptionType = derived;
    }
    // A needsReauth flag can get stuck true from a transient invalid_grant (e.g. a
    // refresh-token rotation race with a live `claude` session) even after the token
    // is valid again. Validate it right away instead of waiting on the lazy,
    // usage-cache-gated refresh path — otherwise the UI shows stale red for minutes.
    if (p.needsReauth && p.claudeAiOauth && p.claudeAiOauth.expiresAt > Date.now() + 60_000) {
      p.needsReauth = false;
    }
  }
  saveStore(store);

  if (args.includes('--dry-run')) {
    const target = store.profiles.find((p) => p.id !== store.activeProfileId) ?? getActive(store);
    if (!target) {
      console.log('No profile available to dry-run. Are you logged into Claude Code?');
      return;
    }
    printDryRun(target, dryRunApply(target));
    return;
  }

  render(<App initialStore={store} claudeVersion={claudeVersion} />);
}

main().catch((e) => {
  logger.error('fatal', e);
  console.error(e);
  process.exit(1);
});
