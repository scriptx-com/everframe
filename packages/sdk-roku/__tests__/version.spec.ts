// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runBrs } from './brs-harness.js';

describe('EF_VERSION', () => {
  it('matches package.json version', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const { lines } = await runBrs(['ef_version.brs'], `print "EFTEST:" + FormatJson(EF_VERSION())`);
    expect(lines[0]).toBe(pkg.version);
  });
});
