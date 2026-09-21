// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['__tests__/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60000, // SWC + WASM cold-start can take a moment
  },
});
