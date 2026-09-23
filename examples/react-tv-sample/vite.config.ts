// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vite config for the Tizen/WebOS smart-TV sample. `base: '/'` keeps relative
// asset URLs working when the bundle is loaded into Tizen Studio or webOS TV
// CLI as a packaged app (both serve from a webserver root by default).
//
// Ingest URL is baked into @everframe/react at its build time (tsup
// `define` substitutes the `__EVERFRAME_INGEST_URL__` placeholder). For local
// dev, build sdk-react with `EVERFRAME_INGEST_URL=http://localhost:8787` then
// `pnpm dev` this sample.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 4173,
    host: '0.0.0.0', // accessible from a TV emulator on the same LAN
  },
});
