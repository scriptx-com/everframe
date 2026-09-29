// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { runBrs } from './brs-harness.js';

describe('ef_util.brs', () => {
  it('formats ms as ISO with milliseconds and round-trips', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      iso = EfU_IsoFromMs(1790671655389&)
      print "EFTEST:" + FormatJson({ iso: iso, back: EfU_MsFromIso("2026-09-29T08:47:35Z").ToStr() })
    `);
    expect(lines[0]).toEqual({ iso: '2026-09-29T08:47:35.389Z', back: '1790671655000' });
  });

  it('keeps milliseconds when parsing Roku OS ISO timestamps', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      print "EFTEST:" + FormatJson([EfU_MsFromIso("2026-09-29T12:14:40.403Z").ToStr(), EfU_MsFromIso("2026-09-29T12:14:40.4Z").ToStr(), EfU_MsFromIso("2026-09-29T12:14:40Z").ToStr()])
    `);
    expect(lines[0]).toEqual(['1790684080403', '1790684080400', '1790684080000']);
  });

  it('NowMs is a 13-digit LongInteger', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      n = EfU_NowMs()
      print "EFTEST:" + FormatJson({ t: type(n), s: n.ToStr() })
    `);
    expect(lines[0].t).toBe('LongInteger');
    expect(lines[0].s).toMatch(/^\d{13}$/);
  });

  it('truncates head and tail and reads missing registry keys as invalid', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      sec = CreateObject("roRegistrySection", "T")
      print "EFTEST:" + FormatJson({ h: EfU_Truncate("abcdef", 3), t: EfU_Tail("abcdef", 2), inv: EfU_Truncate(invalid, 3), miss: EfU_ReadOrInvalid(sec, "nope") = invalid })
    `);
    expect(lines[0]).toEqual({ h: 'abc', t: 'ef', inv: '', miss: true });
  });

  it('normalizes user fields to strings, skipping invalid and non-scalar values', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      u1 = EfU_NormalizeUser({ id: 42, email: "a@b.c", displayName: ["x"] })
      u2 = EfU_NormalizeUser({ id: invalid, email: 3.5, displayName: "Ann" })
      u3 = EfU_NormalizeUser({ id: 12345678901&, email: true })
      u4 = EfU_NormalizeUser("nope")
      u5 = EfU_NormalizeUser({ other: 1 })
      print "EFTEST:" + FormatJson({ u1: u1, u2: u2, u3: u3, u4: u4 = invalid, u5: u5 = invalid })
    `);
    expect(lines[0].u1).toEqual({ id: '42', email: 'a@b.c' });
    expect(lines[0].u2).toEqual({ email: '3.5', displayName: 'Ann' });
    expect(Object.keys(lines[0].u2)).toContain('displayName');
    expect(lines[0].u3).toEqual({ id: '12345678901', email: 'true' });
    expect(lines[0].u4).toBe(true);
    expect(lines[0].u5).toBe(true);
  });

  it('accepts only protocol breadcrumb levels', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      out = []
      for each l in ["debug", "info", "warn", "error", "INFO", "fatal", 3, invalid]
        r = EfU_NormalizeLevel(l)
        if r = invalid then out.Push(invalid) else out.Push(r)
      end for
      print "EFTEST:" + FormatJson(out)
    `);
    expect(lines[0]).toEqual(['debug', 'info', 'warn', 'error', 'info', null, null, null]);
  });

  it('clamps maxBreadcrumbs to an integer in 1..50, else the default', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      print "EFTEST:" + FormatJson([EfU_MaxCrumbs(10), EfU_MaxCrumbs(0), EfU_MaxCrumbs(-3), EfU_MaxCrumbs(500), EfU_MaxCrumbs("20"), EfU_MaxCrumbs(7.9), EfU_MaxCrumbs(invalid), EfU_MaxCrumbs(30&)])
    `);
    expect(lines[0]).toEqual([10, 1, 1, 50, 50, 50, 50, 30]);
  });
});
