'use strict';

// One-shot Windows migration job. It waits for Claude/Codex to close normally,
// then calls the same guarded CLI export and verifies the finished archive.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RETRY_MS = 30_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const CHILD_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function absoluteField(job, name) {
  const value = job[name];
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`Deferred migration job field ${name} must be an absolute single-line path.`);
  }
  return path.resolve(value);
}

function readJob(file) {
  const selected = path.resolve(file);
  const stat = fs.lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deferred migration job must be a regular file.');
  const parsed = JSON.parse(fs.readFileSync(selected, 'utf8'));
  if (parsed.version !== 1) throw new Error('Unsupported deferred migration job version.');
  const job = {
    jobFile: selected,
    cli: absoluteField(parsed, 'cli'),
    archive: absoluteField(parsed, 'archive'),
    passphraseFile: absoluteField(parsed, 'passphraseFile'),
    statusFile: absoluteField(parsed, 'statusFile'),
    switchHome: absoluteField(parsed, 'switchHome'),
    claudeConfig: absoluteField(parsed, 'claudeConfig'),
    codexHome: absoluteField(parsed, 'codexHome'),
    codexBin: absoluteField(parsed, 'codexBin'),
    taskName: typeof parsed.taskName === 'string' ? parsed.taskName : '',
    startupShortcut: typeof parsed.startupShortcut === 'string'
      ? absoluteField(parsed, 'startupShortcut')
      : '',
  };
  const samePath = (left, right) => process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
  const expectedCli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  if (!samePath(job.cli, expectedCli)) {
    throw new Error('Deferred migration job CLI path does not match this installed switcher.');
  }
  if (job.taskName && job.taskName !== 'ClaudeCodexMigrationBackup-Coder') {
    throw new Error('Deferred migration job contains an unexpected scheduled-task name.');
  }
  if (job.startupShortcut) {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error('APPDATA is required to validate the one-shot Startup shortcut.');
    const expectedShortcut = path.join(
      appData,
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ClaudeCodexMigrationBackup-Coder.lnk',
    );
    if (!samePath(job.startupShortcut, expectedShortcut)) {
      throw new Error('Deferred migration job contains an unexpected Startup shortcut path.');
    }
  }
  if (!samePath(path.dirname(job.archive), path.dirname(job.statusFile))
      || !samePath(path.dirname(job.archive), path.dirname(job.jobFile))) {
    throw new Error('Archive, status, and job files must stay in the same migration folder.');
  }
  if (!job.archive.toLowerCase().endsWith('.ccswitch-migration')) {
    throw new Error('Deferred migration output must use the .ccswitch-migration extension.');
  }
  return job;
}

function atomicStatus(job, state, extra = {}) {
  const status = {
    version: 1,
    state,
    updatedAt: new Date().toISOString(),
    archive: path.basename(job.archive),
    passphraseFileOnSourceMachine: job.passphraseFile,
    ...extra,
  };
  const temp = `${job.statusFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, job.statusFile);
}

function runCli(job, args) {
  const runtime = [
    '--switch-home', job.switchHome,
    '--claude-config', job.claudeConfig,
    '--codex-home', job.codexHome,
    '--codex-bin', job.codexBin,
  ];
  return spawnSync(process.execPath, [job.cli, ...args, ...runtime], {
    cwd: path.resolve(path.dirname(job.cli), '..'),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function cleanupRegistration(job) {
  if (process.platform === 'win32' && /^[A-Za-z0-9_. -]{1,120}$/u.test(job.taskName)) {
    spawnSync('schtasks.exe', ['/Delete', '/TN', job.taskName, '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
  }
  if (job.startupShortcut && path.basename(job.startupShortcut) === 'ClaudeCodexMigrationBackup-Coder.lnk') {
    try { fs.rmSync(job.startupShortcut, { force: true }); } catch { /* best-effort cleanup */ }
  }
  try {
    fs.rmSync(path.join(path.dirname(job.jobFile), '.deferred-export.lock.interrupted'), { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(job.jobFile), '.deferred-export.lock.interrupted-2'), { recursive: true, force: true });
  } catch {
    // These are diagnostic remnants only; archive verification remains authoritative.
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProviderBusyDiagnostic(diagnostic) {
  return /Close (?:Claude|Codex) (?:Code\/Desktop|CLI\/Desktop)(?: normally)? before migration export/iu.test(diagnostic);
}

function retryableExportFailure(diagnostic) {
  if (isProviderBusyDiagnostic(diagnostic)) return 'provider-busy';
  if (/Migration source(?:s)? changed while (?:it|the archive) was being encrypted/iu.test(diagnostic)) {
    return 'source-changed';
  }
  return null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function acquireLock(job) {
  const lock = path.join(path.dirname(job.jobFile), '.deferred-export.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 2 * 60 * 1000) return null;
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
  return lock;
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('Usage: node deferred-migration-export.cjs <absolute-job.json>');
  const job = readJob(jobFile);
  const lock = acquireLock(job);
  if (!lock) return;
  const deadline = Date.now() + MAX_WAIT_MS;
  try {
    fs.mkdirSync(path.dirname(job.archive), { recursive: true });
    if (!fs.existsSync(job.passphraseFile)) throw new Error('The separate migration recovery-key file is missing.');

    while (!fs.existsSync(job.archive) && Date.now() < deadline) {
      fs.utimesSync(lock, new Date(), new Date());
      atomicStatus(job, 'exporting', {
        note: 'The guarded encrypted export is running. Keep Claude and Codex closed until state becomes complete.',
      });
      const exported = runCli(job, [
        'migration', 'export',
        '--output', job.archive,
        '--passphrase-file', job.passphraseFile,
      ]);
      if (exported.status === 0 && fs.existsSync(job.archive)) break;
      const diagnostic = `${exported.stdout ?? ''}\n${exported.stderr ?? ''}`;
      const retryReason = retryableExportFailure(diagnostic);
      if (retryReason === 'provider-busy') {
        atomicStatus(job, 'waiting-for-claude-and-codex-to-close', {
          note: 'Close Claude Code/Desktop and Codex CLI/Desktop normally. The guarded export starts automatically afterward.',
        });
        await sleep(RETRY_MS);
        continue;
      }
      if (retryReason === 'source-changed') {
        atomicStatus(job, 'retrying-after-source-change', {
          note: 'A migration source changed before publication. Nothing partial was published; the guarded export will retry automatically.',
        });
        await sleep(RETRY_MS);
        continue;
      }
      atomicStatus(job, 'failed', {
        failureCode: 'unexpected-export-error',
        diagnosticLog: path.join(job.switchHome, 'logs', 'switch.log'),
        note: 'The guarded export failed unexpectedly. The redacted switcher log contains the diagnostic; no partial archive was published.',
      });
      cleanupRegistration(job);
      return;
    }

    if (!fs.existsSync(job.archive)) {
      atomicStatus(job, 'timed-out', { note: 'Claude or Codex remained open for seven days; no archive was created.' });
      cleanupRegistration(job);
      return;
    }

    atomicStatus(job, 'verifying', { sizeBytes: fs.statSync(job.archive).size });
    const verified = runCli(job, [
      'migration', 'verify', job.archive,
      '--passphrase-file', job.passphraseFile,
    ]);
    if (verified.status !== 0) {
      atomicStatus(job, 'failed-verification', {
        sizeBytes: fs.statSync(job.archive).size,
        note: 'The archive exists but did not pass authenticated decryption and per-file hash verification. Do not import it.',
      });
      cleanupRegistration(job);
      return;
    }

    const digest = await sha256(job.archive);
    atomicStatus(job, 'complete', {
      sizeBytes: fs.statSync(job.archive).size,
      sha256: digest,
      note: 'Authenticated decryption and every internal file SHA-256 were verified. Keep the recovery key separately.',
    });
    cleanupRegistration(job);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(() => {
    // The caller receives only a generic exit code; secrets and provider output are never logged.
    process.exitCode = 1;
  });
}

module.exports = { isProviderBusyDiagnostic, retryableExportFailure };
