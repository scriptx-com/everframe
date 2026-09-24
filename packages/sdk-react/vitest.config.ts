// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.js'; // NAMED import per Phase-2 lock — default resolves undefined

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
      setupFiles: ['./__tests__/_setup.ts'],
    },
    // `@everframe/web` resolves to SOURCE here, not to its built `dist`.
    // Three reasons, all load-bearing:
    //   1. `INGEST_URL` is a build-time `define`. sdk-web's own dist bakes the
    //      PRODUCTION url; resolving to source lets the `define` below apply,
    //      so these specs keep seeing http://localhost:8787 exactly as they
    //      did when this code lived in sdk-react.
    //   2. sdk-web is full of module-level singletons and `__`-prefixed seams
    //      (`__setCompanionHost`, `__setBrandingServerConfig`, the companion
    //      singleton). A spec and the Provider it renders must observe ONE
    //      instance of each; two resolutions of the same package would give
    //      them two.
    //   3. `pnpm check` dispatches vitest directly, without turbo's `^build`,
    //      so a dist-based resolution would silently test a stale bundle (or
    //      fail outright before the first build).
    //
    // BOTH specifiers must be listed, and '@everframe/web/ui' must come FIRST.
    //
    // Two separate traps, one line apart:
    //   - Omit the '/ui' key and the subpath falls through to the package
    //     `exports` map, resolving to sdk-web's built `./dist/ui.js`. A spec
    //     would then hold the SOURCE singletons while the Provider it renders
    //     holds the DIST ones, and every `__`-seam a spec sets would be
    //     invisible to the component — a failure that reads as a bug in the
    //     seam, not as a resolution problem.
    //   - List it SECOND and it never runs. Vite's object-form aliases are
    //     matched in insertion order by @rollup/plugin-alias, whose `matches()`
    //     accepts `importee === find` OR `importee.startsWith(find + '/')`. So
    //     '@everframe/web' also matches '@everframe/web/ui' and rewrites it to
    //     `…/sdk-web/src/index.ts/ui`, which does not exist. Most specific
    //     first is the rule.
    resolve: {
      alias: {
        // Most specific first — see the block comment above for why a bare
        // '@everframe/sdk-core' key (added by a future change) must never
        // precede this subpath: @rollup/plugin-alias matches in insertion
        // order and a less-specific earlier key would swallow this one.
        '@everframe/sdk-core/conformance': fileURLToPath(
          new URL('../sdk-core/src/conformance/host-surface.ts', import.meta.url),
        ),
        '@everframe/web/ui': fileURLToPath(new URL('../sdk-web/src/ui.ts', import.meta.url)),
        '@everframe/web': fileURLToPath(new URL('../sdk-web/src/index.ts', import.meta.url)),
      },
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
