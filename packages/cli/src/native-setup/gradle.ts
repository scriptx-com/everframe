// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { buildPhaseScript } from './script.js';

export const GRADLE_TAG = 'everframe-build-artifacts';
const BEGIN = `// @generated begin ${GRADLE_TAG}`;
const END = `// @generated end ${GRADLE_TAG}`;
const ANCHOR = /^apply plugin:\s*["']com\.android\.application["'].*$/m;

export function assertGroovy(language: string): void {
  if (language !== 'groovy')
    throw new Error('everframe: only Groovy android/app/build.gradle files are supported, found Kotlin script.');
}

/** Escapes a script for a Groovy `'''...'''` literal: multi-line, never interpolated. */
function escapeForGroovyTripleQuoted(script: string): string {
  return script.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Runs the upload after the release JS-bundling task (name varies by RN plugin version).
 * - ProcessBuilder: Gradle 9 removed `Project.exec`.
 * - `rootDir` is read at configuration time, as the configuration cache requires.
 * - Staging is passed as an env var because `'''` strings do not interpolate.
 * - `bash`, not `sh`: dash rejects `set -o pipefail`.
 */
function gradleBlock(appId: string): string {
  const script = buildPhaseScript({ platform: 'android', appId, stagingDir: '$EVERFRAME_STAGING', projectRoot: '..' });
  return [
    BEGIN,
    'afterEvaluate {',
    '  def everframeRootDir = rootDir',
    '  def everframeStaging = "$rootDir/../.everframe".toString()',
    '  def everframeBundleTasks = tasks.matching { it.name.contains("Release") && it.name.contains("JsAndAssets") }',
    '  if (everframeBundleTasks.isEmpty()) {',
    '    logger.warn("everframe: no release JS-bundling task matched; build artifacts will not be uploaded")',
    '  }',
    '  everframeBundleTasks.configureEach { bundleTask ->',
    '    bundleTask.doLast {',
    `      def everframeProcess = new ProcessBuilder('bash', '-c', '''${escapeForGroovyTripleQuoted(script)}''')`,
    '        .directory(everframeRootDir)',
    '        .redirectErrorStream(true)',
    "      everframeProcess.environment().put('EVERFRAME_STAGING', everframeStaging)",
    '      def everframeProc = everframeProcess.start()',
    '      everframeProc.inputStream.eachLine { line -> logger.lifecycle(line) }',
    '      def everframeExitCode = everframeProc.waitFor()',
    '      if (everframeExitCode != 0) {',
    '        throw new GradleException("everframe: build artifact upload failed (exit code ${everframeExitCode})")',
    '      }',
    '    }',
    '  }',
    '}',
    END,
  ].join('\n');
}

/** Inserts or replaces the tagged block after the application plugin line. */
export function patchAppBuildGradle(contents: string, appId: string): string {
  const block = gradleBlock(appId);
  const start = contents.indexOf(BEGIN);
  if (start !== -1) {
    const end = contents.indexOf(END, start);
    if (end === -1) throw new Error(`everframe: unterminated ${GRADLE_TAG} block in build.gradle`);
    return contents.slice(0, start) + block + contents.slice(end + END.length);
  }
  const anchor = ANCHOR.exec(contents);
  if (!anchor)
    throw new Error('everframe: could not find `apply plugin: "com.android.application"` in android/app/build.gradle');
  const at = anchor.index + anchor[0].length;
  return `${contents.slice(0, at)}\n${block}${contents.slice(at)}`;
}
