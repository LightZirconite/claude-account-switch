import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { logger } from './logger';
import { atomicWriteFile, ensurePrivateDir } from './atomicFile';
import { withFileLockSync } from './locks';
import type { CodexRateLimitBucket } from './types';
import pkg from '../package.json';

export interface CodexAccountInfo {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface CodexRateLimitsResult {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket>;
  rateLimitResetCredits?: { availableCount?: number; credits?: unknown[] | null } | null;
  spendControlReached?: boolean | null;
}

export interface CodexInspection {
  account: CodexAccountInfo | null;
  requiresOpenaiAuth: boolean;
  rateLimits: CodexRateLimitsResult | null;
  /** Effective config projection reported by this version of the official app-server. */
  credentialStore?: string;
}

export interface StoppableCodexAppServerChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdin: { end(): void };
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: 'exit', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const CODEX_LOGIN_HELPER_MARKER = '.switcher-app-server-owner.json';

interface CodexLoginHelperMarker {
  kind: 'claude-codex-account-switch/codex-login-helper-owner';
  version: 1;
  leaseId?: string;
  ownerPid?: number;
  pid: number | null;
  createdAt: number;
}

export class CodexAppServerShutdownError extends Error {
  constructor(readonly pid?: number) {
    super('Codex app-server did not exit after shutdown and termination requests. Credential processing was aborted while its home remained in place.');
    this.name = 'CodexAppServerShutdownError';
  }
}

export class CodexAppServerHomeBusyError extends Error {
  constructor(readonly home: string, readonly state: 'alive' | 'unproven') {
    super(
      state === 'alive'
        ? 'A Codex app-server owner is still active for this credential home.'
        : 'A previous Codex app-server owner did not leave enough evidence to prove this credential home is safe.',
    );
    this.name = 'CodexAppServerHomeBusyError';
  }
}

function readCodexLoginHelperMarker(home: string): Partial<CodexLoginHelperMarker> | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(home, CODEX_LOGIN_HELPER_MARKER), 'utf8'),
    ) as Partial<CodexLoginHelperMarker>;
  } catch {
    return null;
  }
}

export function writeCodexLoginHelperMarker(home: string, pid?: number, leaseId?: string): string {
  ensurePrivateDir(home);
  const existing = readCodexLoginHelperMarker(home);
  const effectiveLeaseId = leaseId ?? existing?.leaseId ?? crypto.randomUUID();
  const marker: CodexLoginHelperMarker = {
    kind: 'claude-codex-account-switch/codex-login-helper-owner',
    version: 1,
    leaseId: effectiveLeaseId,
    ownerPid: process.pid,
    pid: Number.isInteger(pid) && (pid ?? 0) > 0 ? pid! : null,
    createdAt: Date.now(),
  };
  atomicWriteFile(
    path.join(home, CODEX_LOGIN_HELPER_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return effectiveLeaseId;
}

export function clearCodexLoginHelperMarker(home: string, leaseId?: string): void {
  if (leaseId) {
    const marker = readCodexLoginHelperMarker(home);
    if (marker?.leaseId !== leaseId) return;
  }
  try {
    fs.rmSync(path.join(home, CODEX_LOGIN_HELPER_MARKER), { force: true });
  } catch (error) {
    // The helper/critical section has already ended. Retaining a stale marker fails
    // future ownership attempts closed; it must not turn a successfully persisted
    // credential generation into a reported transaction failure.
    logger.warn('codex app-server ownership marker cleanup deferred', {
      home,
      error: String(error),
    });
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function codexLoginHelperRecoveryState(home: string): 'none' | 'alive' | 'exited' | 'unproven' {
  const markerPath = path.join(home, CODEX_LOGIN_HELPER_MARKER);
  if (!fs.existsSync(markerPath)) return 'none';
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<CodexLoginHelperMarker>;
    if (marker.kind !== 'claude-codex-account-switch/codex-login-helper-owner'
      || marker.version !== 1) return 'unproven';
    if (Number.isInteger(marker.pid) && (marker.pid ?? 0) > 0) {
      return processAlive(marker.pid!) ? 'alive' : 'exited';
    }
    if (Number.isInteger(marker.ownerPid) && (marker.ownerPid ?? 0) > 0) {
      return processAlive(marker.ownerPid!) ? 'alive' : 'unproven';
    }
    return 'unproven';
  } catch {
    return 'unproven';
  }
}

/** Exclusively reserve one credential home before spawning any app-server. */
export function withCodexAppServerHomeLockSync<T>(home: string, operation: () => T): T {
  const normalizedHome = process.platform === 'win32'
    ? path.resolve(home).toLowerCase()
    : path.resolve(home);
  const homeHash = crypto.createHash('sha256').update(normalizedHome).digest('hex').slice(0, 32);
  return withFileLockSync(`codex-app-server-home-${homeHash}`, operation);
}

export function claimCodexAppServerHome(
  home: string,
  options: { onLockedState?: (state: ReturnType<typeof codexLoginHelperRecoveryState>) => void } = {},
): string {
  return withCodexAppServerHomeLockSync(home, () => {
    ensurePrivateDir(home);
    // The state must be observed only after acquiring the home-scoped lock. In
    // particular, two processes must never both clear one exited marker and then
    // successively delete each other's new lease.
    const state = codexLoginHelperRecoveryState(home);
    options.onLockedState?.(state);
    if (state === 'alive' || state === 'unproven') throw new CodexAppServerHomeBusyError(home, state);
    if (state === 'exited') clearCodexLoginHelperMarker(home);

    const leaseId = crypto.randomUUID();
    const marker: CodexLoginHelperMarker = {
      kind: 'claude-codex-account-switch/codex-login-helper-owner',
      version: 1,
      leaseId,
      ownerPid: process.pid,
      pid: null,
      createdAt: Date.now(),
    };
    const markerPath = path.join(home, CODEX_LOGIN_HELPER_MARKER);
    let fd: number | null = null;
    try {
      fd = fs.openSync(markerPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      return leaseId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const contested = codexLoginHelperRecoveryState(home);
        throw new CodexAppServerHomeBusyError(
          home,
          contested === 'alive' ? 'alive' : 'unproven',
        );
      }
      throw error;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  });
}

function childHasExited(child: StoppableCodexAppServerChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForConfirmedChildExit(
  child: StoppableCodexAppServerChild,
  timeoutMs: number,
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    // Close the narrow race where the process exited after the first check but before
    // the listener was registered and its event had already been delivered.
    if (childHasExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(childHasExited(child)), Math.max(1, timeoutMs));
  });
}

/** A credential-owning app-server is stopped only after its OS exit is observed. */
export async function stopCodexAppServerChild(
  child: StoppableCodexAppServerChild,
  gracefulTimeoutMs: number,
  terminationTimeoutMs: number,
): Promise<void> {
  try {
    child.stdin.end();
  } catch {
    /* Continue to the bounded termination path. */
  }
  if (await waitForConfirmedChildExit(child, gracefulTimeoutMs)) return;

  try {
    child.kill('SIGTERM');
  } catch {
    /* The confirmation below remains authoritative. */
  }
  if (await waitForConfirmedChildExit(child, terminationTimeoutMs)) return;

  throw new CodexAppServerShutdownError(child.pid);
}

export class CodexLoginCancelledError extends Error {
  constructor() {
    super('Codex login cancelled.');
    this.name = 'CodexLoginCancelledError';
  }
}

export function throwIfCodexLoginCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CodexLoginCancelledError();
}

async function awaitCodexLoginStep<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  throwIfCodexLoginCancelled(signal);
  if (!signal) return operation();

  let abortHandler: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abortHandler = () => {
      try {
        onAbort?.();
      } catch {
        /* Cancellation must not depend on a best-effort provider notification. */
      }
      reject(new CodexLoginCancelledError());
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });

  try {
    const result = await Promise.race([Promise.resolve().then(operation), cancelled]);
    throwIfCodexLoginCancelled(signal);
    return result;
  } finally {
    if (abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function codexRedirectUriFromAuthUrl(authUrl: string): string | null {
  try {
    const redirectValue = new URL(authUrl).searchParams.get('redirect_uri');
    if (!redirectValue) return null;
    const redirect = new URL(redirectValue);
    if (redirect.protocol !== 'http:' || !isLoopbackHost(redirect.hostname)) return null;
    return redirect.toString();
  } catch {
    return null;
  }
}

export function validateCodexCallbackUrl(pasted: string, expectedRedirect: string): string {
  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(pasted.trim().replace(/^"(.*)"$/, '$1'));
    expected = new URL(expectedRedirect);
  } catch {
    throw new Error('Paste the complete localhost callback URL returned after ChatGPT authorization.');
  }
  if (
    callback.protocol !== 'http:'
    || !isLoopbackHost(callback.hostname)
    || callback.origin !== expected.origin
    || callback.pathname !== expected.pathname
  ) {
    throw new Error('The callback URL does not match this Codex login attempt.');
  }
  if (!callback.searchParams.has('code') && !callback.searchParams.has('error')) {
    throw new Error('The callback URL has no authorization result. Copy the final localhost URL in full.');
  }
  return callback.toString();
}

export async function submitCodexCallback(
  pasted: string,
  expectedRedirect: string,
  signal?: AbortSignal,
): Promise<void> {
  const callback = validateCodexCallbackUrl(pasted, expectedRedirect);
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(callback, {
    method: 'GET',
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status >= 400) {
    throw new Error(`Codex callback was rejected (HTTP ${response.status}).`);
  }
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface NotificationWaiter {
  method: string;
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexLoginClient {
  start(): Promise<void>;
  processId?(): number | null;
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  waitForNotification<T>(
    method: string,
    predicate?: (params: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  stop(timeoutMs?: number): Promise<void>;
}

export interface CodexLoginHomeOptions {
  /** Dependency seam for deterministic protocol tests; production uses the official app-server client. */
  clientFactory?: (home: string) => CodexLoginClient;
}

function windowsCodexCandidates(): string[] {
  const candidates: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) {
    const npmRoot = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
    candidates.push(
      path.join(npmRoot, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
      path.join(npmRoot, 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
    );
  }
  try {
    const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', timeout: 5_000 });
    candidates.push(...out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\.exe$/i.test(line) && !/[\\/]WindowsApps[\\/]/i.test(line)));
  } catch {
    /* rely on known install locations/PATH */
  }
  return candidates;
}

export function findCodexExe(): string {
  if (process.env.CODEX_BIN?.trim()) return process.env.CODEX_BIN.trim();
  if (process.platform === 'win32') {
    return windowsCodexCandidates().find((candidate) => fs.existsSync(candidate)) ?? 'codex.exe';
  }
  return 'codex';
}

export function detectCodexVersion(): string {
  try {
    return execFileSync(findCodexExe(), ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return 'unknown';
  }
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private waiters = new Set<NotificationWaiter>();
  private recentNotifications: Array<{ method: string; params: unknown }> = [];
  private stderr = '';

  constructor(
    private readonly home: string,
    private readonly forceFileCredentials = true,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const child = spawn(
      findCodexExe(),
      [...(this.forceFileCredentials ? ['-c', 'cli_auth_credentials_store="file"'] : []), 'app-server'],
      {
        env: { ...process.env, CODEX_HOME: this.home },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4_000);
    });
    child.on('exit', (code) => {
      if (this.stderr.trim()) logger.warn('codex app-server stderr before exit', { stderr: this.stderr.trim() });
      const err = new Error(`Codex app-server exited (${code ?? 'signal'}).`);
      this.failAll(err);
      this.child = null;
    });
    child.on('error', (error) => this.failAll(error));

    await this.request('initialize', {
      clientInfo: {
        name: 'claude_codex_account_switch',
        title: 'Claude + Codex Account Switch',
        version: pkg.version,
      },
    });
    this.notify('initialized', {});
  }

  processId(): number | null {
    return this.child?.pid ?? null;
  }

  request<T>(method: string, params?: unknown, timeoutMs = 20_000): Promise<T> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ method, id, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  waitForNotification<T>(
    method: string,
    predicate: (params: T) => boolean = () => true,
    timeoutMs = 10 * 60_000,
  ): Promise<T> {
    const existing = this.recentNotifications.find((n) => n.method === method && predicate(n.params as T));
    if (existing) return Promise.resolve(existing.params as T);
    return new Promise<T>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate: predicate as (params: unknown) => boolean,
        resolve: resolve as (params: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for Codex notification: ${method}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async stop(
    timeoutMs = 2_000,
    terminationTimeoutMs = Math.max(1_000, Math.min(5_000, timeoutMs)),
  ): Promise<void> {
    const child = this.child;
    if (!child) return;
    await stopCodexAppServerChild(child, timeoutMs, terminationTimeoutMs);
    if (this.child === child) this.child = null;
  }

  private write(message: RpcMessage): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      logger.warn('codex app-server emitted invalid JSON');
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? `Codex RPC error ${msg.error.code ?? ''}`));
      else pending.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    this.recentNotifications.push({ method: msg.method, params: msg.params });
    if (this.recentNotifications.length > 50) this.recentNotifications.shift();
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== msg.method || !waiter.predicate(msg.params)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(msg.params);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export async function inspectCodexHome(
  home: string,
  refreshToken = false,
  options: {
    forceFileCredentials?: boolean;
    /** Dependency seam for deterministic ownership/shutdown tests. */
    clientFactory?: (home: string) => CodexLoginClient;
  } = {},
): Promise<CodexInspection> {
  const client = options.clientFactory?.(home)
    ?? new CodexAppServerClient(home, options.forceFileCredentials ?? true);
  const leaseId = claimCodexAppServerHome(home);
  try {
    await client.start();
    writeCodexLoginHelperMarker(home, client.processId?.() ?? undefined, leaseId);
    const accountResult = await client.request<{
      account: CodexAccountInfo | null;
      requiresOpenaiAuth: boolean;
    }>('account/read', { refreshToken });
    const rateLimits = await readChatgptRateLimits(client, accountResult.account);
    const config = await client.request<{ config?: Record<string, unknown> }>('config/read', { includeLayers: false })
      .catch(() => null);
    const credentialStore = typeof config?.config?.cli_auth_credentials_store === 'string'
      ? config.config.cli_auth_credentials_store
      : undefined;
    return { ...accountResult, rateLimits, credentialStore };
  } finally {
    let stopped = false;
    try {
      await client.stop();
      stopped = true;
    } finally {
      if (stopped) clearCodexLoginHelperMarker(home, leaseId);
    }
  }
}

async function readAccountAfterChatgptLogin(
  client: CodexLoginClient,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<{ account: CodexAccountInfo | null; requiresOpenaiAuth: boolean }> {
  let result = await awaitCodexLoginStep(
    () => client.request<{ account: CodexAccountInfo | null; requiresOpenaiAuth: boolean }>(
      'account/read',
      { refreshToken: false },
    ),
    signal,
    onAbort,
  );
  if (result.account?.type === 'chatgpt') return result;
  // The official flow emits account/updated after completion. It may already
  // be buffered, so waitForNotification handles both ordering possibilities.
  try {
    await awaitCodexLoginStep(
      () => client.waitForNotification<{ authMode?: string | null }>(
        'account/updated',
        (params) => params.authMode === 'chatgpt',
        5_000,
      ),
      signal,
      onAbort,
    );
  } catch (error) {
    if (error instanceof CodexLoginCancelledError) throw error;
  }
  // `account/login/completed` can arrive just before the app-server persists the
  // account projection. Keep the login result usable instead of treating that
  // short window as an unsupported account type.
  for (let attempt = 0; attempt < 4 && result.account?.type !== 'chatgpt'; attempt++) {
    await awaitCodexLoginStep(() => sleep(250), signal, onAbort);
    result = await awaitCodexLoginStep(
      () => client.request<{ account: CodexAccountInfo | null; requiresOpenaiAuth: boolean }>(
        'account/read',
        { refreshToken: false },
      ),
      signal,
      onAbort,
    );
  }
  return result;
}

async function readChatgptRateLimits(
  client: CodexLoginClient,
  account: CodexAccountInfo | null,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<CodexRateLimitsResult | null> {
  if (account?.type !== 'chatgpt') return null;
  try {
    return await awaitCodexLoginStep(
      () => client.request<CodexRateLimitsResult>('account/rateLimits/read'),
      signal,
      onAbort,
    );
  } catch (error) {
    if (error instanceof CodexLoginCancelledError) throw error;
    // Quotas are optional. An unavailable quota endpoint cannot invalidate a
    // completed ChatGPT login or otherwise refreshable credentials.
    logger.warn('codex rate limit read unavailable', { accountType: account.type });
    return null;
  }
}

export async function loginCodexHome(
  home: string,
  onAuthUrl: (url: string) => void | Promise<void>,
  signal?: AbortSignal,
  options: CodexLoginHomeOptions = {},
): Promise<CodexInspection> {
  const client = options.clientFactory?.(home) ?? new CodexAppServerClient(home);
  const leaseId = claimCodexAppServerHome(home);
  try {
    throwIfCodexLoginCancelled(signal);
    await awaitCodexLoginStep(() => client.start(), signal);
    writeCodexLoginHelperMarker(home, client.processId?.() ?? undefined, leaseId);
    const started = await awaitCodexLoginStep(
      () => client.request<{ type: string; loginId: string; authUrl: string }>(
        'account/login/start',
        { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' },
      ),
      signal,
    );
    if (!started.authUrl) throw new Error('Codex did not return an authentication URL.');
    const cancelLogin = () => {
      void client.request('account/login/cancel', { loginId: started.loginId }, 5_000).catch(() => {});
    };
    await awaitCodexLoginStep(() => onAuthUrl(started.authUrl), signal, cancelLogin);
    const result = await awaitCodexLoginStep(
      () => client.waitForNotification<{ loginId?: string | null; success: boolean; error?: string | null }>(
        'account/login/completed',
        (params) => !params.loginId || params.loginId === started.loginId,
      ),
      signal,
      cancelLogin,
    );
    if (!result.success) throw new Error(result.error || 'Codex login failed.');
    throwIfCodexLoginCancelled(signal);
    const accountResult = await readAccountAfterChatgptLogin(client, signal, cancelLogin);
    throwIfCodexLoginCancelled(signal);
    const rateLimits = await readChatgptRateLimits(client, accountResult.account, signal, cancelLogin);
    throwIfCodexLoginCancelled(signal);
    return { ...accountResult, rateLimits };
  } finally {
    let stopped = false;
    try {
      await client.stop();
      stopped = true;
    } finally {
      if (stopped) clearCodexLoginHelperMarker(home, leaseId);
    }
  }
}
