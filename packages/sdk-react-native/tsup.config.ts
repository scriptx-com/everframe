// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries so the TurboModule spec ships as its own file in dist/.
  // RN codegen (Plan 06-02 iOS + Plan 06-03 Android) reads NativeEverframe.ts
  // from the published package to emit Swift/Kotlin headers; a single bundled
  // index.js would inline the spec and break codegen discovery.
  // Integration subpaths are separate entries so unused integrations never
  // enter the host bundle (spec 2026-07-14 — opt-in stays opt-in at the
  // bundle level too).
  entry: [
    "src/index.ts",
    "src/NativeEverframe.ts",
    "src/integrations/console.ts",
    "src/integrations/react-navigation.ts",
    "src/integrations/react-native-video.ts",
    "src/integrations/theoplayer.ts",
  ],
  format: ["esm"],
  // `noExternal` below only governs the JS bundle — tsup's dts step is a
  // separate rollup pass that does NOT honour it. Without this `resolve`, the
  // emitted .d.ts files keep `import … from '@everframe/sdk-core'` /
  // '@everframe/protocol' — modules that are `private: true` and will never
  // exist on npm, so every leaked type silently degrades to `any` under the
  // consumer's default `skipLibCheck: true` (and hard-errors TS2307 without).
  //
  // NB: this only works because those two packages carry a legacy top-level
  // `types` field. tsup's dts resolver uses the pre-`exports` node algorithm
  // and is blind to `exports`; drop that field and this silently degrades back
  // to an external import with no build error.
  dts: { resolve: ["@everframe/sdk-core", "@everframe/protocol"] },
  clean: true,
  // MUST stay true (esm default, made explicit): contextSeam holds the
  // module-level current-context singleton. Without splitting, each entry
  // would inline its own copy and integrations would write crumbs into a
  // context slot the provider never populates — silent total breakage.
  splitting: true,
  // No sourcemaps in published artifacts — release-pipeline policy. The
  // SDK ships pre-bundled (not as raw source) so the .map would be the
  // primary reverse-engineering surface; without it, consumers see only
  // the minified output. RN codegen reads NativeEverframe.ts via dts +
  // public .js, which works fine without sourcemaps.
  sourcemap: false,
  minify: true,
  esbuildOptions(options) {
    options.keepNames = true;
  },
  target: "es2022",
  outDir: "dist",
  // React Native consumers bundle this output with Metro. Without an explicit
  // browser platform, tsup/esbuild selects fflate's Node export while bundling
  // sdk-core's Hermes gzip fallback, leaving imports of `module` and
  // `worker_threads` in the published chunk. Metro has no Node built-ins, so
  // an optimized Android bundle fails before the app can be installed.
  platform: "browser",
  external: ["react", "react-native", "bippy"],
  // Bundle internal workspace packages into this dist — none of them exist
  // on npm (they're `private: true` workspace siblings), so the published
  // RN package must inline their code. Without this, the published bundle
  // would `import '@everframe/sdk-core'` and fail at consumer install time.
  //
  // `zod` is listed too, but for a different reason. It is a real
  // `dependencies` entry (the emitted index.d.ts imports `z` for the
  // `z.infer<typeof relay.*>` companion types, and inlining zod's own types
  // emits a broken relative path). Declaring it would otherwise make tsup
  // externalize it from the JS bundle as well; keeping it here holds the
  // bundle self-contained exactly as it was validated, and the dependency
  // exists purely so the consumer can resolve the type import.
  noExternal: ["@everframe/sdk-core", "@everframe/protocol", "zod"],
});
