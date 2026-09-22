// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // No sourcemaps in published artifacts — release-pipeline policy.
  // sdk-core ships inside sdk-react's bundle (and as its own npm package),
  // so a .map would expose internal redaction / envelope / retry logic
  // even though only the bundle is the public-facing artifact.
  sourcemap: false,
  // Minify to match sdk-react's posture; keepNames so React DevTools +
  // production stack traces still surface useful component / function names
  // through the dependency boundary.
  minify: true,
  esbuildOptions(options) {
    options.keepNames = true;
  },
  target: 'es2022',
  outDir: 'dist',
});
