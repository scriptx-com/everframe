// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// e2e for the framework-agnostic entry. Modelled on
// packages/sdk-react/playwright.config.ts, but the host page is a static file
// rather than a Next.js app — the whole point of the suite is that no
// framework is involved.
//
// The suite runs against the BUILT dist/, so `pnpm build` has to have run
// first: it is the shipped artifact's chunk graph (eager entry + lazy React
// island) that the specs assert on, not the source.
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '8899';
const BASE_URL = `http://127.0.0.1:${PORT}`;
// The Vue SUT. Its port is pinned by examples/vue-web/vite.config.ts
// (strictPort), so a busy port fails loudly instead of serving the specs a
// different app on a port Vite picked for itself.
const VUE_PORT = process.env.E2E_VUE_PORT ?? '3020';
const VUE_BASE_URL = `http://127.0.0.1:${VUE_PORT}`;
const SKIP_VUE_SERVER = process.env.E2E_SKIP_VUE_SERVER === 'true';

const webServer = [
  {
    command: `node e2e/static-server.mjs`,
    env: { E2E_PORT: PORT },
    url: `${BASE_URL}/e2e/fixtures/plain.html`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
  ...(SKIP_VUE_SERVER
    ? []
    : [{
        // `dev`, not `preview`: the specs run against source so a failure points
        // at a file you can edit. The SDK itself is still the BUILT dist/ — Vite
        // resolves @everframe/web through the workspace link to its dist.
        command: `pnpm --filter examples-vue-web dev`,
        // Threaded to examples/vue-web/vite.config.ts, which reads this same
        // var for its dev-server port (defaulting to 3020 too) — without this,
        // E2E_VUE_PORT would change VUE_PORT above but Vite would keep serving
        // 3020 regardless, and Playwright would wait forever on a port nothing
        // is listening on.
        env: { E2E_VUE_PORT: VUE_PORT },
        url: VUE_BASE_URL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      }]),
];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No local retries. A capture or focus assertion that only passes on the
  // second attempt is a finding, not a pass.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [
    // The fixture suite: the SHIPPED artifact's chunk graph. Unchanged, other
    // than being told not to collect the Vue specs.
    { name: 'chromium', testIgnore: /vue\//, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testIgnore: /vue\//, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testIgnore: /vue\//, use: { ...devices['Desktop Safari'] } },
    // The app suite: does the SDK work inside a real framework app.
    {
      name: 'vue-chromium',
      testMatch: /vue\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: VUE_BASE_URL },
    },
    {
      name: 'vue-firefox',
      testMatch: /vue\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'], baseURL: VUE_BASE_URL },
    },
    {
      name: 'vue-webkit',
      testMatch: /vue\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Safari'], baseURL: VUE_BASE_URL },
    },
  ],
  webServer,
});
