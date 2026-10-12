// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { buildPhaseScript, checkedAppId } from './script.js';

declare const __EVERFRAME_ANDROID_VERSION__: string;
/** The dev.everframe Gradle plugin of the Android SDK version this CLI ships with. */
export const EVERFRAME_GRADLE_PLUGIN = `dev.everframe:gradle-plugin:${__EVERFRAME_ANDROID_VERSION__}`;
const PLUGIN_TAG = 'everframe-gradle-plugin';
const CLASSPATH_ANCHOR = /^([ \t]*)classpath\(\s*["']com\.facebook\.react:react-native-gradle-plugin["']\s*\)[ \t]*$/m;

/** Adds the plugin classpath to android/build.gradle's buildscript, after React Native's own plugin. */
export function patchRootBuildGradle(contents: string): string {
  const begin = `// @generated begin ${PLUGIN_TAG}`,
    end = `// @generated end ${PLUGIN_TAG}`;
  const block = (indent: string) =>
    [`${indent}${begin}`, `${indent}classpath("${EVERFRAME_GRADLE_PLUGIN}")`, `${indent}${end}`].join('\n');
  const start = contents.indexOf(begin);
  if (start !== -1) {
    const lineStart = contents.lastIndexOf('\n', start) + 1;
    const stop = contents.indexOf(end, start);
    if (stop === -1) throw new Error(`everframe: unterminated ${PLUGIN_TAG} block in android/build.gradle`);
    return contents.slice(0, lineStart) + block(contents.slice(lineStart, start)) + contents.slice(stop + end.length);
  }
  const anchor = CLASSPATH_ANCHOR.exec(contents);
  if (!anchor)
    throw new Error('everframe: could not find classpath("com.facebook.react:react-native-gradle-plugin") in android/build.gradle');
  const at = anchor.index + anchor[0].length;
  return `${contents.slice(0, at)}\n${block(anchor[1]!)}${contents.slice(at)}`;
}

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
    // The dev.everframe plugin uploads R8 mappings and native libraries after
    // release builds. A missing classpath or an older plugin must not break the build.
    'try { apply plugin: "dev.everframe" } catch (Exception everframeError) {',
    '  logger.warn("warning: everframe: the dev.everframe Gradle plugin could not be applied (${everframeError.message}); R8 mappings and native libraries will not upload")',
    '}',
    'def everframeExtension = project.extensions.findByName("everframe")',
    `if (everframeExtension?.hasProperty("appId")) { everframeExtension.appId.set("${checkedAppId(appId)}") }`,
    'afterEvaluate {',
    '  def everframeRootDir = rootDir',
    '  def everframeStaging = "$rootDir/../.everframe".toString()',
    '  def everframeBundleTasks = tasks.matching { it.name.contains("Release") && it.name.contains("JsAndAssets") }',
    '  if (everframeBundleTasks.isEmpty()) {',
    '    logger.warn("everframe: no release JS-bundling task matched; build artifacts will not be uploaded")',
    '  }',
    '  everframeBundleTasks.configureEach { bundleTask ->',
    '    def everframeVariantName = bundleTask.name - "createBundle" - "JsAndAssets"',
    '    def everframeVariant = everframeVariantName.substring(0, 1).toLowerCase() + everframeVariantName.substring(1)',
    '    bundleTask.doLast {',
    `      def everframeProcess = new ProcessBuilder('bash', '-c', '''${escapeForGroovyTripleQuoted(script)}''')`,
    '        .directory(everframeRootDir)',
    '        .redirectErrorStream(true)',
    "      everframeProcess.environment().put('EVERFRAME_STAGING', everframeStaging)",
    "      everframeProcess.environment().put('EVERFRAME_VARIANT', everframeVariant)",
    '      def everframeProc = everframeProcess.start()',
    "      everframeProc.inputStream.eachLine { line -> if (line.startsWith('warning:')) logger.warn(line) else logger.lifecycle(line) }",
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
