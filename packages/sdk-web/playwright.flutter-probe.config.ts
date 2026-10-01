// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './flutter-probe',
  testMatch: /.*\.probe\.ts$/,
  // The loopback probe server holds one last submitted report at a time.
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:8938',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node ../../examples/flutter-web-probe/scripts/serve.mjs',
    url: 'http://127.0.0.1:8938/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
