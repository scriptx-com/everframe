// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export { checkedAppId, XCODE_SANDBOX_MESSAGE } from './script.js';
export { assertGroovy, EVERFRAME_GRADLE_PLUGIN, GRADLE_TAG, patchAppBuildGradle, patchRootBuildGradle } from './gradle.js';
export type { XcodeProjectLike } from './xcode.js';
export {
  DEFAULT_XCODE_UPLOAD_SCRIPT,
  patchXcodeProject,
  SOURCEMAP_FILE_VALUE,
  XCODE_PHASE_NAME,
  XCODE_UPLOAD_SCRIPT,
  xcodePhaseScript,
  xcodeUploadScriptPath,
} from './xcode.js';
export type { XcodeSymbolsProject } from './xcode-symbols.js';
export { patchXcodeProjectForSymbols, symbolsPhaseScript, SYMBOLS_BUILD_SETTINGS, SYMBOLS_PHASE_INPUTS, SYMBOLS_PHASE_NAME } from './xcode-symbols.js';
