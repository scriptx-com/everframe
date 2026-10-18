// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
declare const __EVERFRAME_CLI_VERSION__: string;
declare const __EVERFRAME_ANDROID_VERSION__: string;
/** The published @everframe/cli version, compiled in from package.json. */
export const CLI_VERSION: string = __EVERFRAME_CLI_VERSION__;
/** The Android release this CLI was built against, compiled in from gradle.properties. */
export const ANDROID_RELEASE_VERSION: string = __EVERFRAME_ANDROID_VERSION__;
