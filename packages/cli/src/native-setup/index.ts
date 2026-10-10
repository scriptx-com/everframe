// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export type { BuildPhaseOptions } from './script.js';
export { buildPhaseScript, checkedAppId } from './script.js';
export { assertGroovy, GRADLE_TAG, patchAppBuildGradle } from './gradle.js';
export type { XcodeProjectLike } from './xcode.js';
export { patchXcodeProject, SOURCEMAP_FILE_VALUE, XCODE_PHASE_NAME } from './xcode.js';
export type { XcodeSymbolsProject } from './xcode-symbols.js';
export { patchXcodeProjectForSymbols, symbolsPhaseScript, SYMBOLS_BUILD_SETTINGS, SYMBOLS_PHASE_INPUTS, SYMBOLS_PHASE_NAME } from './xcode-symbols.js';
