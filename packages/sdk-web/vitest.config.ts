// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.js'; // NAMED import per Phase-2 lock — default resolves undefined

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'sdk-web',
      environment: 'jsdom',
      include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
      setupFiles: ['./__tests__/_setup.ts'],
    },
    // Mirror tsup's `define` so `INGEST_URL` resolves to a known test value at
    // transform time. Tests that need to assert on the URL just compare against
    // this same constant; tests that want a custom URL set the env var.
    define: {
      __EVERFRAME_INGEST_URL__: JSON.stringify(
        process.env.EVERFRAME_INGEST_URL ?? 'http://localhost:8787',
      ),
    },
  }),
);
