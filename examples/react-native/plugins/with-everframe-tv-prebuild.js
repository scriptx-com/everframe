// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion Expo config plugin to `@react-native-tvos/config-tv` that asserts
// a small set of Everframe-specific TV manifest deltas the upstream plugin
// does NOT cover. Runs AFTER config-tv in the plugin chain.
//
// Three specific deltas (gated on `process.env.EXPO_TV === '1'`):
//   0. tvOS autolinking exclusions — see TV_AUTOLINK_EXCLUDE below.
//   1. iOS / tvOS Info.plist:
//      - Strip phone-only `UIRequiredDeviceCapabilities` (arm64 / armv7) if a
//        host accidentally inherited them — tvOS rejects those keys.
//      - Force `RCTNewArchEnabled = true`. Defense against future config-tv
//        revisions that might clobber it on tvOS. Everframe explicitly keeps
//        the new architecture enabled on TV — PLAN-TV-H from
//        06.1-RESEARCH §11 + Pitfall P6).
//      Note: Expo SDK 55/56 + RN-tvos may also read New Arch from
//      `ios/Podfile.properties.json` (`newArchEnabled` key). This plugin sets
//      the Info.plist token; the actual landing location is verified at
//      acceptance time and documented in 06.1-02-SUMMARY.md.
//   2. Android leanback resilience:
//      - Re-assert `<uses-feature android:name="android.software.leanback"
//        android:required="false"/>`. config-tv@0.1.6 already injects this,
//        but a host that hand-overrides manifest in app.json could strip it.
//
// ALL OTHER TV manifest surgery (TVOS_DEPLOYMENT_TARGET, LEANBACK_LAUNCHER
// intent-filter, banner, icon assets) is `@react-native-tvos/config-tv`'s
// responsibility. Do NOT duplicate that work here.
//
// Use one explicit per-platform branch. Everframe has a single sample, so this
// intentionally avoids multi-client templating.

const fs = require('node:fs');
const path = require('node:path');
const {
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
} = require('@expo/config-plugins');

// Marker line: makes a re-run idempotent and tells a reader who wrote this.
const EXCLUDE_MARKER =
  '# EVERFRAME_TV_AUTOLINK_EXCLUDE — injected by ./plugins/with-everframe-tv-prebuild.js';

/**
 * Packages that must NOT be autolinked into an Apple TV build.
 *
 * `react-native-video` (v7, the version the Session Vitals spec targets):
 * its podspec declares `:ios` only, so CocoaPods installs no pod on tvOS —
 * but Expo autolinking still LISTS the package, so RN codegen emits an entry
 * for its Fabric component into `+[RCTThirdPartyComponentsProvider
 * thirdPartyFabricComponents]`. That entry resolves to a nil Class and the
 * app dies at launch, before a line of JS runs:
 *
 *   *** Terminating app due to uncaught exception 'NSInvalidArgumentException'
 *   *** -[__NSPlaceholderDictionary initWithObjects:forKeys:count:]:
 *       attempt to insert nil object from objects[31]
 *
 * A `react-native.config.js` `platforms: { ios: null }` override does NOT fix
 * it. RN's codegen prefers `ios/build/generated/autolinking/autolinking.json`
 * (written by CocoaPods' `list_native_modules` from the Podfile's
 * `config_command`) over `react-native.config.js`, and Expo's autolinking
 * resolver ignores the RN CLI platform-disable syntax entirely. `--exclude`
 * on that command is the one lever that reaches both the pod list and codegen.
 *
 * The JS half is guarded separately — `components/TabBar.tsx` omits the
 * Playback tab where `PLAYBACK_SUPPORTED` is false, and `App.tsx` requires the
 * screen lazily — so `react-native-video` is never evaluated on tvOS either.
 *
 * ANDROID TV is deliberately untouched: its half is an ordinary Gradle module
 * that builds for leanback, and the Session Vitals smoke passes there.
 */
const TV_AUTOLINK_EXCLUDE = ['react-native-video'];

/**
 * Append `--exclude <pkg>` pairs to the Podfile's `config_command` — the argv
 * Expo hands `expo-modules-autolinking react-native-config`.
 */
function withTVAutolinkExclusions(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(
        cfg.modRequest.platformProjectRoot,
        'Podfile',
      );
      if (!fs.existsSync(podfilePath)) {
        throw new Error(
          `[with-everframe-tv-prebuild] expected Podfile at ${podfilePath}`,
        );
      }
      const original = fs.readFileSync(podfilePath, 'utf8');
      if (original.includes(EXCLUDE_MARKER)) return cfg;

      // The generated argv ends `'--platform',\n  'ios'\n]` — note that
      // `'ios'` carries NO trailing comma, so the rewrite has to add one.
      const anchor = /^([ \t]*)'--platform',\n[ \t]*'ios'\n([ \t]*\])/m;
      const match = original.match(anchor);
      if (!match) {
        throw new Error(
          '[with-everframe-tv-prebuild] could not locate the autolinking ' +
            "config_command's --platform argument in the Podfile",
        );
      }
      const indent = match[1];
      const added = TV_AUTOLINK_EXCLUDE.map(
        (name) => `${indent}'--exclude',\n${indent}'${name}'`,
      ).join(',\n');
      fs.writeFileSync(
        podfilePath,
        original.replace(
          anchor,
          `${indent}'--platform',\n${indent}'ios',\n` +
            `${indent}${EXCLUDE_MARKER}\n${added}\n$2`,
        ),
        'utf8',
      );
      // eslint-disable-next-line no-console
      console.log(
        `[with-everframe-tv-prebuild] tvOS autolinking excludes: ${TV_AUTOLINK_EXCLUDE.join(', ')}`,
      );
      return cfg;
    },
  ]);
}

function withEverframeTVPrebuild(config) {
  const isTV = process.env.EXPO_TV === '1';
  if (!isTV) {
    // Phone path — config-tv also no-ops; keep chain inert.
    return config;
  }

  // tvOS branch — Info.plist deltas config-tv@0.1.6 does NOT set.
  config = withInfoPlist(config, (cfg) => {
    if (Array.isArray(cfg.modResults.UIRequiredDeviceCapabilities)) {
      cfg.modResults.UIRequiredDeviceCapabilities =
        cfg.modResults.UIRequiredDeviceCapabilities.filter(
          (k) => k !== 'arm64' && k !== 'armv7'
        );
    }
    // PLAN-TV-H: force RCTNewArchEnabled=true on tvOS.
    cfg.modResults.RCTNewArchEnabled = true;
    return cfg;
  });

  // tvOS branch — drop packages whose pods have no tvOS platform. The
  // 'ios' dangerous mod only runs on an iOS prebuild, so the Android TV pass
  // skips it.
  config = withTVAutolinkExclusions(config);

  // Android TV branch — leanback uses-feature resilience.
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] ?? [];
    const hasLeanback = manifest['uses-feature'].some(
      (f) => f.$ && f.$['android:name'] === 'android.software.leanback'
    );
    if (!hasLeanback) {
      manifest['uses-feature'].push({
        $: {
          'android:name': 'android.software.leanback',
          'android:required': 'false',
        },
      });
    }
    return cfg;
  });

  return config;
}

module.exports = withEverframeTVPrebuild;
