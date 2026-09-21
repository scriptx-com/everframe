// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, type Options } from 'tsup';

const vanillaEntry = {
  // Single always-loaded entry. NOTHING reachable from it may statically
  // import react/react-dom — see src/index.ts's header.
  entry: ['src/index.ts'],
  format: ['esm'],
  // `noExternal` below only governs the JS bundle — tsup's dts step is a
  // separate rollup pass that does NOT honour it. Without this `resolve`, the
  // emitted .d.ts keeps `import … from '@traceitx/sdk-core'` /
  // '@traceitx/protocol' — packages that are `private: true` and will never
  // exist on npm, so every consumer install either hard-errors TS2307 or
  // (under the default `skipLibCheck: true`) silently degrades every leaked
  // type to `any`. Same reasoning, same fix as sdk-react's config.
  //
  // NB: this only works because those two packages carry a legacy top-level
  // `types` field. tsup's dts resolver uses the pre-`exports` node algorithm
  // and is blind to `exports`; drop that field and this silently degrades back
  // to an external import with no build error.
  //
  // `zod` is deliberately NOT listed, for the same reason sdk-react omits it:
  // inlining it emits `import * as z from './v4/classic/external.cjs'`, a
  // relative path that does not exist in the tarball. It is a real
  // `dependencies` entry instead, so `z.infer<typeof relay.*>` resolves at the
  // consumer.
  //
  // Task 2 recorded that this package "cannot" do this, because inlining
  // sdk-core produces fresh local declarations and `IdentityTokenHolder`
  // carries `private` members — making it NOMINALLY typed, so the inlined
  // copy and the original stop being mutually assignable and
  // `@traceitx/react`'s provider.tsx (which imports the holder from sdk-core
  // directly) fails at `adapter.__setIdentityTokenHolder(...)`. That was true
  // and is verifiable by reverting adapter.ts's `IdentityTokenHolderLike`.
  // It is fixed at the source rather than worked around here: that holder was
  // the ONLY nominal type anywhere in the inlined graph, and the adapter seam
  // now names the structural slice it actually consumes. See
  // `IdentityTokenHolderLike` in src/adapter.ts for the full account.
  dts: { resolve: ['@traceitx/sdk-core', '@traceitx/protocol'] },
  // NOT `clean: true`. tsup runs an array of configs through `Promise.all`,
  // so a `clean` on either one races the other's write and can delete
  // dist/ui.js (or dist/index.js) that the sibling build just emitted. The
  // `build` script does `rm -rf dist` once, before tsup starts, instead.
  // No sourcemaps in the published bundle — release pipeline policy
  // (Phase 06.3 ish): native + JS SDKs ship without sourcemaps so reversing
  // the minified output back to readable source isn't a one-click affair.
  sourcemap: false,
  target: 'es2022',
  // Build-time URL substitution. The published bundle gets a literal string;
  // the dev backdoor (the `TRACEITX_INGEST_URL` env var) leaves no trace in
  // the prod artifact — `define` replaces the placeholder before minify, so
  // there's nothing for `strings(1)` to find but the chosen URL.
  define: {
    __TRACEITX_INGEST_URL__: JSON.stringify(
      process.env.TRACEITX_INGEST_URL ?? 'https://traceitx.com',
    ),
    // React is BUNDLED into this graph (see `noExternal` below), and both
    // react and react-dom branch on `process.env.NODE_ENV` at module scope.
    // esbuild leaves that expression alone under `platform: 'browser'`, so
    // without this the lazy island would throw `process is not defined` the
    // first time a vanilla host opened the reporter. Pinned to 'production'
    // so the dev-only warning paths tree-shake out of the shipped chunk.
    'process.env.NODE_ENV': JSON.stringify('production'),
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
  // Nothing is force-externalized here. What a vanilla host must NOT be made
  // to install is handled positively, in `noExternal` below — see its note.
  external: [],
  // Bundle internal workspace packages into this dist — they are private
  // workspace deps and don't exist on npm, so the published `@traceitx/web`
  // must be a single self-contained bundle. Without this,
  // the published `import '@traceitx/sdk-core'` would fail to resolve at
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
  //
  // RULING 13b — the React family is bundled here, which is what makes "a
  // vanilla host installs nothing" true BY CONFIGURATION rather than by the
  // accident of nothing importing React yet. tsup externalizes every
  // `dependencies` / `peerDependencies` entry by default and `noExternal` is
  // checked first, so this list is the override. All five are needed:
  //
  //   react, react-dom   the island (mount/react-island.tsx) and the whole
  //                      dialog tree.
  //   lucide-react       every icon in the dialog. (The ambient FAB inlines
  //                      its one glyph as raw SVG precisely so this package
  //                      stays out of the EAGER graph.)
  //   react-konva        AnnotateCanvas's `import('react-konva')`. Bundling
  //                      react while leaving this external would re-introduce
  //                      the install through the back door — it peer-depends
  //                      on React, so the consumer would have to install
  //                      React to satisfy it.
  //   konva              react-konva's own dependency. Same back door, one
  //                      hop further out: bundle react-konva and leave konva
  //                      external and the chunk still emits `from'konva'`.
  //
  // These five are declared as OPTIONAL peerDependencies rather than
  // dependencies (see package.json): a vanilla host installs none of them,
  // while the `/ui` entry below — which keeps them external on purpose — has
  // a declaration for the React host that consumes it. They stay in
  // devDependencies so this workspace can still build and test.
  //
  // Bundle the patched rrweb into its own lazy chunk. A workspace pnpm patch
  // alone would not reach npm consumers. Splitting keeps it out of page startup;
  // The patched screenshot dependency also stays in a separate lazy chunk.
  noExternal: [
    '@traceitx/sdk-core',
    '@traceitx/protocol',
    'zod',
    'react',
    'react-dom',
    'lucide-react',
    'react-konva',
    'konva',
    'rrweb',
    'modern-screenshot',
  ],
  // splitting ON, and it is now load-bearing rather than merely tidy: React
  // reaches this graph through exactly one dynamic `import()` (init.ts ->
  // mount/react-island.js), and a dynamic import is a chunk split point. With
  // splitting ON, react/react-dom/the dialog land in a chunk that is not
  // fetched until someone opens the reporter, and the React-absence gate
  // (`grep -c "react-dom\|__SECRET_INTERNALS" dist/index.js` == 0) holds.
  // Turn it OFF and esbuild inlines that dynamic import into the entry: the
  // gate fails and every vanilla host downloads React on page load.
  //
  // Splitting is also what keeps ONE instance of every module-level seam
  // (portal target, theme host, inline theme, companion host seam) — the eager
  // entry and the island chunk share them. That only works because the island
  // imports the dialog by the RELATIVE path '../ui.js', keeping it in this
  // build graph; see mount/react-island.tsx's header (Ruling 11).
  splitting: true,
  treeshake: true,
  // esbuild minification: dead-code-elim + identifier mangling. NOT full
  // obfuscation — control-flow flattening / string encryption would require a
  // post-build `javascript-obfuscator` pass and tend to break React fast-
  // refresh + Next.js RSC graph detection. Public exports stay readable so
  // consumers don't break; only locals get renamed.
  minify: true,
  esbuildOptions(options) {
    // `keepNames` is OFF — we accept the React DevTools cost (customer sees
    // mangled single-letter names instead of `<TraceItXProvider>` /
    // `<AnnotateCanvas>` / `<DiscardConfirmModal>` in their inspector tree)
    // in exchange for not shipping our internal component names as plain
    // strings in the bundle. Public *exports* (TraceItXProvider, Sensitive,
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
} satisfies Options;

// `src/ui.ts` — the React entry (`@traceitx/web/ui`). A SECOND config object,
// not a second `entry` in the one above, so that the two builds can be given
// different answers to "who owns React" as soon as that question has an
// answer worth verifying. Today they are configured alike; what differs is
// what each graph actually contains.
//
//   dist/index.js — React is BUNDLED (the vanilla config's `noExternal`
//                   above), into a chunk reached only through init.ts's
//                   dynamic `import('./mount/react-island.js')`. So the entry
//                   itself still contains no React — the React-absence gate
//                   (`grep -c "react-dom\|__SECRET_INTERNALS" dist/index.js`
//                   == 0) holds — AND a Vue / Svelte / plain-HTML host has
//                   nothing to install: react, react-dom, lucide-react,
//                   react-konva and konva are optional peers, never
//                   dependencies. Before Task 7 the gate held by ABSENCE
//                   alone (nothing in the graph imported React) while those
//                   packages were real `dependencies` a consumer did install;
//                   the island is what made the correct set verifiable.
//   dist/ui.js    — React EXTERNAL, deliberately and permanently.
//                   `@traceitx/react` consumes this entry and supplies its
//                   host's React; a second bundled copy would give that host
//                   two React runtimes, and hooks and context cannot cross
//                   that boundary.
//
// NOTE neither config sets `clean` — see the vanilla config's note above:
// tsup runs an array of configs through `Promise.all`, so a `clean` on either
// one races the other's write. The ONLY clean is `rm -rf dist` in the `build`
// script (package.json). Do not drop it expecting tsup to clean.
const reactEntry = {
  entry: ['src/ui.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'es2022',
  platform: 'browser',
  // Same self-contained-declarations requirement as the vanilla entry above —
  // see its note for why `dts.resolve` is mandatory here and why `zod` is
  // excluded from it.
  dts: { resolve: ['@traceitx/sdk-core', '@traceitx/protocol'] },
  sourcemap: false,
  // Same build-time URL substitution as the vanilla entry — the two builds
  // share source modules, so a placeholder reaching this graph must be
  // replaced here too or it would survive into the bundle as a free variable.
  define: {
    __TRACEITX_INGEST_URL__: JSON.stringify(
      process.env.TRACEITX_INGEST_URL ?? 'https://traceitx.com',
    ),
  },
  // The React SDK supplies its host's React; bundling a second copy here
  // would give it two React runtimes and break hooks and context.
  //
  // Listed EXPLICITLY — including lucide-react / react-konva / konva, which
  // used to be external merely because they were `dependencies`. Ruling 13b
  // moved them to optional peers so the vanilla entry could bundle them, and
  // that placement change would otherwise have flipped them to bundled HERE
  // too, silently doubling this entry's size and shipping a second copy of
  // everything to `@traceitx/react` (which declares them itself).
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'lucide-react',
    'react-konva',
    'konva',
  ],
  noExternal: ['@traceitx/sdk-core', '@traceitx/protocol'],
  splitting: false,
  treeshake: true,
  // Same release policy as the vanilla entry above — see its esbuildOptions
  // comment for why keepNames is off and mangleProps is not set.
  minify: true,
  esbuildOptions(options) {
    options.keepNames = false;
    options.pure = ['console.log', 'console.debug', 'console.trace'];
    options.drop = ['debugger'];
  },
  // Same rollup-strips-'use client' workaround sdk-react carries: the bundle
  // pass drops the module-level directive (it warns about it by name), and a
  // React entry without it is not importable from a Next.js app-router server
  // component. Re-inject it here so `@traceitx/web/ui` behaves like
  // `@traceitx/react` does for the same consumers.
  onSuccess: async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const path = 'dist/ui.js';
    const src = readFileSync(path, 'utf8');
    if (!src.startsWith("'use client'")) {
      writeFileSync(path, `'use client';\n${src}`);
    }
  },
} satisfies Options;

// The BROWSER entry (`dist/browser/index.js`) — the no-bundler artifact,
// loaded straight off a CDN by a page with no build step at all:
//
//   <script type="module">
//     import { init } from 'https://cdn.jsdelivr.net/npm/@traceitx/web@0.6.6/dist/browser/index.js';
//     init({ apiKey: 'txx_live_…', appVersion: '1.0.0' });
//   </script>
//
// This REPLACES the IIFE (`dist/traceitx.min.js`, built from a since-deleted
// `src/cdn.ts`) that used to hold this slot. The IIFE bought nothing and cost
// 3x. Every build here targets es2022, and every engine that can execute
// es2022 has supported `<script type="module">` for years — modules shipped
// well before those language features did. So the format was never a
// compatibility floor; it was only a code-splitting ceiling. An IIFE has no
// module loader, so esbuild had to inline init.ts's dynamic
// `import('./mount/react-island.js')` into the one file, and React, konva,
// rrweb and modern-screenshot all downloaded on page load: MEASURED at 391 kB
// gz. This build measures 120.9 kB gz for the same always-loaded graph.
//
// The genuinely old engines an IIFE might have served (Tizen / webOS TV on
// Chrome 38-60) can execute neither es2022 nor modules; reaching them needs
// transpilation plus polyfills, a separate axis this SDK does not claim.
//
// This entry guarantees `noExternal: [/.*/]`, so no bare specifier survives.
// The ESM entry now also bundles the patched capture dependencies; the current
// graphs can therefore be identical. Splitting keeps React and capture lazy.
//
// Each build owns its output directory so concurrent tsup configs never write
// the same paths. The artifact tests verify that both directories contain their
// entry and every referenced relative chunk, without requiring different bytes.
//
// (`dist/browser/` is a directory; the vanilla build's `dist/browser-*.js`
// lazy chunk is a hashed file. Different paths — esbuild never emits an
// extensionless chunk.)
//
// No `dts`: this artifact is fetched by URL from a `<script type="module">`,
// never imported by a TypeScript consumer, so it has no declaration to publish
// and no entry in `exports`. Bundler consumers get `.` -> `dist/index.js`.
//
// No `window.traceitx` global, and no double-inclusion guard. `src/cdn.ts`
// existed for both and needs to exist for neither: the browser's module
// registry is keyed by URL, so the same URL imported twice evaluates once. Two
// DIFFERENT versions on one page would still be two graphs — but `init()`'s
// own per-page singleton already warns and hands back the existing handle for
// that, which covers strictly more than a global that only ever caught the
// same-version half.
const browserEntry = {
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist/browser',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  // Same release policy as the two entries above — no sourcemaps in a shipped
  // artifact, so the minified output is not one click from readable source.
  sourcemap: false,
  // Load-bearing, and the whole reason this build is worth having. See the
  // header: splitting is what keeps React out of the always-loaded entry.
  // Turning it off is measured at 400 kB gz and blows .size-limit.json's
  // 135 kB budget by 265 kB.
  splitting: true,
  treeshake: true,
  // Everything, including the two real `dependencies` the ESM entry leaves for
  // the consumer's bundler to resolve. A page loading this by URL has no
  // resolver at all.
  noExternal: [/.*/],
  define: {
    __TRACEITX_INGEST_URL__: JSON.stringify(
      process.env.TRACEITX_INGEST_URL ?? 'https://traceitx.com',
    ),
    // react and react-dom branch on `process.env.NODE_ENV` at MODULE SCOPE,
    // and a bare `process` reference is a ReferenceError in a browser. Pinned
    // to 'production' so the dev-only warning paths tree-shake out of the lazy
    // island chunk.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // Same release policy as the two entries above — see the vanilla entry's
  // esbuildOptions comment for why keepNames is off, why console.log / debug /
  // trace are stripped, and why mangleProps is deliberately not set.
  esbuildOptions(options) {
    options.keepNames = false;
    options.pure = ['console.log', 'console.debug', 'console.trace'];
    options.drop = ['debugger'];
  },
} satisfies Options;

export default defineConfig([vanillaEntry, reactEntry, browserEntry]);
