// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Expo config plugin that wires the dogfood sample app's generated
// Android build to resolve the workspace TraceItX SDK from the local
// Maven repo (`~/.m2/repository`).
//
// What it does: appends `mavenLocal()` to the `allprojects { repositories
// { ... } }` block of the regenerated root `android/build.gradle`. That
// block is where Expo's RN host configures Maven repos for every
// autolinked subproject — including our RN bridge at
// `:traceitx_sdk-react-native`, which declares
// `implementation("com.traceitx:traceitx-core:1.2.0-SNAPSHOT")` and
// needs mavenLocal on its classpath to find the published AAR.
//
// Why mavenLocal (not Gradle composite-build):
//   The prior revision used `includeBuild("../../../packages/sdk-android/android")`
//   in the host's settings.gradle for SDK hot-reload. Expo SDK 56 pins
//   AGP 8.12.0 while the SDK pins 8.7.2 — Gradle rejects mixed AGPs
//   inside a composite build. Going through mavenLocal keeps the host
//   and SDK in separate Gradle universes; the SDK builds in its own
//   AGP world and publishes AARs, the host downloads them.
//
//   `scripts/dev/rn.mjs` runs
//   `pnpm --filter @traceitx/sdk-android run publish:maven-local` before
//   every android dev cycle, so the AARs are never older than the
//   current SDK source.
//
// Why not `settings.gradle`'s `dependencyResolutionManagement.repositories`:
//   Expo's generated `settings.gradle` doesn't include such a block —
//   repos are configured via `allprojects { repositories { ... } }` in
//   `android/build.gradle` instead. Prepending a new block to
//   settings.gradle also conflicts with the `pluginManagement {}` /
//   `plugins {}` ordering Gradle enforces, which was the failure mode
//   that prompted this rewrite.
//
// iOS side is unchanged: `expo-build-properties` (useFrameworks: dynamic
// in app.json) plus pnpm's symlinked `node_modules/@traceitx/...` lets
// the SDK podspec's `spm_dependency` resolve to packages/sdk-ios
// without further plugin help.

const { withProjectBuildGradle } = require('@expo/config-plugins');

const PROBE = 'TRACEITX_MAVEN_LOCAL';
const COMMENT = '// TRACEITX_MAVEN_LOCAL — Injected by ./plugins/with-traceitx-workspace.js';

/**
 * Insert `mavenLocal()` into the first `allprojects { repositories { ... } }`
 * block of the root build.gradle. Idempotent — bails if the probe comment
 * already appears in the file.
 *
 * @param {string} contents
 * @returns {string}
 */
function injectMavenLocal(contents) {
  if (contents.includes(PROBE)) return contents;

  // Match up to and including the opening brace of `repositories {` inside
  // the first `allprojects {` block. Non-greedy `[\s\S]*?` so we land in
  // the FIRST repositories block under the FIRST allprojects.
  const re = /(allprojects\s*\{[\s\S]*?repositories\s*\{)/;
  const match = contents.match(re);
  if (!match) {
    // Fallback: append a fresh `allprojects { repositories { mavenLocal() } }`
    // at the end. Expo's generated build.gradle has the block, so we never
    // expect to reach this — but a safe append beats a silent miss.
    return (
      contents.trimEnd() +
      `\n\n` +
      `// ${COMMENT.replace('// ', '')}\n` +
      `allprojects {\n` +
      `  repositories {\n` +
      `    mavenLocal()\n` +
      `  }\n` +
      `}\n`
    );
  }

  return contents.replace(re, `$1\n    ${COMMENT}\n    mavenLocal()`);
}

function withTraceitxWorkspace(config) {
  return withProjectBuildGradle(config, (cfg) => {
    cfg.modResults.contents = injectMavenLocal(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withTraceitxWorkspace;
