// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli-main.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/channel-basic');

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('prints "error: <message>" and returns 1 when instrument throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = mkdtempSync(path.join(tmpdir(), 'efcli-'));
    writeFileSync(path.join(out, 'foreign.txt'), 'x');
    expect(main(['instrument', FIX, '--out', out])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^error: refusing to overwrite/));
  });

  it('returns 0 on a dry run', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(main(['instrument', FIX, '--dry-run'])).toBe(0);
  });
});
