// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/** A sandboxed Run Script cannot read the app bundle, the dSYM folders or node_modules. */
export const XCODE_SANDBOX_MESSAGE =
  'xcode_script_sandboxed: Xcode sandboxes this Run Script phase, so it cannot read the app bundle, dSYM folders or node_modules. Set ENABLE_USER_SCRIPT_SANDBOXING = NO for this target (everframe setup xcode does this).';

/**
 * Shell lines that stop a sandboxed Run Script before it starts Node, which would
 * otherwise fail with a bare EPERM. Expects EVERFRAME_STRICT to be set.
 */
export function sandboxCheck(): string[] {
  return [
    'if [ "${ENABLE_USER_SCRIPT_SANDBOXING:-}" = "YES" ]; then',
    `  if [ "$EVERFRAME_STRICT" = 1 ]; then echo "error: everframe: ${XCODE_SANDBOX_MESSAGE}"; exit 1; fi`,
    `  echo "warning: everframe: ${XCODE_SANDBOX_MESSAGE}"`,
    '  exit 0',
    'fi',
  ];
}

const APP_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The app id is embedded in shell, Groovy and a plist, so only a UUID is accepted. */
export function checkedAppId(appId: string): string {
  if (!APP_ID.test(appId))
    throw new Error(
      `everframe: appId must be an Everframe application UUID, received ${JSON.stringify(appId)}.`,
    );
  return appId;
}
