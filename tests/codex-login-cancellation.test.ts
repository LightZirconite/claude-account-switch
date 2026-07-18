import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  CodexAppServerClient,
  CodexAppServerHomeBusyError,
  CodexAppServerShutdownError,
  CODEX_LOGIN_HELPER_MARKER,
  CodexLoginCancelledError,
  inspectCodexHome,
  loginCodexHome,
  type StoppableCodexAppServerChild,
  type CodexLoginClient,
} from '../src/codexAppServer';
import { EventEmitter } from 'node:events';
import {
  addCodexAccount,
  archiveCodexProfile,
  importCodexFromPath,
  listAbandonedCodexLoginArchives,
  listPendingCodexHomes,
  loadCodexStore,
  readCodexAuth,
  recoverAbandonedCodexHomes,
  restoreLatestCodexRecovery,
} from '../src/codexProfiles';
import {
  backupsDir,
  codexAuthPath,
  codexProfileHome,
  codexProfilesPath,
} from '../src/paths';
import type { CodexAuthFile } from '../src/types';

let root = '';

function resetRoot(): void {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-cancel-test-'));
  process.env.CLAUDE_SWITCH_HOME = path.join(root, 'switch');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'live-claude');
  process.env.CODEX_HOME = path.join(root, 'live-codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codexAuth(accountId: string, email: string): CodexAuthFile {
  const claims = { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' };
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: accountId,
      id_token: jwt({ email, 'https://api.openai.com/auth': claims }),
      access_token: jwt({ 'https://api.openai.com/auth': claims }),
      refresh_token: `refresh-${accountId}`,
    },
  };
}

async function waitForPath(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for claim worker exit.')), timeoutMs)),
  ]);
}

test.afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

class StubbornAppServerChild extends EventEmitter implements StoppableCodexAppServerChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdinEnds = 0;
  killCalls = 0;
  readonly stdin = {
    end: () => { this.stdinEnds++; },
  };

  kill(): boolean {
    this.killCalls++;
    return true;
  }
}

test('Codex app-server shutdown fails closed when the child never confirms exit', async () => {
  resetRoot();
  const child = new StubbornAppServerChild();
  const client = new CodexAppServerClient(path.join(root, 'stubborn-home'));
  const holder = client as unknown as { child: StoppableCodexAppServerChild | null };
  holder.child = child;

  await assert.rejects(client.stop(5, 5), /did not exit.*aborted/i);
  assert.equal(child.stdinEnds, 1);
  assert.equal(child.killCalls, 1);
  assert.equal(holder.child, child, 'the still-live credential owner must remain tracked');
});

test('a stubborn inspection keeps an exclusive home marker and blocks a second app-server', async () => {
  resetRoot();
  const home = path.join(root, 'stubborn-inspection-home');
  let firstStarts = 0;
  const first: CodexLoginClient = {
    async start() { firstStarts++; },
    processId: () => process.pid,
    request<T>(method: string): Promise<T> {
      if (method === 'account/read') {
        return Promise.resolve({ account: null, requiresOpenaiAuth: true } as T);
      }
      if (method === 'config/read') {
        return Promise.resolve({ config: { cli_auth_credentials_store: 'file' } } as T);
      }
      return Promise.reject(new Error(`Unexpected fake Codex request: ${method}`));
    },
    waitForNotification<T>(): Promise<T> {
      return Promise.reject(new Error('Unexpected fake Codex notification.'));
    },
    async stop() { throw new CodexAppServerShutdownError(process.pid); },
  };

  await assert.rejects(
    inspectCodexHome(home, false, { clientFactory: () => first }),
    (error) => error instanceof CodexAppServerShutdownError,
  );
  assert.equal(firstStarts, 1);
  assert.equal(fs.existsSync(path.join(home, CODEX_LOGIN_HELPER_MARKER)), true);

  let secondStarts = 0;
  const second: CodexLoginClient = {
    ...first,
    async start() { secondStarts++; },
    async stop() {},
  };
  await assert.rejects(
    inspectCodexHome(home, false, { clientFactory: () => second }),
    (error) => error instanceof CodexAppServerHomeBusyError,
  );
  assert.equal(secondStarts, 0, 'home ownership must be proven before another helper starts');
});

test('two processes cannot both take over the same exited app-server home marker', async () => {
  resetRoot();
  const home = path.join(root, 'claim-interleaving-home');
  fs.mkdirSync(home, { recursive: true });
  writeJson(path.join(home, CODEX_LOGIN_HELPER_MARKER), {
    kind: 'claude-codex-account-switch/codex-login-helper-owner',
    version: 1,
    leaseId: 'exited-generation',
    ownerPid: 2_147_483_647,
    pid: 2_147_483_647,
    createdAt: Date.now() - 60_000,
  });

  const ready = path.join(root, 'claim-a-ready');
  const proceed = path.join(root, 'claim-a-proceed');
  const release = path.join(root, 'claim-a-release');
  const resultA = path.join(root, 'claim-a-result.json');
  const resultB = path.join(root, 'claim-b-result.json');
  const moduleUrl = pathToFileURL(path.resolve('src/codexAppServer.ts')).href;
  const waitSource = `
    const waitFor = (file) => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(file) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      if (!fs.existsSync(file)) throw new Error('worker gate timeout');
    };
  `;
  const workerA = `
    import fs from 'node:fs';
    const { claimCodexAppServerHome } = await import(${JSON.stringify(moduleUrl)});
    ${waitSource}
    try {
      const lease = claimCodexAppServerHome(${JSON.stringify(home)}, {
        onLockedState: () => {
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          waitFor(${JSON.stringify(proceed)});
        },
      });
      fs.writeFileSync(${JSON.stringify(resultA)}, JSON.stringify({ ok: true, lease }));
      waitFor(${JSON.stringify(release)});
    } catch (error) {
      fs.writeFileSync(${JSON.stringify(resultA)}, JSON.stringify({ ok: false, name: error?.name, message: error?.message }));
    }
  `;
  const workerB = `
    import fs from 'node:fs';
    const { claimCodexAppServerHome } = await import(${JSON.stringify(moduleUrl)});
    try {
      const lease = claimCodexAppServerHome(${JSON.stringify(home)});
      fs.writeFileSync(${JSON.stringify(resultB)}, JSON.stringify({ ok: true, lease }));
    } catch (error) {
      fs.writeFileSync(${JSON.stringify(resultB)}, JSON.stringify({ ok: false, name: error?.name, message: error?.message }));
    }
  `;
  const spawnWorker = (source: string) => spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    { cwd: path.resolve('.'), env: { ...process.env }, stdio: 'ignore', windowsHide: true },
  );
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = spawnWorker(workerA);
    await waitForPath(ready);
    second = spawnWorker(workerB);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(resultB), false, 'the second claimant must wait behind the home lock');
    fs.writeFileSync(proceed, 'proceed');
    await Promise.all([waitForPath(resultA), waitForPath(resultB)]);
    const a = JSON.parse(fs.readFileSync(resultA, 'utf8')) as { ok: boolean; name?: string };
    const b = JSON.parse(fs.readFileSync(resultB, 'utf8')) as { ok: boolean; name?: string };
    assert.equal(a.ok, true);
    assert.deepEqual(b, { ok: false, name: 'CodexAppServerHomeBusyError', message: 'A Codex app-server owner is still active for this credential home.' });
  } finally {
    fs.writeFileSync(proceed, 'proceed');
    fs.writeFileSync(release, 'release');
    if (first) await waitForChildExit(first).catch(() => first?.kill());
    if (second) await waitForChildExit(second).catch(() => second?.kill());
  }
});

test('official Codex login observes cancellation after account/read and before returning credentials', async () => {
  resetRoot();
  const controller = new AbortController();
  let accountReads = 0;
  let rateLimitReads = 0;
  let cancellationRequests = 0;
  let stopped = false;

  const client: CodexLoginClient = {
    async start() {},
    request<T>(method: string): Promise<T> {
      if (method === 'account/login/start') {
        return Promise.resolve({
          type: 'chatgpt',
          loginId: 'login-after-read',
          authUrl: 'https://auth.openai.test/authorize',
        } as T);
      }
      if (method === 'account/read') {
        accountReads++;
        const result = {
          account: { type: 'chatgpt', email: 'candidate@example.test', planType: 'pro' },
          requiresOpenaiAuth: false,
        };
        // Resolve the official account projection first, then let Escape win before
        // the awaiting login continuation can proceed to quotas or commit.
        return new Promise<T>((resolve) => {
          resolve(result as T);
          queueMicrotask(() => controller.abort());
        });
      }
      if (method === 'account/rateLimits/read') {
        rateLimitReads++;
        return Promise.resolve({ rateLimits: null } as T);
      }
      if (method === 'account/login/cancel') {
        cancellationRequests++;
        return Promise.resolve({} as T);
      }
      return Promise.reject(new Error(`Unexpected fake Codex request: ${method}`));
    },
    waitForNotification<T>(method: string): Promise<T> {
      if (method !== 'account/login/completed') {
        return Promise.reject(new Error(`Unexpected fake Codex notification: ${method}`));
      }
      return Promise.resolve({ loginId: 'login-after-read', success: true } as T);
    },
    async stop() { stopped = true; },
  };

  await assert.rejects(
    loginCodexHome(
      path.join(root, 'completed-sandbox'),
      () => undefined,
      controller.signal,
      { clientFactory: () => client },
    ),
    (error) => error instanceof CodexLoginCancelledError,
  );
  assert.equal(accountReads, 1);
  assert.equal(rateLimitReads, 0);
  assert.equal(cancellationRequests, 1);
  assert.equal(stopped, true);
});

test('cancellation after completed Codex inspection preserves profiles and archives the auth sandbox', async () => {
  resetRoot();
  const existingFile = path.join(root, 'existing-auth.json');
  writeJson(existingFile, codexAuth('existing-account', 'existing@example.test'));
  const [existing] = await importCodexFromPath(existingFile);
  const storeBefore = fs.readFileSync(codexProfilesPath());
  const existingAuthPath = codexAuthPath(codexProfileHome(existing.id));
  const existingAuthBefore = fs.readFileSync(existingAuthPath);
  const controller = new AbortController();

  await assert.rejects(
    addCodexAccount(
      () => undefined,
      controller.signal,
      {
        login: async (home) => {
          writeJson(codexAuthPath(home), codexAuth('cancelled-candidate', 'candidate@example.test'));
          // Model Escape arriving after login/completed plus account/read, but before
          // addCodexAccount is allowed to perform its synchronous durable upsert.
          controller.abort();
          return {
            account: { type: 'chatgpt', email: 'candidate@example.test', planType: 'pro' },
            requiresOpenaiAuth: false,
            rateLimits: null,
          };
        },
      },
    ),
    (error) => error instanceof CodexLoginCancelledError,
  );

  assert.deepEqual(fs.readFileSync(codexProfilesPath()), storeBefore);
  assert.deepEqual(fs.readFileSync(existingAuthPath), existingAuthBefore);
  assert.deepEqual(loadCodexStore().profiles.map((profile) => profile.accountId), ['existing-account']);
  assert.deepEqual(listPendingCodexHomes(), []);

  const abandonedRoot = path.join(backupsDir(), 'codex-abandoned');
  const archived = fs.readdirSync(abandonedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(archived.length, 1);
  const archivedHome = path.join(abandonedRoot, archived[0].name);
  assert.equal(readCodexAuth(archivedHome)?.tokens.account_id, 'cancelled-candidate');
  const marker = JSON.parse(fs.readFileSync(path.join(archivedHome, 'abandoned.json'), 'utf8')) as {
    reason?: string;
  };
  assert.equal(marker.reason, 'cancelled');
});

test('shutdown-uncertain Codex login keeps its home in place until helper exit is proven', async () => {
  resetRoot();
  const existingFile = path.join(root, 'existing-auth.json');
  writeJson(existingFile, codexAuth('existing-account', 'existing@example.test'));
  const [existing] = await importCodexFromPath(existingFile);
  const storeBefore = fs.readFileSync(codexProfilesPath());
  const existingAuthPath = codexAuthPath(codexProfileHome(existing.id));
  const existingAuthBefore = fs.readFileSync(existingAuthPath);
  let pendingHome = '';

  const client: CodexLoginClient = {
    async start() {},
    processId: () => process.pid,
    request<T>(method: string): Promise<T> {
      if (method === 'account/login/start') {
        return Promise.resolve({
          type: 'chatgpt',
          loginId: 'shutdown-uncertain',
          authUrl: 'https://auth.openai.test/authorize',
        } as T);
      }
      if (method === 'account/read') {
        writeJson(codexAuthPath(pendingHome), codexAuth('candidate-account', 'candidate@example.test'));
        return Promise.resolve({
          account: { type: 'chatgpt', email: 'candidate@example.test', planType: 'pro' },
          requiresOpenaiAuth: false,
        } as T);
      }
      if (method === 'account/rateLimits/read') {
        return Promise.resolve({ rateLimits: null } as T);
      }
      return Promise.reject(new Error(`Unexpected fake Codex request: ${method}`));
    },
    waitForNotification<T>(method: string): Promise<T> {
      if (method !== 'account/login/completed') {
        return Promise.reject(new Error(`Unexpected fake Codex notification: ${method}`));
      }
      return Promise.resolve({ loginId: 'shutdown-uncertain', success: true } as T);
    },
    async stop() {
      throw new CodexAppServerShutdownError(process.pid);
    },
  };

  await assert.rejects(
    addCodexAccount(
      () => undefined,
      undefined,
      {
        login: (home, onAuthUrl, signal) => {
          pendingHome = home;
          return loginCodexHome(home, onAuthUrl, signal, { clientFactory: () => client });
        },
      },
    ),
    (error) => error instanceof CodexAppServerShutdownError,
  );

  assert.deepEqual(fs.readFileSync(codexProfilesPath()), storeBefore);
  assert.deepEqual(fs.readFileSync(existingAuthPath), existingAuthBefore);
  assert.deepEqual(loadCodexStore().profiles.map((profile) => profile.accountId), ['existing-account']);
  const pending = listPendingCodexHomes();
  assert.equal(pending.length, 1);
  assert.equal(codexProfileHome(pending[0].name), pendingHome);
  assert.equal(readCodexAuth(pendingHome)?.tokens.account_id, 'candidate-account');
  const helperMarker = JSON.parse(
    fs.readFileSync(path.join(pendingHome, CODEX_LOGIN_HELPER_MARKER), 'utf8'),
  ) as { pid?: number | null };
  assert.equal(helperMarker.pid, process.pid);

  assert.deepEqual(recoverAbandonedCodexHomes(0), []);
  assert.equal(fs.existsSync(pendingHome), true, 'a possibly-live helper home must never be renamed');
});

test('strict abandoned-login inventory and z recovery preserve evidence and prefer a normal tombstone', async () => {
  resetRoot();
  const normalImport = path.join(root, 'normal-auth.json');
  writeJson(normalImport, codexAuth('normal-tombstone', 'normal@example.test'));
  const [normal] = await importCodexFromPath(normalImport);
  await archiveCodexProfile(normal.id, {
    inspect: async () => ({ credentialStore: 'file', account: null }),
  });

  const abandonedRoot = path.join(backupsDir(), 'codex-abandoned');
  const older = path.join(abandonedRoot, 'older-valid');
  const newest = path.join(abandonedRoot, 'newest-valid');
  const corrupt = path.join(abandonedRoot, 'newest-but-corrupt-auth');
  const invalidManifest = path.join(abandonedRoot, 'invalid-manifest');
  const now = Date.now();
  const manifest = (archivedAt: number) => ({
    kind: 'claude-codex-account-switch/codex-abandoned-login',
    version: 1,
    archivedAt,
    reason: 'cancelled',
  });
  writeJson(path.join(older, 'abandoned.json'), manifest(now - 2_000));
  writeJson(codexAuthPath(older), codexAuth('abandoned-older', 'older@example.test'));
  writeJson(path.join(newest, 'abandoned.json'), manifest(now - 1_000));
  const newestAuth = codexAuth('abandoned-newest', 'newest@example.test');
  writeJson(codexAuthPath(newest), newestAuth);
  const newestAuthBefore = fs.readFileSync(codexAuthPath(newest));
  writeJson(path.join(corrupt, 'abandoned.json'), manifest(now));
  writeJson(codexAuthPath(corrupt), { auth_mode: 'chatgpt', tokens: { account_id: 'broken' } });
  writeJson(path.join(invalidManifest, 'abandoned.json'), { ...manifest(now + 1_000), reason: 'unexpected' });
  writeJson(codexAuthPath(invalidManifest), codexAuth('invalid-manifest-account', 'invalid@example.test'));

  const inventory = listAbandonedCodexLoginArchives();
  assert.equal(inventory.length, 4);
  assert.equal(inventory.filter((archive) => archive.recoverable).length, 2);
  assert.equal(inventory.find((archive) => archive.directory === corrupt)?.authStatus, 'corrupt');
  assert.equal(inventory.find((archive) => archive.directory === corrupt)?.recoverable, false);
  assert.equal(inventory.find((archive) => archive.directory === invalidManifest)?.manifestStatus, 'invalid');
  assert.equal(inventory.find((archive) => archive.directory === invalidManifest)?.recoverable, false);

  const tombstoneFirst = await restoreLatestCodexRecovery();
  assert.equal(tombstoneFirst.source, 'tombstone');
  assert.equal(tombstoneFirst.profile.id, normal.id);
  assert.equal(listAbandonedCodexLoginArchives().filter((archive) => archive.recoverable).length, 2);

  const abandonedSecond = await restoreLatestCodexRecovery();
  assert.equal(abandonedSecond.source, 'abandoned');
  if (abandonedSecond.source !== 'abandoned') assert.fail('Expected abandoned Codex recovery.');
  assert.equal(abandonedSecond.archive.directory, newest);
  assert.equal(abandonedSecond.profile.accountId, 'abandoned-newest');
  assert.equal(abandonedSecond.archiveMarkedRecovered, true);
  assert.equal(abandonedSecond.store.activeProfileId, null);
  assert.equal(readCodexAuth(codexProfileHome(abandonedSecond.profile.id))?.tokens.refresh_token, newestAuth.tokens.refresh_token);
  assert.equal(fs.existsSync(newest), true);
  assert.deepEqual(fs.readFileSync(codexAuthPath(newest)), newestAuthBefore);

  const after = listAbandonedCodexLoginArchives();
  assert.equal(after.find((archive) => archive.directory === newest)?.recoverable, false);
  assert.ok(after.find((archive) => archive.directory === newest)?.recoveredAt);
  assert.equal(after.find((archive) => archive.directory === older)?.recoverable, true);
});
