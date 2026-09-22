// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Expo config plugin — point the example's iOS/tvOS Podfile at the
// workspace's local TraceItX iOS SDK (`packages/sdk-ios`) instead of the
// published `TraceItX` pod on CocoaPods Trunk.
//
// What it does:
//   1. Builds the local xcframeworks via
//      `packages/sdk-ios/scripts/build-xcframework.sh` if `dist/` is
//      missing or stale relative to `Sources/`. This avoids a confusing
//      `pod install` failure ("missing dist/TraceItXKit.xcframework")
//      when the dev forgets the build step.
//   2. Injects a `pod 'TraceItX', :path => ..., :podspec => ...`
//      override into the generated `ios/Podfile`. CocoaPods honors the
//      override regardless of any transitive `s.dependency 'TraceItX/Core'`
//      declarations (the TraceItXRN bridge's podspec has two such lines).
//   2b. Injects `ENV['TRACEITX_NATIVE_POD_VERSION'] = '<canonical version>'`
//      alongside that override, read out of `packages/sdk-ios/TraceItX.podspec`
//      the same way `dev-podspec/TraceItX.podspec` tracks it. This is the iOS
//      counterpart of Android's `traceitxNativeVersion`: TraceItXRN.podspec's
//      derived `~> X.Y.0` range trails the native SDK for the entire window
//      between a native minor landing and the JS package's changeset actually
//      publishing — every native minor, not an edge case — so without this,
//      `pod install` cannot resolve against a `:path`-pinned native pod whose
//      version the JS package's own range doesn't yet cover. Setting it in the
//      Podfile (not just the caller's shell env) means a bare `pod install`
//      run by hand also resolves.
//   3. Builds the xcframeworks as DEBUG (dist/.xcframework-config sentinel)
//      and points dev builds at LOCAL ingest instead of production — the
//      Release binary compiles the `#if DEBUG` overrides out entirely.
//      Two delivery mechanisms, because launch paths differ:
//        - Info.plist `TraceItXDevIngestURL` (withDevIngestInfoPlist) —
//          works under `expo run:ios`, which deep-links the app via
//          `simctl openurl` and drops host env.
//        - Xcode scheme env TRACEITX_DEV_INGEST_URL (injectSchemeIngestEnv)
//          — works for the Xcode run action.
//
// Why a plugin rather than checked-in Podfile changes:
//   `examples/react-native/ios/` is `.gitignore`-d — `expo prebuild`
//   regenerates it. A plugin is the only way to persist the override
//   across prebuilds without a manual edit step.
//
// Companion to `with-traceitx-workspace.js` (Android `mavenLocal()`
// injection). Together they make the example app a workspace-local
// consumer on both platforms without manual Podfile / build.gradle edits.
//
// Opt-out for release / smoke-test runs against the *published* TraceItX
// pod from CocoaPods Trunk:
//
//   TRACEITX_LOCAL_IOS=0 npx expo prebuild --platform ios --clean
//
// When that env var is set to `0`, the plugin strips any prior injection
// from the Podfile and leaves `TraceItXRN.podspec`'s standard
// `s.dependency 'TraceItX/Core', '~> 0.1.0'` path intact. Default (env
// unset or any other value): inject local override, no env var needed
// for daily dev.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { withDangerousMod, withInfoPlist } = require('@expo/config-plugins');

// Points at the DEV podspec subdir (packages/sdk-ios/dev-podspec/) so
// CocoaPods picks the local-xcframework-vendoring podspec rather than the
// canonical one at packages/sdk-ios/TraceItX.podspec (which is `:http =>`-
// sourced from GitHub Releases). Two podspecs named TraceItX.podspec
// can't live in the same dir.
const DEV_PODSPEC_DIR_FROM_IOS = '../../../packages/sdk-ios/dev-podspec';
const PROBE = 'TRACEITX_DEV_PODSPEC';
const MARKER = '# TRACEITX_DEV_PODSPEC — injected by ./plugins/with-traceitx-ios-local.js';

// Env var TraceItXRN.podspec reads to override its npm-derived
// `TraceItX/Core` version range — see the comment on `native_version_override`
// there. Injected into the Podfile (not just the caller's shell) alongside
// the `pod 'TraceItX', :path =>` override so a bare `pod install` resolves.
const NATIVE_VERSION_ENV_VAR = 'TRACEITX_NATIVE_POD_VERSION';

/**
 * Resolve the absolute path of `packages/sdk-ios` from the example dir.
 * @param {string} exampleRoot
 */
function sdkIosAbsPath(exampleRoot) {
  return path.resolve(exampleRoot, '..', '..', 'packages', 'sdk-ios');
}

/**
 * Read `spec.version` out of the canonical, publishable
 * `packages/sdk-ios/TraceItX.podspec` — the same regex
 * `dev-podspec/TraceItX.podspec` already uses to track it
 * (`/spec\.version\s*=\s*"([^"]+)"/`). This is the version injected as
 * `TRACEITX_NATIVE_POD_VERSION` so TraceItXRN.podspec's dependency range
 * matches whatever the local `:path`-pinned native pod actually is, instead
 * of the npm-derived range (which trails the native SDK for the entire
 * window between a native minor landing and its JS changeset publishing).
 *
 * @param {string} sdkRoot
 * @returns {string}
 */
function readCanonicalSdkVersion(sdkRoot) {
  const podspecPath = path.join(sdkRoot, 'TraceItX.podspec');
  const contents = fs.readFileSync(podspecPath, 'utf8');
  const match = contents.match(/spec\.version\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(
      `[with-traceitx-ios-local] could not parse spec.version from ${podspecPath}`,
    );
  }
  return match[1];
}

/**
 * Names of the xcframeworks that the dev podspec vendors. Each one is
 * mirrored from `dist/<X>.xcframework` into `dev-podspec/<X>.xcframework`
 * via a symlink so CocoaPods sees them at the pod's source root —
 * matching the canonical TraceItX.podspec layout. Earlier attempts at
 * `dist/X.xcframework` subpaths or `../dist/X.xcframework` parents both
 * resulted in CocoaPods silently dropping the vendored_frameworks
 * (manifested at build time as `no such module 'TraceItXKit'`).
 */
const VENDORED_XCFRAMEWORKS = [
  'TraceItXProtocol.xcframework',
  'TraceItXKit.xcframework',
  'TraceItXReporterUI.xcframework',
];

/**
 * Ensure `dev-podspec/<Name>.xcframework -> ../dist/<Name>.xcframework`
 * for each vendored xcframework. Idempotent — re-points stale links and
 * skips correctly-pointing ones.
 *
 * Also removes the legacy `dev-podspec/dist` symlink from earlier
 * revisions of this plugin, so a re-run cleans up after itself.
 *
 * @param {string} sdkRoot
 */
function ensureXcframeworkSymlinks(sdkRoot) {
  const podDir = path.join(sdkRoot, 'dev-podspec');

  // Legacy cleanup: the prior shape was a single `dist -> ../dist` link.
  const legacy = path.join(podDir, 'dist');
  try {
    if (fs.lstatSync(legacy).isSymbolicLink()) fs.unlinkSync(legacy);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  for (const name of VENDORED_XCFRAMEWORKS) {
    const linkPath = path.join(podDir, name);
    const target = path.join('..', 'dist', name);
    try {
      const cur = fs.readlinkSync(linkPath);
      if (cur === target) continue;
      fs.unlinkSync(linkPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    fs.symlinkSync(target, linkPath);
  }
}

/**
 * Rebuild local xcframeworks if `dist/TraceItXKit.xcframework` is missing,
 * older than the newest file under `Sources/`, or built with the wrong
 * configuration. Quiet no-op when everything is fresh — keeps prebuild
 * fast on repeated runs.
 *
 * The local dev loop wants a DEBUG xcframework: IngestEndpoint.swift only
 * honors the TRACEITX_DEV_INGEST_URL runtime env inside `#if DEBUG`; a
 * Release build is hardwired to https://traceitx.com, so local example-app
 * uploads 401 against a local dev key. `dist/.xcframework-config` (written
 * by build-xcframework.sh) records what dist/ was last built with — a
 * mismatch forces a rebuild even when mtimes look fresh (a stale Release
 * dist/ from a release run would otherwise silently ship prod-pointed
 * binaries into the dev app).
 *
 * @param {string} sdkRoot
 */
function ensureXcframeworks(sdkRoot) {
  const flagFramework = path.join(sdkRoot, 'dist', 'TraceItXKit.xcframework');
  const buildScript = path.join(sdkRoot, 'scripts', 'build-xcframework.sh');
  const configFile = path.join(sdkRoot, 'dist', '.xcframework-config');
  const wantConfig =
    process.env.TRACEITX_XCFRAMEWORK_CONFIGURATION || 'Debug';

  if (!fs.existsSync(buildScript)) {
    throw new Error(
      `[with-traceitx-ios-local] expected build script at ${buildScript}`,
    );
  }

  const buildReason = (() => {
    if (!fs.existsSync(flagFramework)) return 'dist/ missing';
    const distConfig = fs.existsSync(configFile)
      ? fs.readFileSync(configFile, 'utf8').trim()
      : 'unknown configuration';
    if (distConfig !== wantConfig) {
      return `dist/ is ${distConfig}, need ${wantConfig}`;
    }
    const distMtime = fs.statSync(flagFramework).mtimeMs;
    const sourcesNewest = newestMtime(path.join(sdkRoot, 'Sources'));
    return sourcesNewest > distMtime ? 'Sources/ newer than dist/' : null;
  })();

  if (!buildReason) {
    // eslint-disable-next-line no-console
    console.log(
      `[with-traceitx-ios-local] dist/ xcframeworks up-to-date (${wantConfig}), skipping rebuild`,
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[with-traceitx-ios-local] building ${wantConfig} dist/ xcframeworks (${buildReason}) — this can take a few minutes`,
  );
  const result = spawnSync('bash', [buildScript], {
    cwd: sdkRoot,
    stdio: 'inherit',
    env: { ...process.env, TRACEITX_XCFRAMEWORK_CONFIGURATION: wantConfig },
  });
  if (result.status !== 0) {
    throw new Error(
      `[with-traceitx-ios-local] build-xcframework.sh failed with exit ${result.status}`,
    );
  }
}

/**
 * Walk `dir` and return the latest mtime in ms. Returns 0 if the dir
 * doesn't exist (defensive — we'd already fail earlier in that case).
 *
 * @param {string} dir
 * @returns {number}
 */
function newestMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(p));
    } else {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

// Matches our whole injected block: the marker comment, the optional
// `ENV['TRACEITX_NATIVE_POD_VERSION'] = …` line (present since the iOS
// escape-hatch was added; absent in Podfiles from older plugin versions —
// hence `?`), and the `pod 'TraceItX', …` line with any `:`-prefixed
// continuation lines (multi-line `:path => …,` style from earlier plugin
// versions). Shared by inject (strip-then-reinsert, for idempotent re-runs)
// and strip (published-pod mode, no reinsert).
//
// Replace with empty string (NOT `\n`) so re-injection is idempotent — the
// canonical block prepends its own leading newline.
const OVERRIDE_BLOCK_RE = new RegExp(
  // Optional single leading newline so the blank line we INSERTED above the
  // marker (via `\n  MARKER` in the inject block) is consumed too —
  // otherwise re-injecting would accumulate one extra blank per pass.
  `\\n?[ \\t]*#[ \\t]*${PROBE}[^\\n]*\\n` +
    `(?:[ \\t]*ENV\\[['"]${NATIVE_VERSION_ENV_VAR}['"]\\][^\\n]*\\n)?` +
    `(?:[ \\t]*pod\\s+'TraceItX'[^\\n]*\\n(?:[ \\t]*:[^\\n]*\\n)*)?`,
  'g',
);

/**
 * Inject the `pod 'TraceItX'` override, plus the
 * `ENV['TRACEITX_NATIVE_POD_VERSION']` assignment TraceItXRN.podspec reads
 * to override its npm-derived dependency range, into the Podfile inside the
 * first `target 'TraceItXRNExample' do … end` block.
 *
 * Re-entrant: if an earlier version of the plugin already injected an
 * override, strip it and inject the current shape. This lets a fresh
 * prebuild upgrade the override line without forcing `--clean`.
 *
 * @param {string} contents
 * @param {string} nativeVersion canonical `packages/sdk-ios/TraceItX.podspec` version
 */
function injectOverride(contents, nativeVersion) {
  const cleaned = contents.replace(OVERRIDE_BLOCK_RE, '');

  const re = /(target\s+['"][^'"]+['"]\s+do\s*\n)/;
  const match = cleaned.match(re);
  if (!match) {
    throw new Error(
      `[with-traceitx-ios-local] could not locate target block in Podfile`,
    );
  }

  const overrideBlock =
    `\n  ${MARKER}\n` +
    `  ENV['${NATIVE_VERSION_ENV_VAR}'] = '${nativeVersion}'\n` +
    `  pod 'TraceItX', :path => '${DEV_PODSPEC_DIR_FROM_IOS}'\n`;

  return cleaned.replace(re, `$1${overrideBlock}`);
}

/**
 * Strip any prior `# TRACEITX_DEV_PODSPEC` injection (pod override AND the
 * `ENV['TRACEITX_NATIVE_POD_VERSION']` assignment alongside it) without
 * inserting a new one. Used in published-pod mode so a Podfile that was
 * previously patched for local dev cleanly reverts to the canonical
 * `s.dependency 'TraceItX/Core'` path from TraceItXRN.podspec — an
 * unstripped version override would defeat the point of that mode, which
 * exists to test against the published pod.
 *
 * @param {string} contents
 */
function stripOverride(contents) {
  return contents.replace(OVERRIDE_BLOCK_RE, '');
}

// Step 0c originally pre-declared `TraceItXRN` with `:testspecs => ['Tests']`
// here, so CocoaPods would build a `TraceItXRN-Unit-Tests` target (autolinking
// alone never passes `:testspecs` — see
// `node_modules/react-native/scripts/cocoapods/autolinking.rb:167`). Reverted
// (Step 0d, Branch B): once the module-name mismatch in the three
// `ios/Tests/*.swift` files was fixed (`@testable import TraceItX_ReactNative`
// → `TraceItXRN`), the test target still failed to compile — a SEPARATE,
// pre-existing defect: `TraceItXRN`'s compiled module records a minimum
// deployment target of iOS 15.1 (`Helpers::Constants.min_ios_version_supported`
// in react_native_pods.rb's cocoapods/helpers.rb), but the test-spec target
// isn't covered by `react_native_post_install`'s deployment-target bump the
// way the library target is, so it stays at the podspec's declared iOS 15.0
// and the compiler refuses. Fixing that is a build-configuration change, not
// the bounded import-rename this step was authorized for — so the iOS job
// is a compile-only gate on the `TraceItXRN` scheme instead, and a test
// target that can't compile is worse than none. See
// `.superpowers/sdd/2026-08-13-rn-native-ci-host/task-3-report.md` for the
// full trace.

/**
 * Inject `TRACEITX_DEV_INGEST_URL` into the app scheme's LaunchAction
 * EnvironmentVariables so builds RUN FROM XCODE submit to local ingest.
 * Mirrors `examples/ios-native/project.yml`, which sets the same var in
 * its scheme.
 *
 * This covers the Xcode run action only — `expo run:ios` launches the app
 * via `simctl launch`, which ignores scheme env and forwards only host
 * vars prefixed `SIMCTL_CHILD_`. The dev runners (scripts/dev/rn.mjs and
 * scripts/with-free-port.mjs) set SIMCTL_CHILD_TRACEITX_DEV_INGEST_URL
 * for that path. Both mechanisms are inert unless the vendored
 * xcframework is a Debug build (see ensureXcframeworks).
 *
 * The value is baked at prebuild time; override via shell
 * TRACEITX_DEV_INGEST_URL when prebuilding for a physical device (LAN IP).
 *
 * Idempotent: updates the value if the key is already present.
 *
 * @param {string} schemePath
 * @param {string} url
 */
function injectSchemeIngestEnv(schemePath, url) {
  if (!fs.existsSync(schemePath)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[with-traceitx-ios-local] no scheme at ${schemePath} — skipping scheme env injection (expo-run path still covered via SIMCTL_CHILD_)`,
    );
    return;
  }

  const original = fs.readFileSync(schemePath, 'utf8');
  const varXml =
    `      <EnvironmentVariables>\n` +
    `         <EnvironmentVariable\n` +
    `            key = "TRACEITX_DEV_INGEST_URL"\n` +
    `            value = "${url}"\n` +
    `            isEnabled = "YES">\n` +
    `         </EnvironmentVariable>\n` +
    `      </EnvironmentVariables>\n`;

  let next;
  if (original.includes('key = "TRACEITX_DEV_INGEST_URL"')) {
    // Already injected — just refresh the value.
    next = original.replace(
      /(key = "TRACEITX_DEV_INGEST_URL"\s*\n\s*value = ")[^"]*(")/,
      `$1${url}$2`,
    );
  } else {
    // Insert the block just before </LaunchAction>. Xcode accepts
    // EnvironmentVariables anywhere among LaunchAction's children.
    const closeTag = /(\n[ \t]*<\/LaunchAction>)/;
    if (!closeTag.test(original)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[with-traceitx-ios-local] no <LaunchAction> in ${schemePath} — skipping scheme env injection`,
      );
      return;
    }
    next = original.replace(closeTag, `\n${varXml.replace(/\n$/, '')}$1`);
  }

  if (next !== original) {
    fs.writeFileSync(schemePath, next, 'utf8');
    // eslint-disable-next-line no-console
    console.log(
      `[with-traceitx-ios-local] scheme env TRACEITX_DEV_INGEST_URL=${url} → ${path.basename(schemePath)}`,
    );
  }
}

/**
 * Bake `TraceItXDevIngestURL` into the app's Info.plist. This is the
 * mechanism that actually reaches the app under `expo run:ios`: expo
 * launches the sim app by deep link (`simctl openurl` → SpringBoard),
 * which drops host env entirely — neither SIMCTL_CHILD_ forwarding nor
 * Xcode scheme env applies there. IngestEndpoint.swift reads this plist
 * key in `#if DEBUG` builds only (env var, when present, wins); the
 * Release/published framework has no plist lookup compiled in, so the
 * key is inert outside the local dev loop.
 *
 * @param {import('@expo/config-plugins').ConfigPlugin} config
 */
function withDevIngestInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    if (process.env.TRACEITX_LOCAL_IOS === '0') {
      delete cfg.modResults.TraceItXDevIngestURL;
      return cfg;
    }
    const url = process.env.TRACEITX_DEV_INGEST_URL || 'http://localhost:8787';
    cfg.modResults.TraceItXDevIngestURL = url;
    // eslint-disable-next-line no-console
    console.log(
      `[with-traceitx-ios-local] Info.plist TraceItXDevIngestURL=${url}`,
    );
    return cfg;
  });
}

function withTraceitxIosLocal(config) {
  config = withDevIngestInfoPlist(config);
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const exampleRoot = cfg.modRequest.projectRoot;
      const podfilePath = path.join(
        cfg.modRequest.platformProjectRoot,
        'Podfile',
      );

      // Opt-out for release / smoke-test runs against the *published*
      // TraceItX pod on CocoaPods Trunk. Set `TRACEITX_LOCAL_IOS=0` in
      // the environment and prebuild will leave (or revert) the Podfile
      // to the unpatched, TraceItXRN.podspec-driven dependency path.
      // Anything else (including unset) keeps the local-link behavior so
      // the daily dev loop doesn't require an env var.
      const usePublished = process.env.TRACEITX_LOCAL_IOS === '0';

      if (!fs.existsSync(podfilePath)) {
        throw new Error(
          `[with-traceitx-ios-local] expected Podfile at ${podfilePath}`,
        );
      }
      const original = fs.readFileSync(podfilePath, 'utf8');

      if (usePublished) {
        const stripped = stripOverride(original);
        if (stripped !== original) {
          fs.writeFileSync(podfilePath, stripped, 'utf8');
          // eslint-disable-next-line no-console
          console.log(
            `[with-traceitx-ios-local] TRACEITX_LOCAL_IOS=0 — reverted Podfile to published-pod dependency`,
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[with-traceitx-ios-local] TRACEITX_LOCAL_IOS=0 — using published TraceItX pod (no override present)`,
          );
        }
        return cfg;
      }

      const sdkRoot = sdkIosAbsPath(exampleRoot);
      ensureXcframeworks(sdkRoot);
      ensureXcframeworkSymlinks(sdkRoot);

      const nativeVersion = readCanonicalSdkVersion(sdkRoot);
      const next = injectOverride(original, nativeVersion);
      if (next !== original) {
        fs.writeFileSync(podfilePath, next, 'utf8');
        // eslint-disable-next-line no-console
        console.log(
          `[with-traceitx-ios-local] injected TraceItX dev podspec override into ${podfilePath}`,
        );
      }

      const projectName = cfg.modRequest.projectName;
      if (projectName) {
        const schemePath = path.join(
          cfg.modRequest.platformProjectRoot,
          `${projectName}.xcodeproj`,
          'xcshareddata',
          'xcschemes',
          `${projectName}.xcscheme`,
        );
        injectSchemeIngestEnv(
          schemePath,
          process.env.TRACEITX_DEV_INGEST_URL || 'http://localhost:8787',
        );
      }
      return cfg;
    },
  ]);
}

module.exports = withTraceitxIosLocal;
