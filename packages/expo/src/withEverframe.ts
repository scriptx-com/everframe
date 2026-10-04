// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import ExpoConfigPlugins, { type ConfigPlugin } from '@expo/config-plugins';
import {
  assertGroovy,
  patchAppBuildGradle,
  patchXcodeProject,
  type XcodeProjectLike,
} from '@everframe/cli/native-setup';

// CommonJS package: Node cannot see `CodeGenerator` and friends as named ESM exports.
const { withAppBuildGradle, withXcodeProject } = ExpoConfigPlugins;

export interface WithEverframeOptions {
  /** Everframe application UUID that build artifacts are uploaded against. */
  appId: string;
}

export function applyAndroid<T extends { language: string; contents: string }>(gradle: T, appId: string): T {
  assertGroovy(gradle.language);
  return { ...gradle, contents: patchAppBuildGradle(gradle.contents, appId) };
}

export function applyIos(project: XcodeProjectLike, appId: string): void {
  patchXcodeProject(project, appId);
}

/** Injects the build-artifact upload step into both Gradle and Xcode. */
export const withEverframe: ConfigPlugin<WithEverframeOptions> = (config, { appId }) => {
  config = withAppBuildGradle(config, (mod) => {
    mod.modResults = applyAndroid(mod.modResults, appId);
    return mod;
  });
  return withXcodeProject(config, (mod) => {
    applyIos(mod.modResults as unknown as XcodeProjectLike, appId);
    return mod;
  });
};
