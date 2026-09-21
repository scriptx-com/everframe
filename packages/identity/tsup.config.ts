// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'es2022',
  outDir: 'dist',
  // 'neutral' rather than 'node' or 'browser': this package runs on Workers,
  // Deno, Bun and Node alike, so esbuild must not resolve platform-specific
  // conditions on our behalf.
  platform: 'neutral',
  // jose is public on npm, so it stays a real dependency — consumers dedupe it
  // and can patch it for CVEs. (sdk-react bundles sdk-core/protocol only
  // because those are private: true and will never exist on npm.)
  external: ['jose'],
  splitting: false,
  treeshake: true,
  // No minify: this is a server-side package a customer may need to read a
  // stack trace through, and there is no bundle-size pressure on a backend.
  minify: false,
});
