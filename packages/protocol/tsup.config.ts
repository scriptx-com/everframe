// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Same policy as sdk-core / sdk-react: no sourcemaps in published
  // artifacts, minify to keep download size small.
  sourcemap: false,
  minify: true,
  esbuildOptions(options) {
    options.keepNames = true;
  },
  target: 'es2022',
  outDir: 'dist',
});
