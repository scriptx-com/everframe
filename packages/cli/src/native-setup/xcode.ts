// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { checkedAppId } from './script.js';
import { SYMBOLS_BUILD_SETTINGS, SYMBOLS_PHASE_INPUTS } from './xcode-symbols.js';

export const XCODE_PHASE_NAME = 'Upload Everframe Build Artifacts';
export const SOURCEMAP_FILE_VALUE = '"$(DERIVED_FILE_DIR)/main.jsbundle.map"';
/** The upload script inside an installed `@everframe/cli`, from the folder that holds `node_modules`. */
export const XCODE_UPLOAD_SCRIPT = 'node_modules/@everframe/cli/scripts/xcode-upload.sh';
/** The script's path when `node_modules` sits in the app root, beside `ios/`. */
export const DEFAULT_XCODE_UPLOAD_SCRIPT = `\${SRCROOT}/../${XCODE_UPLOAD_SCRIPT}`;
const SCRIPT_PATH = /^\$\{SRCROOT\}\/(?:\.\.\/)+node_modules\/@everframe\/cli\/scripts\/xcode-upload\.sh$/;

/**
 * Where the phase finds the upload script, relative to `${SRCROOT}` (the folder that holds the
 * `.xcodeproj`, `ios/` in React Native and Expo). It looks for `@everframe/cli` the way Node
 * does from the app root, `SRCROOT/..`: the nearest `node_modules/@everframe/cli` in it or a
 * parent folder, so a monorepo that hoists the package to its root works. It keeps symlinks
 * instead of resolving them, so a pnpm link keeps working after an upgrade. When no installed
 * CLI has the script, it returns the standard path and `installed: false`.
 */
export function xcodeUploadScriptPath(srcRoot: string): { path: string; installed: boolean } {
  const root = resolve(srcRoot);
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    const script = join(dir, XCODE_UPLOAD_SCRIPT);
    if (existsSync(script)) return { path: `\${SRCROOT}/${relative(root, script).split(sep).join('/')}`, installed: true };
    if (dirname(dir) === dir) return { path: DEFAULT_XCODE_UPLOAD_SCRIPT, installed: false };
  }
}

/**
 * The Run Script body: one line that runs the `scripts/xcode-upload.sh` shipped in
 * `@everframe/cli`. The script skips Debug and SKIP_BUNDLING builds, reads NODE_BINARY from
 * `.xcode.env`, and runs `everframe xcode build-phase`, which owns the upload logic (token,
 * strict mode, time budget, Hermes map, dSYMs).
 */
export function xcodePhaseScript(appId: string, scriptPath = DEFAULT_XCODE_UPLOAD_SCRIPT): string {
  if (!SCRIPT_PATH.test(scriptPath)) throw new Error(`invalid_upload_script_path: ${scriptPath}`);
  return `"${scriptPath}" --app-id "${checkedAppId(appId)}"`;
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
 * Appends the upload as the last Run Script phase, or rewrites the phase of the same name in
 * place; defines `SOURCEMAP_FILE` only where the app has not set it, and turns off script
 * sandboxing. `scriptPath` comes from {@link xcodeUploadScriptPath}.
 */
export function patchXcodeProject(project: XcodeProjectLike, appId: string, scriptPath = DEFAULT_XCODE_UPLOAD_SCRIPT): void {
  const target = project.getFirstTarget();
  const script = xcodePhaseScript(appId, scriptPath);
  const existing = project.pbxItemByComment(XCODE_PHASE_NAME, 'PBXShellScriptBuildPhase') as
    | { shellScript?: string; inputPaths?: string[]; alwaysOutOfDate?: number }
    | null;
  // The dSYM input orders the phase after dSYM generation; it reads fresh outputs every build.
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
    // The phase reads node_modules, the app bundle and dSYM folders.
    Object.assign(config.buildSettings, SYMBOLS_BUILD_SETTINGS);
  }
}
