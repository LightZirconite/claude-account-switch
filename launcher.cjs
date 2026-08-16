'use strict';

// Stable entry point for persisted shortcuts. The compiled CLI is intentionally
// not committed, so a fresh checkout or an npm clean can remove dist/cli.js.
// This bootstrap repairs the local install before handing argv to the CLI.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MINIMUM_NODE_MAJOR = 22;

function launcherState(root = __dirname, node = process.execPath) {
  return {
    root: path.resolve(root),
    node: path.resolve(node),
    dependencies: path.join(path.resolve(root), 'node_modules'),
    entry: path.join(path.resolve(root), 'dist', 'cli.js'),
  };
}

function requiredRepairs(state) {
  return {
    installDependencies: !fs.existsSync(state.dependencies),
    build: !fs.existsSync(state.entry),
  };
}

function npmInvocation(node) {
  if (process.platform !== 'win32') return { exe: 'npm', prefix: [] };

  // A .cmd file cannot be executed directly by child_process with shell:false.
  // Official Windows Node installers and common version managers keep npm here.
  const npmCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) return { exe: node, prefix: [npmCli] };
  return null;
}

function run(exe, args, cwd) {
  const result = spawnSync(exe, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function waitForEnter() {
  if (!process.stdin.isTTY) return;
  process.stderr.write('\nAppuyez sur Entrée pour fermer cette fenêtre...');
  const byte = Buffer.alloc(1);
  try {
    while (fs.readSync(process.stdin.fd, byte, 0, 1, null) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
    }
  } catch {
    // The actionable error above remains visible when the host owns stdin.
  }
}

function fail(message) {
  process.stderr.write(`\nClaude + Codex Account Switch: ${message}\n`);
  waitForEnter();
  return 1;
}

function main(argv = process.argv.slice(2)) {
  const state = launcherState();
  const repairs = requiredRepairs(state);
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    return fail(`Node.js ${MINIMUM_NODE_MAJOR} ou plus récent est requis (version détectée : ${process.versions.node}).`);
  }

  const npm = npmInvocation(state.node);
  if (!npm && (repairs.installDependencies || repairs.build)) {
    return fail('npm est introuvable près de Node.js. Réinstallez Node.js avec npm, puis relancez le raccourci.');
  }

  try {
    if (repairs.installDependencies) {
      process.stdout.write('Préparation des dépendances locales…\n');
      if (run(npm.exe, [...npm.prefix, 'ci'], state.root) !== 0) {
        return fail('npm ci a échoué. Vérifiez la connexion réseau et relancez le raccourci.');
      }
    }

    if (!fs.existsSync(state.entry)) {
      process.stdout.write('Reconstruction de l’application…\n');
      if (run(npm.exe, [...npm.prefix, 'run', 'build'], state.root) !== 0) {
        return fail('la compilation a échoué. Consultez les erreurs ci-dessus, puis relancez le raccourci.');
      }
    }

    if (!fs.existsSync(state.entry)) {
      return fail('la compilation n’a pas produit dist/cli.js.');
    }

    const status = run(state.node, [state.entry, ...argv], state.root);
    if (status !== 0) return fail(`l’application s’est arrêtée avec le code ${status}.`);
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { launcherState, requiredRepairs, npmInvocation, main };
