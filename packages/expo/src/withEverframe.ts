// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import ExpoConfigPlugins, { type ConfigPlugin } from '@expo/config-plugins';
import { buildPhaseScript } from './script.js';

// CommonJS package: Node cannot see `CodeGenerator` as a named ESM export.
const { withAppBuildGradle, withXcodeProject, CodeGenerator } = ExpoConfigPlugins;

export interface WithEverframeOptions {
  /** Everframe application UUID that build artifacts are uploaded against. */
  appId: string;
}

const MERGE_TAG = 'everframe-build-artifacts';
const XCODE_PHASE_NAME = 'Upload Everframe Build Artifacts';

/** Escapes a script for a Groovy `'''...'''` literal: multi-line, never interpolated. */
function escapeForGroovyTripleQuoted(script: string): string {
  return script.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Runs the upload after the release JS-bundling task (matched by name, since
 * it differs across RN plugin versions; an empty match logs a warning).
 * - ProcessBuilder, because Gradle 9 removed `Project.exec`.
 * - `rootDir` is read at configuration time, as the configuration cache requires.
 * - Runs from `android/`, which the script's paths are relative to.
 * - Staging is passed as an env var: `'''` strings do not interpolate `$rootDir`.
 * - `bash`, not `sh`: dash rejects `set -o pipefail`.
 */
const withEverframeAndroid: ConfigPlugin<WithEverframeOptions> = (config, { appId }) => {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy') {
      throw new Error(
        'everframe: @everframe/expo only supports Groovy android/app/build.gradle files, found Kotlin script.',
      );
    }
    const script = buildPhaseScript({ platform: 'android', appId, stagingDir: '$EVERFRAME_STAGING' });
    const escaped = escapeForGroovyTripleQuoted(script);
    const newSrc = [
      'afterEvaluate {',
      '  def everframeRootDir = rootDir',
      '  def everframeStaging = "$rootDir/../.everframe".toString()',
      '  def everframeBundleTasks = tasks.matching { it.name.contains("Release") && it.name.contains("JsAndAssets") }',
      '  if (everframeBundleTasks.isEmpty()) {',
      '    logger.warn("everframe: no release JS-bundling task matched (looked for a task name containing both \\"Release\\" and \\"JsAndAssets\\"); build artifacts will not be uploaded")',
      '  }',
      '  everframeBundleTasks.configureEach { bundleTask ->',
      '    bundleTask.doLast {',
      "      def everframeProcess = new ProcessBuilder('bash', '-c', '''" + escaped + "''')",
      '        .directory(everframeRootDir)',
      '        .redirectErrorStream(true)',
      "      everframeProcess.environment().put('EVERFRAME_STAGING', everframeStaging)",
      '      def everframeProc = everframeProcess.start()',
      '      everframeProc.inputStream.eachLine { line -> logger.lifecycle(line) }',
      '      def everframeExitCode = everframeProc.waitFor()',
      '      if (everframeExitCode != 0) {',
      "        throw new GradleException(\"everframe: build artifact upload failed (exit code ${everframeExitCode})\")",
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    modConfig.modResults.contents = CodeGenerator.mergeContents({
      src: modConfig.modResults.contents,
      newSrc,
      tag: MERGE_TAG,
      anchor: /^apply plugin:\s*["']com\.android\.application["']/m,
      offset: 1,
      comment: '//',
    }).contents;
    return modConfig;
  });
};

/** Appends the upload as the last Run Script phase, after RN's bundling phase. */
const withEverframeIOS: ConfigPlugin<WithEverframeOptions> = (config, { appId }) => {
  return withXcodeProject(config, (modConfig) => {
    const project = modConfig.modResults;
    if (project.pbxItemByComment(XCODE_PHASE_NAME, 'PBXShellScriptBuildPhase')) {
      return modConfig;
    }
    const script = buildPhaseScript({ platform: 'ios', appId, stagingDir: '$SRCROOT/../.everframe' });
    const target = project.getFirstTarget().uuid;
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', XCODE_PHASE_NAME, target, {
      shellPath: '/bin/bash',
      shellScript: script,
    });
    return modConfig;
  });
};

/** Injects the build-artifact upload step into both Gradle and Xcode. */
export const withEverframe: ConfigPlugin<WithEverframeOptions> = (config, options) => {
  config = withEverframeAndroid(config, options);
  config = withEverframeIOS(config, options);
  return config;
};
