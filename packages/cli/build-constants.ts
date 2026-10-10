// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from "node:fs";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Values compiled into the CLI so generated build scripts pin matching tools. */
export function buildConstants(): Record<string, string> {
  const { version } = JSON.parse(read("./package.json")) as { version: string };
  return { __EVERFRAME_CLI_VERSION__: JSON.stringify(version) };
}
