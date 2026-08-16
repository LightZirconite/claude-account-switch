import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const deferred = require('../scripts/deferred-migration-export.cjs') as {
  isProviderBusyDiagnostic(diagnostic: string): boolean;
  retryableExportFailure(diagnostic: string): 'provider-busy' | 'source-changed' | null;
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
