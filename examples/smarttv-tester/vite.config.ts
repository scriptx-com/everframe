// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vite config for the smart-TV tester.
//
// - `base: './'` — packaged Tizen (.wgt) and webOS (.ipk) apps load the
//   bundle from the widget filesystem root, so asset URLs must be relative.
// - `@vitejs/plugin-legacy` targeting chrome>=38 — Tizen TVs ship Chromium
//   ~47–94 and webOS ~38–94 depending on model year. The legacy (SystemJS +
//   core-js) chunks are what those engines actually execute; the modern
//   chunks serve current browsers on the hosted/dev path.
// - The dev server (`pnpm dev`) serves untransformed modern ESM — fine for a
//   desktop browser or a recent TV, but old milestones need the *built*
//   output (`pnpm run:hosted` / `pnpm run:chromium <version>`).
//
// Ingest URL is baked into @traceitx/react at its build time (tsup `define`).
// For local dev, build sdk-react via `pnpm build:web-sdk` at the repo root.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

// Repo convention (mirrors examples/react-web/scripts/gen-env-local.sh): the
// repo-root .env is the source of truth for SDK keys; a real env var wins so
// CI / one-off runs can override.
function repoEnvVar(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  try {
    const envFile = fs.readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
    const m = envFile.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m?.[1]?.replace(/\s+#.*$/, '').trim() ?? '';
  } catch {
    return '';
  }
}

// Trap guard: turbo builds (e.g. `pnpm check` → typecheck's `^build`) strip
// TRACEITX_INGEST_URL and silently re-bake the PRODUCTION URL into
// @traceitx/react's dist. Bundling that makes the tester announce to
// traceitx.com — invisible on the local dashboard, no pairing code, 401s.
// Warn loudly instead of letting that be discovered on a TV screen.
if (!repoEnvVar('TRACEITX_INGEST_URL')) {
  try {
    const sdkDist = fs.readFileSync(
      fileURLToPath(new URL('../../packages/sdk-react/dist/index.js', import.meta.url)),
      'utf8',
    );
    if (sdkDist.includes('https://traceitx.com')) {
      console.warn(
        '\n[smarttv-tester] WARNING: @traceitx/react dist has the PRODUCTION ingest URL baked in.\n' +
          '[smarttv-tester] Announce/relay will hit traceitx.com, not your local API.\n' +
          '[smarttv-tester] Run `pnpm build:web-sdk` at the repo root, then restart/rebuild this app.\n',
      );
    }
  } catch {
    /* dist missing — the build will fail on its own with a clearer error */
  }
}

export default defineConfig({
  // __TRACEITX_SDK_KEY__ — the Web app's SDK key (TRACEITX_KEY_WEB). With it
  // the companion announces itself and shows up on the project's companion
  // page; without it the relay still works but the device is undiscoverable.
  // __TRACEITX_TESTER_INGEST_URL__ — optional endpoint override
  // (TRACEITX_INGEST_URL). Empty string defers to the URL baked into
  // @traceitx/react at its build. On a real TV set it to your dev machine's
  // LAN address (http://<lan-ip>:8787) — localhost points at the TV itself.
  define: {
    __TRACEITX_SDK_KEY__: JSON.stringify(repoEnvVar('TRACEITX_KEY_WEB')),
    __TRACEITX_TESTER_INGEST_URL__: JSON.stringify(repoEnvVar('TRACEITX_INGEST_URL')),
  },
  plugins: [
    react(),
    legacy({
      targets: ['chrome>=38'],
      modernTargets: ['chrome>=87'],
    }),
  ],
  base: './',
  server: {
    port: 4174,
    host: '0.0.0.0', // reachable from a TV / emulator on the same LAN
  },
  preview: {
    port: 4174,
    host: '0.0.0.0',
  },
});
