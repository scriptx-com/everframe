// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { buildPhaseScript } from '../src/script.js';

describe('buildPhaseScript', () => {
  const script = buildPhaseScript({
    platform: 'ios',
    appId: '00000000-0000-4000-8000-000000000000',
    stagingDir: '$SRCROOT/../.everframe',
  });

  it('runs collect before verify before upload', () => {
    expect(script.indexOf('build collect')).toBeLessThan(script.indexOf('build verify'));
    expect(script.indexOf('build verify')).toBeLessThan(script.indexOf('upload-hermes'));
  });

  it('marks release configurations', () => {
    expect(script).toContain('--release');
  });

  it('aborts the build on any step failure', () => {
    expect(script).toContain('set -euo pipefail');
  });

  it('skips silently when no token is configured', () => {
    expect(script).toContain('EVERFRAME_API_TOKEN');
  });

  it('quotes the staging directory so a spaced path survives', () => {
    expect(script).toContain('--staging "$SRCROOT/../.everframe"');
    expect(script).not.toMatch(/--staging \$[A-Za-z_]/);
  });

  it('uses the android bundle path for android', () => {
    const android = buildPhaseScript({
      platform: 'android',
      appId: '00000000-0000-4000-8000-000000000000',
      stagingDir: '$rootDir/../.everframe',
    });
    expect(android).toContain('index.android.bundle');
  });

  // Substring/ordering assertions above can't catch a broken line: a lost
  // `\` continuation or an over-escaped quote still contains every
  // substring above in the right order. Pin the exact text for one
  // platform so that class of defect fails loudly.
  it('emits exactly this script for ios', () => {
    expect(script).toBe(
      [
        'set -euo pipefail',
        'if [ -z "${EVERFRAME_API_TOKEN:-}" ]; then',
        '  echo "everframe: no EVERFRAME_API_TOKEN, skipping artifact upload"',
        '  exit 0',
        'fi',
        'everframe build collect --staging "$SRCROOT/../.everframe" --platform ios --bundle "$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle" --source-map "${SOURCEMAP_FILE:-}"',
        'everframe build verify --staging "$SRCROOT/../.everframe" --platform ios --release',
        'everframe sourcemaps upload-hermes --manifest "$SRCROOT/../.everframe" --platform ios --app-id "00000000-0000-4000-8000-000000000000"',
      ].join('\n'),
    );
  });

  it('points ios at the final packaged hermes bytecode, not the intermediate metro js', () => {
    // react-native-xcode.sh writes Metro's JS to $CONFIGURATION_BUILD_DIR/main.jsbundle,
    // then hermesc emits the real bytecode into the app's resources folder and the
    // intermediate is removed. Collecting the intermediate path fails every release build.
    expect(script).toContain(
      '--bundle "$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle"',
    );
    expect(script).not.toContain('--bundle "$CONFIGURATION_BUILD_DIR/main.jsbundle"');
  });

  it('reads the ios map from the build-defined SOURCEMAP_FILE', () => {
    // No iOS map exists at all unless the build defines SOURCEMAP_FILE;
    // there is never a map sitting next to the bundle.
    expect(script).toContain('--source-map "${SOURCEMAP_FILE:-}"');
    expect(script).not.toContain('main.jsbundle.map');
  });

  // The script runs under `set -u`, and Xcode gives each Run Script phase its
  // own process — so a SOURCEMAP_FILE merely `export`ed inside React Native's
  // bundle phase does not reach this one. Without the `:-` default that is an
  // abort on `SOURCEMAP_FILE: unbound variable`, which names neither the
  // artifact nor the fix; with it the build fails inside `everframe build
  // collect`, with a Everframe error code.
  it('defaults SOURCEMAP_FILE so an undefined setting cannot abort under set -u', () => {
    expect(script).toContain('${SOURCEMAP_FILE:-}');
    expect(script).not.toMatch(/"\$SOURCEMAP_FILE"/);
  });

  // Every other variable the script expands is guaranteed to exist:
  // CONFIGURATION_BUILD_DIR / UNLOCALIZED_RESOURCES_FOLDER_PATH / SRCROOT are
  // Xcode built-ins exported to every phase, EVERFRAME_STAGING is set by the
  // generated Gradle block, and EVERFRAME_API_TOKEN already has its own
  // default. Any NEW developer-supplied variable needs the same treatment.
  it('gives every developer-supplied variable a `:-` default', () => {
    const guaranteed = new Set([
      'CONFIGURATION_BUILD_DIR',
      'UNLOCALIZED_RESOURCES_FOLDER_PATH',
      'SRCROOT',
      'EVERFRAME_STAGING',
    ]);
    for (const platform of ['android', 'ios'] as const) {
      const emitted = buildPhaseScript({
        platform,
        appId: '00000000-0000-4000-8000-000000000000',
        stagingDir: platform === 'ios' ? '$SRCROOT/../.everframe' : '$EVERFRAME_STAGING',
      });
      // Every bare `$NAME` expansion (i.e. one without a `${...:-}` default).
      for (const [, name] of emitted.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        expect(guaranteed.has(name as string)).toBe(true);
      }
    }
  });

  it('uses the android paths the hermes guide documents, relative to rootDir', () => {
    const android = buildPhaseScript({
      platform: 'android',
      appId: '00000000-0000-4000-8000-000000000000',
      stagingDir: '$EVERFRAME_STAGING',
    });
    expect(android).toContain(
      '--bundle "app/build/generated/assets/react/release/index.android.bundle"',
    );
    expect(android).toContain(
      '--source-map "app/build/generated/sourcemaps/react/release/index.android.bundle.map"',
    );
  });

  it('quotes the app id so a spaced or `;`-bearing value cannot split the command', () => {
    expect(script).toContain('--app-id "00000000-0000-4000-8000-000000000000"');
  });

  it('rejects an app id that is not a uuid', () => {
    expect(() =>
      buildPhaseScript({ platform: 'ios', appId: 'a; rm -rf /', stagingDir: '$SRCROOT/../.everframe' }),
    ).toThrow(/must be an Everframe application UUID/);
  });

});
