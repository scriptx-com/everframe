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
    bundle: '"app/build/generated/assets/react/${EVERFRAME_VARIANT:-release}/index.android.bundle"',
    map: '"app/build/generated/sourcemaps/react/${EVERFRAME_VARIANT:-release}/index.android.bundle.map"',
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

/**
 * Never fails the app build by default: without EVERFRAME_API_TOKEN, or when
 * any step fails, it prints a `warning:` line and exits 0, in CI and locally.
 * EVERFRAME_SYMBOLS_STRICT=1 turns both into failures. iOS Debug builds and
 * SKIP_BUNDLING skip first, because they have no release bundle.
 * Commands stay on one line: `\` continuations do not survive pbxproj or Groovy embedding.
 */
export function buildPhaseScript(options: BuildPhaseOptions): string {
  const paths = BUNDLE[options.platform];
  const staging = `"${options.stagingDir}"`;
  const appId = `"${checkedAppId(options.appId)}"`;
  const run = '"$EVERFRAME_NODE" "$EVERFRAME_CLI"';
  return [
    'set -euo pipefail',
    ...(options.platform === 'ios'
      ? [
          'if [ "${CONFIGURATION:-}" = "Debug" ] || [ -n "${SKIP_BUNDLING:-}" ]; then',
          '  echo "everframe: Debug build, skipping artifact upload"',
          '  exit 0',
          'fi',
        ]
      : []),
    'EVERFRAME_STRICT=0; case "${EVERFRAME_SYMBOLS_STRICT:-}" in 1|true) EVERFRAME_STRICT=1;; esac',
    'if [ -z "${EVERFRAME_API_TOKEN:-}" ]; then',
    '  if [ "$EVERFRAME_STRICT" = 1 ]; then',
    '    echo "everframe: missing_api_token: set EVERFRAME_API_TOKEN to a token with the artifacts:write scope." >&2',
    '    exit 1',
    '  fi',
    '  echo "warning: everframe: no EVERFRAME_API_TOKEN, skipping artifact upload. Crashes from this build will show raw frames. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."',
    '  exit 0',
    'fi',
    `trap 'EVERFRAME_STATUS=$?; if [ "$EVERFRAME_STRICT" = 1 ]; then exit "$EVERFRAME_STATUS"; fi; echo "warning: everframe: artifact upload failed (exit status $EVERFRAME_STATUS); the build continues. Crashes from this build will show raw frames until its artifacts are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."; exit 0' ERR`,
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
    ...(options.platform === 'ios' ? [`${run} dsym upload-build --xcode --app-id ${appId}`] : []),
  ].join('\n');
}
