// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';

/** `everframeVersion` from the Android SDK's gradle.properties: the Android release on disk. */
export function androidVersionFrom(properties: string): string {
  const version = /^everframeVersion=(.+)$/m.exec(properties)?.[1]?.trim();
  if (!version) throw new Error('gradle.properties has no everframeVersion');
  return version;
}

/**
 * Values compiled into the CLI: its own version, and the Android release whose dev.everframe Gradle
 * plugin generated setup pins. The two release separately, so the CLI never assumes its own version
 * names a published plugin.
 */
export function buildConstants(): Record<string, string> {
  const { version } = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const android = androidVersionFrom(
    readFileSync(new URL('../sdk-android/android/gradle.properties', import.meta.url), 'utf8'),
  );
  return {
    __EVERFRAME_CLI_VERSION__: JSON.stringify(version),
    __EVERFRAME_ANDROID_VERSION__: JSON.stringify(android),
  };
}
