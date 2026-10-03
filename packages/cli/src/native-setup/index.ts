// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export type { BuildPhaseOptions } from './script.js';
export { buildPhaseScript, checkedAppId } from './script.js';
export { assertGroovy, GRADLE_TAG, patchAppBuildGradle } from './gradle.js';
export type { XcodeProjectLike } from './xcode.js';
export { patchXcodeProject, SOURCEMAP_FILE_VALUE, XCODE_PHASE_NAME } from './xcode.js';
