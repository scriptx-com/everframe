// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  it('--dry-run lists tracked screens; --screens none turns them off', () => {
    const chan = mkdtempSync(path.join(tmpdir(), 'efcli-'));
    cpSync(FIX, chan, { recursive: true });
    writeFileSync(path.join(chan, 'components/HomeView.xml'), '<?xml version="1.0" encoding="utf-8" ?>\n<component name="HomeView" extends="Group">\n  <script type="text/brightscript" uri="HomeView.brs" />\n</component>\n');
    writeFileSync(path.join(chan, 'components/HomeView.brs'), 'sub init()\n  print 1\nend sub\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(main(['instrument', chan, '--dry-run'])).toBe(0);
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('screen   components/HomeView.brs  HomeView  via HomeView');
    expect(printed.at(-1)).toMatch(/1 screen\(s\) tracked/);
    log.mockClear();
    expect(main(['instrument', chan, '--dry-run', '--screens', 'none'])).toBe(0);
    const off = log.mock.calls.map((c) => String(c[0]));
    expect(off.some((l) => l.startsWith('screen '))).toBe(false);
    expect(off.at(-1)).toMatch(/0 screen\(s\) tracked/);
  });
});
