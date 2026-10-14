// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/vcs.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
