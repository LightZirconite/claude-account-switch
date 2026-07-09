import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { logger } from './logger';
import type { CodexRateLimitBucket } from './types';

export interface CodexAccountInfo {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface CodexRateLimitsResult {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket>;
  rateLimitResetCredits?: { availableCount?: number; credits?: unknown[] | null } | null;
}

export interface CodexInspection {
  account: CodexAccountInfo | null;
  requiresOpenaiAuth: boolean;
  rateLimits: CodexRateLimitsResult | null;
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

  constructor(private readonly home: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const child = spawn(
      findCodexExe(),
      ['-c', 'cli_auth_credentials_store="file"', 'app-server'],
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
      const err = new Error(`Codex app-server exited (${code ?? 'signal'})${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
      this.failAll(err);
      this.child = null;
    });
    child.on('error', (error) => this.failAll(error));

    await this.request('initialize', {
      clientInfo: {
        name: 'claude_codex_account_switch',
        title: 'Claude + Codex Account Switch',
        version: '2.0.0',
      },
    });
    this.notify('initialized', {});
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

  async stop(timeoutMs = 2_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      /* best effort */
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!graceful) {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    }
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

export async function inspectCodexHome(home: string, refreshToken = false): Promise<CodexInspection> {
  const client = new CodexAppServerClient(home);
  try {
    await client.start();
    const accountResult = await client.request<{
      account: CodexAccountInfo | null;
      requiresOpenaiAuth: boolean;
    }>('account/read', { refreshToken });
    let rateLimits: CodexRateLimitsResult | null = null;
    if (accountResult.account?.type === 'chatgpt') {
      rateLimits = await client.request<CodexRateLimitsResult>('account/rateLimits/read');
    }
    return { ...accountResult, rateLimits };
  } finally {
    await client.stop();
  }
}

export async function loginCodexHome(
  home: string,
  onAuthUrl: (url: string) => void,
): Promise<CodexInspection> {
  const client = new CodexAppServerClient(home);
  try {
    await client.start();
    const completed = client.waitForNotification<{ loginId?: string | null; success: boolean; error?: string | null }>(
      'account/login/completed',
    );
    const started = await client.request<{ type: string; loginId: string; authUrl: string }>(
      'account/login/start',
      { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' },
    );
    if (!started.authUrl) throw new Error('Codex did not return an authentication URL.');
    onAuthUrl(started.authUrl);
    const result = await completed;
    if (!result.success) throw new Error(result.error || 'Codex login failed.');
    const accountResult = await client.request<{ account: CodexAccountInfo | null; requiresOpenaiAuth: boolean }>(
      'account/read',
      { refreshToken: false },
    );
    const rateLimits = accountResult.account?.type === 'chatgpt'
      ? await client.request<CodexRateLimitsResult>('account/rateLimits/read')
      : null;
    return { ...accountResult, rateLimits };
  } finally {
    await client.stop();
  }
}
