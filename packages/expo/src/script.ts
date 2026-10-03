// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export interface BuildPhaseOptions {
  platform: 'android' | 'ios';
  appId: string;
  /** Shell expression for the staging directory; Gradle and Xcode differ. */
  stagingDir: string;
}

/**
 * Final Hermes bytecode and composed source map per platform. Android paths
 * are relative to `android/`. On iOS the final bundle is under the resources
 * folder (`$CONFIGURATION_BUILD_DIR/main.jsbundle` is a deleted intermediate),
 * and the only map is `SOURCEMAP_FILE`, which the app must define as a target
 * build setting. Its `:-` default turns a missing setting into a coded CLI
 * error instead of a `set -u` abort.
 */
const BUNDLE: Record<'android' | 'ios', { bundle: string; map: string }> = {
  android: {
    bundle: '"app/build/generated/assets/react/release/index.android.bundle"',
    map: '"app/build/generated/sourcemaps/react/release/index.android.bundle.map"',
  },
  ios: {
    bundle: '"$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle"',
    map: '"${SOURCEMAP_FILE:-}"',
  },
};

const APP_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The app id is embedded in shell, Groovy and a plist, so only a UUID is accepted. */
function checkedAppId(appId: string): string {
  if (!APP_ID.test(appId))
    throw new Error(
      `everframe: appId must be an Everframe application UUID, received ${JSON.stringify(appId)}.`,
    );
  return appId;
}

/**
 * The Gradle/Xcode upload script; a no-op without a token. Commands stay on
 * one line because `\` continuations do not survive the pbxproj or Groovy
 * embedding.
 */
export function buildPhaseScript(options: BuildPhaseOptions): string {
  const paths = BUNDLE[options.platform];
  const staging = `"${options.stagingDir}"`;
  const appId = `"${checkedAppId(options.appId)}"`;
  return [
    'set -euo pipefail',
    'if [ -z "${EVERFRAME_API_TOKEN:-}" ]; then',
    '  echo "everframe: no EVERFRAME_API_TOKEN, skipping artifact upload"',
    '  exit 0',
    'fi',
    `everframe build collect --staging ${staging} --platform ${options.platform} --bundle ${paths.bundle} --source-map ${paths.map}`,
    `everframe build verify --staging ${staging} --platform ${options.platform} --release`,
    `everframe sourcemaps upload-hermes --manifest ${staging} --platform ${options.platform} --app-id ${appId}`,
  ].join('\n');
}
