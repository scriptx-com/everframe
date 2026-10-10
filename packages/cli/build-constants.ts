// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from "node:fs";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Values compiled into the CLI so generated build scripts pin matching tools. */
export function buildConstants(): Record<string, string> {
  const { version } = JSON.parse(read("./package.json")) as { version: string };
  const android = /^everframeVersion=(.+)$/m.exec(read("../sdk-android/android/gradle.properties"))?.[1]?.trim();
  if (!android) throw new Error("everframeVersion missing from packages/sdk-android/android/gradle.properties");
  return { __EVERFRAME_CLI_VERSION__: JSON.stringify(version), __EVERFRAME_ANDROID_VERSION__: JSON.stringify(android) };
}
