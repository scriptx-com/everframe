// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const { version } = JSON.parse(readFileSync(source('./package.json'), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // The public types are the package's own; nothing from zod or the private
  // workspace packages reaches index.d.ts.
  dts: true,
  clean: true,
  // One file: Vega apps bundle it with Metro 0.76, which has no use for
  // shared chunks and resolves only `main`/`react-native`.
  splitting: false,
  sourcemap: false,
  // Readable output. Vega's own build does not minify (`minify: false`), and
  // the frames a crash report carries are only as good as this file's names.
  minify: false,
  // ES2019 and no esbuild `keepNames`: RN 0.72's Babel preset cannot parse
  // `static {}` class blocks, which es2022 + keepNames emits. Metro still
  // transforms this file; the target only has to be parseable by that Babel.
  target: 'es2019',
  platform: 'browser',
  outDir: 'dist',
  external: ['react-native'],
  // Reports carry the installed package version (src/version.ts).
  define: { __EVERFRAME_VEGA_VERSION__: JSON.stringify(version) },
  // Internal workspace packages are private and never published: inline them.
  // Build from their sources so `sideEffects: false` drops whole unused
  // modules (relay, vtree, reporter UI contracts) instead of one prebuilt file.
  noExternal: ['@everframe/sdk-core', '@everframe/protocol', '@noble/hashes'],
  esbuildOptions(options) {
    options.alias = {
      '@everframe/sdk-core': source('../sdk-core/src/index.ts'),
      '@everframe/protocol': source('../protocol/src/index.ts'),
    };
  },
});
