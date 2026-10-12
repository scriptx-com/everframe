// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { checkedAppId } from './script.js';
import { SYMBOLS_BUILD_SETTINGS, SYMBOLS_PHASE_INPUTS } from './xcode-symbols.js';

export const XCODE_PHASE_NAME = 'Upload Everframe Build Artifacts';
export const SOURCEMAP_FILE_VALUE = '"$(DERIVED_FILE_DIR)/main.jsbundle.map"';

/**
 * The Run Script body: it finds the installed `@everframe/cli` the way Node would from the app
 * root and hands over to `everframe xcode build-phase`, which owns the upload logic (Debug skip,
 * token, strict mode, time budget, Hermes map, dSYMs). `.xcode.env` supplies NODE_BINARY, as in
 * React Native's own phases. When the CLI cannot be found the build warns and continues, unless
 * EVERFRAME_SYMBOLS_STRICT=1.
 */
export function xcodePhaseScript(appId: string): string {
  return [
    'if [ -f "$SRCROOT/.xcode.env" ]; then . "$SRCROOT/.xcode.env"; fi',
    'if [ -f "$SRCROOT/.xcode.env.local" ]; then . "$SRCROOT/.xcode.env.local"; fi',
    `EVERFRAME_CLI_JS="$(cd "$SRCROOT/.." && "\${NODE_BINARY:-node}" --print "require.resolve('@everframe/cli')" 2>/dev/null)" || { echo "warning: everframe: could not run Node with @everframe/cli from $SRCROOT/..; build artifacts were not uploaded. Install @everframe/cli in the app, or set NODE_BINARY in ios/.xcode.env.local."; case "\${EVERFRAME_SYMBOLS_STRICT:-}" in 1|true) exit 1;; esac; exit 0; }`,
    `exec "\${NODE_BINARY:-node}" "$EVERFRAME_CLI_JS" xcode build-phase --app-id "${checkedAppId(appId)}"`,
  ].join('\n');
}

/** The subset of the `xcode` package's project object this module uses. */
export interface XcodeProjectLike {
  pbxItemByComment(name: string, type: string): unknown;
  getFirstTarget(): { uuid: string; firstTarget: unknown };
  addBuildPhase(
    files: string[],
    type: string,
    name: string,
    target: string,
    options: { shellPath: string; shellScript: string; inputPaths?: string[] },
  ): unknown;
  pbxXCConfigurationList(): unknown;
  pbxXCBuildConfigurationSection(): unknown;
}

/**
 * Appends the upload as the last Run Script phase, or rewrites an existing phase's script, which
 * also turns the long script earlier versions generated into the short one; defines
 * `SOURCEMAP_FILE` only where the app has not set it.
 */
export function patchXcodeProject(project: XcodeProjectLike, appId: string): void {
  const target = project.getFirstTarget();
  const script = xcodePhaseScript(appId);
  const existing = project.pbxItemByComment(XCODE_PHASE_NAME, 'PBXShellScriptBuildPhase') as
    | { shellScript?: string; inputPaths?: string[]; alwaysOutOfDate?: number }
    | null;
  // The inputs order the phase after dSYM generation; it reads fresh outputs every build.
  if (existing) {
    // Same quoting `addBuildPhase` applies, so an unchanged script serializes identically.
    existing.shellScript = `"${script.replace(/"/g, '\\"')}"`;
    existing.inputPaths = [...SYMBOLS_PHASE_INPUTS];
    existing.alwaysOutOfDate = 1;
  } else {
    const added = project.addBuildPhase([], 'PBXShellScriptBuildPhase', XCODE_PHASE_NAME, target.uuid, {
      shellPath: '/bin/bash',
      shellScript: script,
      inputPaths: [...SYMBOLS_PHASE_INPUTS],
    }) as { buildPhase?: { alwaysOutOfDate?: number } } | undefined;
    if (added?.buildPhase) added.buildPhase.alwaysOutOfDate = 1;
  }
  const listId = (target.firstTarget as { buildConfigurationList?: string }).buildConfigurationList;
  const lists = project.pbxXCConfigurationList() as Record<string, { buildConfigurations?: Array<{ value: string }> }>;
  const configs = project.pbxXCBuildConfigurationSection() as Record<string, { buildSettings?: Record<string, string> } | string>;
  for (const ref of (listId && lists[listId]?.buildConfigurations) || []) {
    const config = configs[ref.value];
    if (!config || typeof config === 'string') continue;
    config.buildSettings ??= {};
    config.buildSettings.SOURCEMAP_FILE ??= SOURCEMAP_FILE_VALUE;
    // The phase reads node_modules and dSYM folders, and its inputs must exist in Debug too.
    Object.assign(config.buildSettings, SYMBOLS_BUILD_SETTINGS);
  }
}
