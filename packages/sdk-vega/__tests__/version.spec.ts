// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SDK_VERSION } from '../src/version.js';

describe('SDK_VERSION', () => {
  it('matches package.json, so reports name the installed version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
