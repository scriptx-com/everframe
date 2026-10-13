// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';

/**
 * Values compiled into the CLI. Every Everframe package ships on one version line, so the CLI's own
 * version is also the version of the dev.everframe Gradle plugin that generated setup pins.
 */
export function buildConstants(): Record<string, string> {
  const { version } = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return { __EVERFRAME_CLI_VERSION__: JSON.stringify(version) };
}
