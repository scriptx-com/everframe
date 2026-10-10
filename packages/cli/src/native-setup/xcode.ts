// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { buildPhaseScript } from './script.js';
import { SYMBOLS_PHASE_INPUTS } from './xcode-symbols.js';

export const XCODE_PHASE_NAME = 'Upload Everframe Build Artifacts';
export const SOURCEMAP_FILE_VALUE = '"$(DERIVED_FILE_DIR)/main.jsbundle.map"';

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
 * Appends the upload as the last Run Script phase, or rewrites an existing phase's script
 * so a new app id or script fix lands; defines `SOURCEMAP_FILE` if unset.
 */
export function patchXcodeProject(project: XcodeProjectLike, appId: string): void {
  const target = project.getFirstTarget();
  const script = buildPhaseScript({ platform: 'ios', appId, stagingDir: '$SRCROOT/../.everframe', projectRoot: '$SRCROOT/..' });
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
  }
}
