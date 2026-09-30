// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// esbuild plugin for the `/ui` build (tsup.config.ts's reactEntry): imports of
// the modules below resolve to the sibling `./index.js` entry instead of being
// inlined into dist/ui.js.
//
// Why: dist/index.js and dist/ui.js are separate builds. Each of these modules
// holds module-level state that `@everframe/web` WRITES (the adapter's live
// config, the provider's inline theme, `companion.start()`) and a `/ui`
// component READS (ReporterDialog's theme and watermark, CompanionBadge,
// CompanionPinCard). Inlined, `@everframe/react` got two copies: the writes
// landed in index.js's copy and the dialog, badge and PIN card subscribed to
// ui.js's, which nothing ever wrote. Importing them from ./index.js leaves ONE
// instance on the page.
//
// Every name a `/ui` module imports from these files must therefore be
// exported from src/index.ts. esbuild does not check names imported from an
// external module, so __tests__/bundle/ui-shared-modules.spec.ts does.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

export const UI_SHARED_MODULES: readonly string[] = [
  'branding/server-config',
  'branding/inline-theme',
  'companion/singleton',
  'companion/server-config',
];

const SHARED = new Set(UI_SHARED_MODULES.map((m) => path.join(SRC, `${m}.js`)));

export const uiSharedModulesPlugin: Plugin = {
  name: 'everframe-ui-shared-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!SHARED.has(path.resolve(args.resolveDir, args.path))) return undefined;
      return { path: './index.js', external: true };
    });
  },
};
