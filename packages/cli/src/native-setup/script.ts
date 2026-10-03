// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export interface BuildPhaseOptions {
  platform: 'android' | 'ios';
  appId: string;
  /** Shell expression for the staging directory. */
  stagingDir: string;
  /** Shell expression for the app root, where node_modules lives. */
  projectRoot: string;
}

/**
 * Final Hermes bytecode and composed map. Android paths are relative to `android/`; on iOS
 * the final bundle is in the resources folder and the map is the `SOURCEMAP_FILE` setting.
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
export function checkedAppId(appId: string): string {
  if (!APP_ID.test(appId))
    throw new Error(`everframe: appId must be an Everframe application UUID, received ${JSON.stringify(appId)}.`);
  return appId;
}

/** Commands stay on one line: `\` continuations do not survive pbxproj or Groovy embedding. */
export function buildPhaseScript(options: BuildPhaseOptions): string {
  const paths = BUNDLE[options.platform];
  const staging = `"${options.stagingDir}"`;
  const appId = `"${checkedAppId(options.appId)}"`;
  const run = '"$EVERFRAME_NODE" "$EVERFRAME_CLI"';
  return [
    'set -euo pipefail',
    'if [ -z "${EVERFRAME_API_TOKEN:-}" ]; then',
    '  echo "everframe: no EVERFRAME_API_TOKEN, skipping artifact upload"',
    '  exit 0',
    'fi',
    ...(options.platform === 'ios'
      ? [
          'if [ -f "$SRCROOT/.xcode.env" ]; then . "$SRCROOT/.xcode.env"; fi',
          'if [ -f "$SRCROOT/.xcode.env.local" ]; then . "$SRCROOT/.xcode.env.local"; fi',
        ]
      : []),
    'EVERFRAME_NODE="${NODE_BINARY:-node}"',
    `EVERFRAME_CLI="$(cd "${options.projectRoot}" && "$EVERFRAME_NODE" -p "require.resolve('@everframe/cli')")"`,
    `${run} build collect --staging ${staging} --platform ${options.platform} --bundle ${paths.bundle} --source-map ${paths.map}`,
    `${run} build verify --staging ${staging} --platform ${options.platform} --release`,
    `${run} sourcemaps upload-hermes --manifest ${staging} --platform ${options.platform} --app-id ${appId}`,
  ].join('\n');
}
