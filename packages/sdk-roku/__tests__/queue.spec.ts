// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { runBrs } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'];
const REC = (t: string) => `{ v: 1, id: "id-${t}-xxxxxxxx", t: ${t}&, kind: "crash", handled: false, fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [] }`;

describe('ef_queue.brs', () => {
  it('stores records one per key, lists oldest first, removes', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      k2 = EfQ_Put(sec, ${REC('1790000000200')})
      k1 = EfQ_Put(sec, ${REC('1790000000100')})
      items = EfQ_List(sec)
      print "EFTEST:" + FormatJson({ k1: k1, order: [items[0].rec.t.ToStr(), items[1].rec.t.ToStr()], lastCrashT: sec.Read("lastCrashT") })
      EfQ_Remove(sec, k1)
      print "EFTEST:" + FormatJson(EfQ_List(sec).Count())
    `);
    expect(lines[0].k1).toBe('r1790000000100_id-17900');
    expect(lines[0].order).toEqual(['1790000000100', '1790000000200']);
    expect(lines[0].lastCrashT).toBe('1790000000100');
    expect(lines[1]).toBe(1);
  });

  it('keeps at most 6 records, dropping the oldest', async () => {
    const puts = Array.from({ length: 8 }, (_, i) => `EfQ_Put(sec, ${REC(String(1790000000000 + i))})`).join('\n');
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      ${puts}
      items = EfQ_List(sec)
      print "EFTEST:" + FormatJson({ n: items.Count(), first: items[0].rec.t.ToStr() })
    `);
    expect(lines[0]).toEqual({ n: 6, first: '1790000000002' });
  });

  it('fits an oversized record under 2000 chars (crumbs first, then frames)', async () => {
    const { lines } = await runBrs(LIBS, `
      rec = ${REC('1790000000000')}
      for i = 0 to 49
        rec.crumbs.Push({ t: 1790000000000&, seq: i, kind: "tap", message: String(60, "k") })
      end for
      for i = 0 to 39
        f = { raw: String(80, "f"), file: "pkg:/components/X.brs", line: i }
        f["function"] = "fn" + i.ToStr()
        rec.frames.Push(f)
      end for
      json = EfQ_Fit(rec)
      back = ParseJson(json)
      print "EFTEST:" + FormatJson({ len: Len(json), crumbs: back.crumbs.Count(), frames: back.frames.Count(), firstFrame: back.frames[0]["function"] })
    `);
    expect(lines[0].len).toBeLessThanOrEqual(2000);
    expect(lines[0].firstFrame).toBe('fn0');
    expect(lines[0].frames).toBeLessThanOrEqual(10);
  });

  it('attaches exit info to the record with matching t', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      EfQ_Put(sec, ${REC('1790000000100')})
      ok = EfQ_AttachExit(sec, 1790000000100&, { exitCode: "EXIT_BRIGHTSCRIPT_CRASH" })
      miss = EfQ_AttachExit(sec, 1790000000999&, { exitCode: "X" })
      print "EFTEST:" + FormatJson({ ok: ok, miss: miss, code: EfQ_List(sec)[0].rec.exitInfo.exitCode })
    `);
    expect(lines[0]).toEqual({ ok: true, miss: false, code: 'EXIT_BRIGHTSCRIPT_CRASH' });
  });

  it('allows a fingerprint once per launch and 3 times per hour', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      now = 1790000000000&
      out = []
      out.Push(EfQ_Allow(sec, "fp1", now, {}))
      seen = {}
      out.Push(EfQ_Allow(sec, "fp1", now + 1, seen))
      out.Push(EfQ_Allow(sec, "fp1", now + 2, seen))
      out.Push(EfQ_Allow(sec, "fp1", now + 3, {}))
      out.Push(EfQ_Allow(sec, "fp1", now + 4, {}))
      out.Push(EfQ_Allow(sec, "fp1", now + 3600010&, {}))
      print "EFTEST:" + FormatJson(out)
    `);
    expect(lines[0]).toEqual([true, true, false, true, false, true]);
  });

  it('does not treat the rate-limit key as a record', async () => {
    const puts = Array.from({ length: 6 }, (_, i) => `EfQ_Put(sec, ${REC(String(1790000000000 + i))})`).join('\n');
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      EfQ_Allow(sec, "fp1", 1790000000000&, {})
      ${puts}
      items = EfQ_List(sec)
      keys = []
      for each it in items
        keys.Push(it.key)
      end for
      print "EFTEST:" + FormatJson({ n: items.Count(), keys: keys, rl: sec.Exists("rl") })
    `);
    expect(lines[0].n).toBe(6);
    expect(lines[0].keys).not.toContain('rl');
    expect(lines[0].rl).toBe(true);
  });
});
