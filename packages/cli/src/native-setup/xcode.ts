// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { buildPhaseScript } from './script.js';

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
    options: { shellPath: string; shellScript: string },
  ): unknown;
  pbxXCConfigurationList(): unknown;
  pbxXCBuildConfigurationSection(): unknown;
}

/** Appends the upload as the last Run Script phase and defines `SOURCEMAP_FILE` if unset. */
export function patchXcodeProject(project: XcodeProjectLike, appId: string): void {
  const target = project.getFirstTarget();
  if (!project.pbxItemByComment(XCODE_PHASE_NAME, 'PBXShellScriptBuildPhase')) {
    const script = buildPhaseScript({ platform: 'ios', appId, stagingDir: '$SRCROOT/../.everframe', projectRoot: '$SRCROOT/..' });
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', XCODE_PHASE_NAME, target.uuid, {
      shellPath: '/bin/bash',
      shellScript: script,
    });
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
