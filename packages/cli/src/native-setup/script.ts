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
    bundle: '"${CONFIGURATION_BUILD_DIR:-}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}/main.jsbundle"',
    map: '"${SOURCEMAP_FILE:-}"',
  },
};

/**
 * A sandboxed Run Script cannot read the bundle, the dSYM folders or
 * node_modules, and Node would fail with a bare EPERM. Say so before starting
 * it. Expects EVERFRAME_STRICT to be set.
 */
export function sandboxCheck(): string[] {
  const message = "xcode_script_sandboxed: Xcode sandboxes this Run Script phase, so it cannot read the app bundle, dSYM folders or node_modules. Set ENABLE_USER_SCRIPT_SANDBOXING = NO for this target (everframe setup xcode does this).";
  return [
    'if [ "${ENABLE_USER_SCRIPT_SANDBOXING:-}" = "YES" ]; then',
    `  if [ "$EVERFRAME_STRICT" = 1 ]; then echo "error: everframe: ${message}"; exit 1; fi`,
    `  echo "warning: everframe: ${message}"`,
    "  exit 0",
    "fi",
  ];
}

const WARNING =
  'echo "warning: everframe: artifact upload failed (exit status $EVERFRAME_STATUS); the build continues. Crashes from this build will show raw frames until its artifacts are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."';
/** A failed step: strict exits with its status; otherwise warn and run the next step. */
const FAILED_CONTINUE = `if [ "$EVERFRAME_STRICT" = 1 ]; then exit "$EVERFRAME_STATUS"; fi; ${WARNING}`;
/** A failed setup line (env files, Node, CLI resolution): nothing else can run. */
const FAILED = `${FAILED_CONTINUE}; exit 0`;

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
    ...(options.platform === 'ios' ? sandboxCheck() : []),
    `trap 'EVERFRAME_STATUS=$?; ${FAILED}' ERR`,
    ...(options.platform === 'ios'
      ? [
          // The project's env files are not ours to hold to `set -u`.
          'set +u',
          'if [ -f "$SRCROOT/.xcode.env" ]; then . "$SRCROOT/.xcode.env"; fi',
          'if [ -f "$SRCROOT/.xcode.env.local" ]; then . "$SRCROOT/.xcode.env.local"; fi',
          'set -u',
        ]
      : []),
    'EVERFRAME_NODE="${NODE_BINARY:-node}"',
    `EVERFRAME_CLI="$(cd "${options.projectRoot}" && "$EVERFRAME_NODE" -p "require.resolve('@everframe/cli')")"`,
    // A failed Hermes upload must not cost the iOS dSYMs: steps in an `if`
    // list do not trip the ERR trap, so each step reports on its own.
    `if ${run} build collect --staging ${staging} --platform ${options.platform} --bundle ${paths.bundle} --source-map ${paths.map} && ${run} build verify --staging ${staging} --platform ${options.platform} --release && ${run} sourcemaps upload-hermes --manifest ${staging} --platform ${options.platform} --app-id ${appId}; then :; else EVERFRAME_STATUS=$?; ${FAILED_CONTINUE}; fi`,
    ...(options.platform === 'ios'
      ? [`if ${run} dsym upload-build --xcode --app-id ${appId}; then :; else EVERFRAME_STATUS=$?; ${FAILED_CONTINUE}; fi`]
      : []),
    'exit 0',
  ].join('\n');
}
