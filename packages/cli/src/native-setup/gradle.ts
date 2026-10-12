// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { CLI_VERSION } from '../version.js';
import { checkedAppId } from './script.js';

/** The dev.everframe Gradle plugin released with this CLI; both share the Everframe version. */
export const EVERFRAME_GRADLE_PLUGIN = `dev.everframe:gradle-plugin:${CLI_VERSION}`;
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

/**
 * The app module's whole Everframe setup. The dev.everframe Gradle plugin does the uploads:
 * R8 mappings and native libraries after `assemble<Variant>`/`bundle<Variant>`, and the Hermes
 * bundle with its source map after React Native's `createBundle<Variant>JsAndAssets`.
 */
function gradleBlock(appId: string): string {
  return [BEGIN, 'apply plugin: "dev.everframe"', `everframe { appId = "${checkedAppId(appId)}" }`, END].join('\n');
}

/**
 * Inserts the tagged block after the application plugin line, or replaces an existing one. The
 * long block earlier versions generated has the same tags, so it is replaced by the short one.
 */
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
