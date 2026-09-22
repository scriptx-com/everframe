// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { strictCspPlugin } from './src/csp-plugin';

// Mirrors packages/sdk-web/e2e/static-server.mjs's E2E_PORT: threaded through
// from packages/sdk-web/playwright.config.ts's webServer.env so the port
// Playwright waits on and the port Vite actually serves can never drift
// apart. Defaults to 3020 for direct/manual `pnpm dev`.
const port = Number(process.env['E2E_VUE_PORT'] ?? 3020);

export default defineConfig({
  plugins: [vue(), strictCspPlugin()],
  // host pinned to 127.0.0.1: packages/sdk-web/playwright.config.ts's
  // webServer.url and VUE_BASE_URL are both 127.0.0.1, and Vite's unset-host
  // default resolves to the IPv6 loopback (::1) on this machine, which
  // 127.0.0.1 cannot reach — the webServer probe would time out otherwise.
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1', port, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        strictCsp: fileURLToPath(new URL('./strict-csp.html', import.meta.url)),
      },
    },
  },
});
