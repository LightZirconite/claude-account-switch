import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/cli.tsx'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Keep npm deps (ink, react, clipboardy, jsonc-parser) external; only bundle our own source.
  // Avoids bundling ink's yoga WASM and keeps the build simple/robust.
  packages: 'external',
  jsx: 'automatic',
  logLevel: 'info',
  // Provide a CommonJS-style require + __dirname shim in case any external dep needs it.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __dirname_fn } from 'path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_fn(__filename);',
    ].join('\n'),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild: watching for changes...');
} else {
  await esbuild.build(options);
  console.log('esbuild: build complete -> dist/cli.js');
}
