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
});
