import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const deferred = require('../scripts/deferred-migration-export.cjs') as {
  isProviderBusyDiagnostic(diagnostic: string): boolean;
  retryableExportFailure(diagnostic: string): 'provider-busy' | 'source-changed' | null;
  runCli(
    job: Record<string, string>,
    args: string[],
    onHeartbeat?: (elapsedMs: number) => void,
    timing?: { heartbeatMs?: number; timeoutMs?: number },
  ): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>;
};

test('deferred migration retries only guarded transient export failures', () => {
  assert.equal(
    deferred.isProviderBusyDiagnostic('Close Claude Code/Desktop normally before migration export (process 42). Nothing was changed.'),
    true,
  );
  assert.equal(
    deferred.isProviderBusyDiagnostic('Close Codex CLI/Desktop before migration export (process 84). Nothing was changed.'),
    true,
  );
  assert.equal(
    deferred.isProviderBusyDiagnostic('Migration sources changed while the archive was being encrypted.'),
    false,
  );
  assert.equal(
    deferred.retryableExportFailure('Close Codex CLI/Desktop before migration export (process 84). Nothing was changed.'),
    'provider-busy',
  );
  assert.equal(
    deferred.retryableExportFailure('Migration source changed while it was being encrypted: codex/.sandbox/sandbox.log'),
    'source-changed',
  );
  assert.equal(
    deferred.retryableExportFailure('Migration sources changed while the archive was being encrypted.'),
    'source-changed',
  );
  assert.equal(
    deferred.isProviderBusyDiagnostic('Migration decryption failed: wrong passphrase.'),
    false,
  );
  assert.equal(deferred.retryableExportFailure('Migration decryption failed: wrong passphrase.'), null);
});

test('deferred migration keeps a heartbeat while its child command is active', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-deferred-heartbeat-'));
  try {
    const cli = path.join(root, 'slow-cli.cjs');
    fs.writeFileSync(cli, 'setTimeout(() => process.exit(0), 120);\n');
    let heartbeats = 0;
    const result = await deferred.runCli({
      cli,
      switchHome: path.join(root, 'switch'),
      claudeConfig: path.join(root, 'claude'),
      codexHome: path.join(root, 'codex'),
      codexBin: path.join(root, 'codex'),
    }, [], () => { heartbeats++; }, { heartbeatMs: 20, timeoutMs: 2_000 });
    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
    assert.ok(heartbeats >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
