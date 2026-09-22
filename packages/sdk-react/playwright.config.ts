// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 3 e2e config — populated by plan 03-08:
 * - examples/react-web Next.js dev server bootstrapped via `webServer`
 * - 5 specs: strict-csp, ssr-fixture, ingest-submit, blur-bake, seeded-pii
 * - 3 browser projects: chromium, firefox, webkit
 *
 * Set E2E_SKIP_WEBSERVER=1 to bypass the Next.js startup (e.g. when using an
 * already-running dev server or in CI matrices that boot the app externally).
 */
const PORT = process.env.E2E_PORT ?? '3000';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.SDK_REACT_E2E_BASE_URL ?? BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer:
    process.env.E2E_SKIP_WEBSERVER === '1'
      ? undefined
      : {
          command: `pnpm --filter examples-react-web dev -p ${PORT}`,
          url: BASE_URL,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          // Ingest URL is baked into @traceitx/react via tsup `define`
          // (TRACEITX_INGEST_URL env at sdk-react build time). E2E inherits
          // whatever the local sdk-react `dist/` was built with — point it
          // at the stub server by rebuilding sdk-react with
          // TRACEITX_INGEST_URL=http://127.0.0.1:8787 before running E2E.
        },
});
