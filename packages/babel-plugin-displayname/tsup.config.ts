// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Babel plugins are loaded by @babel/core via require(), so this plugin must
// ship as CJS (`.cjs`). The workspace ESM-only policy applies to *runtime*
// JS modules consumed by app code; Babel plugin entry points are tooling that
// runs inside @babel/core's loader, which is CJS-by-design.
import { defineConfig } from 'tsup';

// dts handled by post-build copy (the source is .cjs hand-written, not TS).
import { copyFileSync } from 'node:fs';

export default defineConfig({
  entry: ['src/index.cjs'],
  format: ['cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  outDir: 'dist',
  onSuccess: async () => {
    copyFileSync('src/index.d.ts', 'dist/index.d.ts');
    // ATTW expects matching .d.cts for the require condition pointing at .cjs
    copyFileSync('src/index.d.ts', 'dist/index.d.cts');
  },
});
