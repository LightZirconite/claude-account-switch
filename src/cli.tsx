// Keyboard-driven TUI for switching Claude Code accounts. UI is in English.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';
import clipboard from 'clipboardy';

import { logFile, findClaudeExe, importDir } from './paths';
import { logger } from './logger';
import {
  loadStore,
  saveStore,
  reconcileWithLive,
  getActive,
  addOrUpdateProfile,
  deleteProfile,
  exportProfile,
  scanImportDir,
  importFromPath,
  type ImportCandidate,
} from './profiles';
import {
  applyProfile,
  restoreLatestBackup,
  dryRunApply,
  updateLiveCredentials,
  type DryRunReport,
} from './claudeStore';
import { fetchUsage, leastLoaded } from './usage';
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
    subscriptionType: id.claudeAiOauth.subscriptionType as string | undefined,
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

type Mode = 'list' | 'confirmSwitch' | 'confirmDelete' | 'rename' | 'importMenu' | 'importPath' | 'adding' | 'message';
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
  const [message, setMessage] = useState<{ title: string; lines: string[]; tone: Tone } | null>(null);
  const authRef = useRef<ManualAuth | null>(null);
  const cols = useTerminalSize();

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
      if (p.id === store.activeProfileId) {
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

  // fetch active usage on mount (best-effort, cached)
  useEffect(() => {
    (async () => {
      const a = getActive(store);
      if (!a) return;
      try {
        const info = await fetchUsage(a, claudeVersion, { onRotate });
        a.usage = info;
        persist(store);
      } catch (e) {
        logger.error('mount usage fetch failed', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-clear transient status notifications after 5 seconds.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(''), 5000);
    return () => clearTimeout(t);
  }, [status]);

  const refreshAllUsage = useCallback(async () => {
    setStatus('Refreshing usage for all accounts...');
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
    setStatus('Usage updated.');
  }, [store, claudeVersion, persist, onRotate]);

  const doSwitch = useCallback(
    async (target: Profile, pids: ProcInfo[]) => {
      setMode('list');
      setStatus(`Switching to ${target.label}...`);
      // Capture the outgoing (currently live) account's latest tokens first.
      try {
        reconcileWithLive(store);
      } catch (e) {
        logger.error('reconcile before switch failed', e);
      }
      const res = applyProfile(target);
      if (!res.ok) {
        showMessage('Switch failed', [res.error ?? 'unknown error', 'Your previous account was restored from backup.'], 'error');
        return;
      }
      const autoClose = store.closeClaudeOnSwitch ?? true;
      const { closed, failed } =
        autoClose && pids.length ? closeProcesses(pids.map((p) => p.pid)) : { closed: [] as number[], failed: [] as number[] };
      target.lastUsedAt = Date.now();
      store.activeProfileId = target.id;
      persist(store);
      showMessage(
        `Switched to ${target.label}`,
        [
          `Now authenticated as: ${target.email} (${target.subscriptionType ?? 'unknown plan'})`,
          '',
          'IMPORTANT — reload your open Claude Code sessions to apply the new account:',
          autoClose
            ? closed.length
              ? `• Closed ${closed.length} running claude CLI process(es) — just relaunch \`claude\`.`
              : '• No running claude CLI process was found to close.'
            : '• Auto-close is OFF: close/relaunch your open `claude` CLI sessions yourself.',
          failed.length ? `• Could not close: ${failed.join(', ')} (close them manually).` : '',
          '• VS Code: run "Developer: Reload Window" (or it applies on your next message).',
          '',
          'This switcher stays open — no web login needed.',
        ].filter(Boolean),
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

  const startAdd = useCallback(async () => {
    setMode('adding');
    setBuffer('');
    setAddBusy(false);
    try {
      const auth = buildManualAuth(DEFAULT_SCOPES);
      authRef.current = auth;
      await clipboard.write(auth.url).catch(() => {});
      setAddLines([
        'Add a Claude account — official login flow (works across machines):',
        '',
        '1. The authorization URL was COPIED to your clipboard. Open it in any',
        '   browser (this PC or another) and sign in with the account you want.',
        '2. After you approve, the page shows an authorization code.',
        '3. Copy that code and paste it below, then press Enter.',
        '',
        auth.url,
      ]);
    } catch (e) {
      showMessage('Could not start add', [String((e as Error)?.message ?? e)], 'error');
    }
  }, [showMessage]);

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
      const p = addOrUpdateProfile(store, cand.fields);
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

  // ---------- input handling ----------
  useInput((input, key) => {
    if (mode === 'list') {
      if (key.upArrow || input === 'k') setCursor((c) => (c > 0 ? c - 1 : profiles.length - 1));
      else if (key.downArrow || input === 'j') setCursor((c) => (c < profiles.length - 1 ? c + 1 : 0));
      else if (key.return) {
        if (selected) beginSwitch(selected);
      } else if (input === 'a') void startAdd();
      else if (input === 'i') openImportMenu();
      else if (input === 'e') exportSelected();
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
            cands.forEach((c) => addOrUpdateProfile(store, c.fields));
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
  const emailW = Math.max(16, W - (4 + 18 + 6 + 12 + 12 + 11));
  const leftW = Math.min(42, Math.max(24, Math.floor((W - 4) * 0.4)));
  const least = leastLoaded(profiles);
  const leastName = least ? least.label : null;

  return (
    <Box flexDirection="column">
      {mode === 'list' ? (
        <Box width={W} borderStyle="round" borderColor={CLAUDE_ORANGE} paddingX={1} flexDirection="column">
          <Text bold>
            <Text color={CLAUDE_ORANGE}>✳ </Text>
            <Text color="white">Claude Account Switch</Text> <Text dimColor>v1.0</Text>
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
              {active ? (
                <Box marginTop={1} flexDirection="column">
                  <Text>
                    <Text dimColor>active </Text>
                    <Text color="green">●</Text> <Text bold color="white">{active.label}</Text>{' '}
                    <Text color={planColor(active.subscriptionType)}>{(active.subscriptionType ?? '').toUpperCase()}</Text>
                  </Text>
                  {active.usage?.status === 'ok' ? (
                    <>
                      <Text>
                        {'   5h  '}
                        <Text color={utilColor(active.usage.five_hour?.utilization ?? null)}>
                          {fmtPct(active.usage.five_hour?.utilization).padEnd(5)}
                        </Text>
                        <Text dimColor>resets {resetAt(active.usage.five_hour?.resets_at)}</Text>
                      </Text>
                      <Text>
                        {'   7d  '}
                        <Text color={utilColor(active.usage.seven_day?.utilization ?? null)}>
                          {fmtPct(active.usage.seven_day?.utilization).padEnd(5)}
                        </Text>
                        <Text dimColor>resets {resetAt(active.usage.seven_day?.resets_at)}</Text>
                      </Text>
                      {/* PROMO: Fable 50% until 2026-07-07 — auto-hidden after FABLE_PROMO_END; safe to delete this block after the promo. */}
                      {(() => {
                        if (Date.now() >= FABLE_PROMO_END) return null;
                        const fable = active.usage.models?.find((m) => /fable/i.test(m.name));
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
                  ) : (
                    <Text dimColor>{'   press u to load usage'}</Text>
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
            <Text bold color="cyanBright">
              {'⚡ '}
              <Text color="white">Claude Account Switch</Text>
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
            <Text dimColor>{addBusy ? 'Working…' : 'Paste the code above, then Enter · Esc to cancel'}</Text>
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
                {pad('EMAIL', emailW)}
                {pad('PLAN', 6)}
                {pad('5-HOUR', 12)}
                {pad('7-DAY', 12)}
                {'LAST ACTIVE'}
              </Text>
              {profiles.map((p, i) => {
                const isActive = p.id === store.activeProfileId;
                const isCursor = i === cursor;
                return (
                  <Box key={p.id}>
                    <Text color="cyanBright" bold>
                      {isCursor ? '❯ ' : '  '}
                    </Text>
                    <Text color={isActive ? 'green' : 'gray'}>{isActive ? '●' : '○'} </Text>
                    <Text bold={isCursor} color={isCursor ? 'white' : undefined}>
                      {pad(p.label, 18)}
                    </Text>
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
              {(store.closeClaudeOnSwitch ?? true) ? (
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
              )}
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
        {status ? <Text color="yellow">{status}</Text> : null}
        {mode === 'list' ? (
          <>
            <Text dimColor>
              <Text color="cyan">↑/↓</Text> move · <Text color="cyan">⏎</Text> switch · <Text color="cyan">b</Text>{' '}
              best-now · <Text color="cyan">l</Text> least-loaded · <Text color="cyan">u</Text> refresh
            </Text>
            <Text dimColor>
              <Text color="cyan">a</Text> add · <Text color="cyan">i</Text> import · <Text color="cyan">e</Text> export ·{' '}
              <Text color="cyan">r</Text> rename · <Text color="cyan">d</Text> delete · <Text color="cyan">q</Text> quit
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
  switch.cmd --dry-run       Show exactly which keys a switch would change (no writes)
  switch.cmd restore         Roll back the last credential change from backup
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
      const p = addOrUpdateProfile(store, c.fields);
      console.log(`Imported "${p.label}" (${p.email})`);
    }
    saveStore(store);
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
