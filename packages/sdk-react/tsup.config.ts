// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from 'tsup';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `@everframe/web` is bundled into this dist from SOURCE, not from its own
// `dist/index.js`. Resolving it as a package would bundle a SECOND, already-
// bundled copy of @everframe/sdk-core, @everframe/protocol and zod (sdk-web
// inlines all three for its own standalone tarball) — ~380 KB of pure
// duplication, two module instances of every sdk-core singleton, and a
// `constants.ts` whose INGEST_URL was already baked at sdk-web's build time,
// so `EVERFRAME_INGEST_URL=… pnpm build` here would silently keep shipping
// whatever URL that other build chose. Aliasing to source puts sdk-web's
// modules into this one graph, where `define`, `treeshake` and `noExternal`
// all apply to them exactly as they did when this code lived in src/.
//
// BOTH entries need their own alias. Aliasing only '@everframe/web' does not
// cover the '/ui' subpath — esbuild would rewrite it to `…/src/index.ts/ui`,
// which resolves to nothing — so the reporter UI would either fail to bundle
// or (with the alias dropped) come in from sdk-web's built dist/ui.js,
// re-introducing the double-bundle and baked-URL problems above for half the
// graph and giving this bundle two instances of every module-level seam the
// two sdk-web entries share.
const SDK_WEB_SRC = fileURLToPath(new URL('../sdk-web/src/index.ts', import.meta.url));
const SDK_WEB_UI_SRC = fileURLToPath(new URL('../sdk-web/src/ui.ts', import.meta.url));

export default defineConfig({
  // `preview` is the INTERNAL admin-dashboard entry (`@everframe/react/preview`
  // — see src/preview.ts's header): a separate entry rather than root exports
  // so the supported public API surface doesn't widen to include the dialog
  // internals the dashboard preview needs.
  entry: ['src/index.ts', 'src/preview.ts'],
  format: ['esm'],
  // `noExternal` below only governs the JS bundle — tsup's dts step is a
  // separate rollup pass that does NOT honour it. Without this `resolve`, the
  // emitted index.d.ts keeps `import … from '@everframe/sdk-core'` /
  // '@everframe/protocol' — modules that are `private: true` and will never
  // exist on npm, so every leaked type silently degrades to `any` under the
  // consumer's default `skipLibCheck: true` (and hard-errors TS2307 without).
  //
  // NB: this only works because those two packages carry a legacy top-level
  // `types` field. tsup's dts resolver uses the pre-`exports` node algorithm
  // and is blind to `exports`; drop that field and this silently degrades back
  // to an external import with no build error.
  //
  // `zod` is deliberately NOT listed here: inlining it emits
  // `import * as z from './v4/classic/external.cjs'`, a relative path that
  // does not exist in the tarball. It is a real `dependencies` entry instead,
  // so the `z.infer<typeof relay.*>` types resolve at the consumer.
  //
  // '@everframe/web/ui' CANNOT go in `resolve` alongside the others: that list
  // is handled by tsup's ts-resolve plugin, which uses the pre-`exports`
  // node10 algorithm (see the NB above) and therefore cannot see a subpath
  // export at all — the import survives into dist/index.d.ts and
  // dist/preview.d.ts as `import '@everframe/web/ui'`, a package that will
  // never exist on npm. `compilerOptions.paths` is the working route: tsup
  // turns each `paths` key into an ignore-rule for ts-resolve AND forwards
  // the options to rollup-plugin-dts, which resolves and inlines the mapped
  // file. Points at sdk-web's DIST .d.ts (turbo's `^build` guarantees it
  // exists) while the JS above bundles sdk-web's SOURCE.
  dts: {
    resolve: ['@everframe/sdk-core', '@everframe/protocol', '@everframe/web'],
    compilerOptions: {
      paths: { '@everframe/web/ui': ['../sdk-web/dist/ui.d.ts'] },
    },
  },
  clean: true,
  // No sourcemaps in the published bundle — release pipeline policy
  // (Phase 06.3 ish): native + JS SDKs ship without sourcemaps so reversing
  // the minified output back to readable source isn't a one-click affair.
  sourcemap: false,
  target: 'es2022',
  // Build-time URL substitution. The published bundle gets a literal string;
  // the dev backdoor (the `EVERFRAME_INGEST_URL` env var) leaves no trace in
  // the prod artifact — `define` replaces the placeholder before minify, so
  // there's nothing for `strings(1)` to find but the chosen URL.
  define: {
    __EVERFRAME_INGEST_URL__: JSON.stringify(
      process.env.EVERFRAME_INGEST_URL ?? 'https://everframe.dev',
    ),
  },
  outDir: 'dist',
  // Browser-targeted bundle. Without this, esbuild defaults to a permissive
  // platform that keeps Node built-in imports like `createRequire from 'module'`
  // in the output — and Zod 4 (bundled via noExternal) uses createRequire for
  // a dev-helper code path. The unresolved `module` import then crashes
  // Next.js consumers ("Can't resolve 'module'"). platform: 'browser' tells
  // esbuild to treat such imports as errors at build time and tree-shake the
  // dev-only branches that would otherwise emit them.
  platform: 'browser',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  // Bundle internal workspace packages into this dist — they are private
  // workspace deps and don't exist on npm, so the published `@everframe/react`
  // must be a single self-contained bundle. Without this,
  // the published `import '@everframe/sdk-core'` would fail to resolve at
  // the consumer's install time.
  //
  // `zod` is listed too, but for a different reason. It is a real
  // `dependencies` entry (the emitted .d.ts imports `z` for the
  // `z.infer<typeof relay.*>` companion types, and inlining zod's own types
  // emits a broken relative path). Declaring it would otherwise make tsup
  // externalize it from the JS bundle as well — a 528 KB → 223 KB change to
  // the shipped runtime that this release is not the place to take. Keeping it
  // here holds the bundle self-contained exactly as it was validated, and the
  // dependency exists purely so the consumer can resolve the type import.
  // Ship the workspace rrweb patch to consumers, but load it only when replay
  // starts. Without splitting, bundling rrweb would put it in the eager entry.
  noExternal: ['@everframe/sdk-core', '@everframe/protocol', '@everframe/web', '@everframe/web/ui', 'zod', 'rrweb', 'modern-screenshot'],
  splitting: true,
  treeshake: true,
  // esbuild minification: dead-code-elim + identifier mangling. NOT full
  // obfuscation — control-flow flattening / string encryption would require a
  // post-build `javascript-obfuscator` pass and tend to break React fast-
  // refresh + Next.js RSC graph detection. Public exports stay readable so
  // consumers don't break; only locals get renamed.
  minify: true,
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@everframe/web': SDK_WEB_SRC,
      '@everframe/web/ui': SDK_WEB_UI_SRC,
    };
    // `keepNames` is OFF — we accept the React DevTools cost (customer sees
    // mangled single-letter names instead of `<EverframeProvider>` /
    // `<AnnotateCanvas>` / `<DiscardConfirmModal>` in their inspector tree)
    // in exchange for not shipping our internal component names as plain
    // strings in the bundle. Public *exports* (EverframeProvider, Sensitive,
    // etc.) stay readable regardless — minify doesn't rename named exports.
    // Internal-only components (sdk-core implementations bundled via
    // `noExternal`) get fully mangled.
    options.keepNames = false;
    // Strip console.log / console.debug / console.trace at build time —
    // dev-only diagnostics shouldn't ship to consumers. console.warn and
    // console.error stay (deprecation notices + misconfiguration signals
    // are real communication to consumers, not noise).
    options.pure = ['console.log', 'console.debug', 'console.trace'];
    options.drop = ['debugger'];
    // Intentionally NOT setting `mangleProps` — the SDK uses `__`-prefixed
    // internal adapter seams (`__openReporter`, `__resolveReporterUI`,
    // `__setPairUrl`, `__lastDegradedReason`, etc.) that cross module
    // boundaries inside the bundle. esbuild would mangle them consistently
    // within one bundle, but any consumer test that asserts on the literal
    // name (or any cross-bundle reference) would break. Local identifier
    // mangling (the default `minify: true` behaviour) is enough.
  },
  // Tsup uses rollup for ESM bundling; rollup strips 'use client' directives during the
  // bundle pass (warning: 'Module level directives cause errors when bundled'). banner.js
  // also gets dropped by rollup. Re-inject 'use client' via onSuccess so the published
  // bundle is consumable by Next.js app router from any import path.
  onSuccess: async () => {
    for (const path of ['dist/index.js', 'dist/preview.js']) {
      const src = readFileSync(path, 'utf8');
      if (!src.startsWith("'use client'")) {
        writeFileSync(path, `'use client';\n${src}`);
      }
    }
  },
});
