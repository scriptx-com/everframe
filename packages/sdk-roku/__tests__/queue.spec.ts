// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { runBrs } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'];
const REC = (t: string) => `{ v: 1, id: "id-${t}-xxxxxxxx", t: ${t}&, kind: "crash", handled: false, fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [] }`;

describe('ef_queue.brs', () => {
  it('stores records one per key, lists oldest first, removes', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
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
      sec = EfU_Section()
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
      sec = EfU_Section()
      EfQ_Put(sec, ${REC('1790000000100')})
      ok = EfQ_AttachExit(sec, 1790000000100&, { exitCode: "EXIT_BRIGHTSCRIPT_CRASH" })
      miss = EfQ_AttachExit(sec, 1790000000999&, { exitCode: "X" })
      print "EFTEST:" + FormatJson({ ok: ok, miss: miss, code: EfQ_List(sec)[0].rec.exitInfo.exitCode })
    `);
    expect(lines[0]).toEqual({ ok: true, miss: false, code: 'EXIT_BRIGHTSCRIPT_CRASH' });
  });

  it('allows a fingerprint once per launch and 3 times per hour', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
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
      sec = EfU_Section()
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

  it('keeps exitInfo.consoleLog camelCase and tails it to 256 chars in the last Fit stage', async () => {
    const { lines } = await runBrs(LIBS, `
      rec = { v: 1, id: "id-x-xxxxxxxx", t: 1780000000000&, kind: "exit", fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [] }
      rec["exitInfo"] = { exitCode: "EXIT_X" }
      rec.exitInfo["consoleLog"] = String(2500, "a")
      print "EFTEST:" + FormatJson({ json: EfQ_Fit(rec) })
    `);
    const stored = JSON.parse(lines[0].json);
    expect(Object.keys(stored.exitInfo)).toContain('consoleLog');
    expect(stored.exitInfo.consoleLog).toHaveLength(256);
  });

  it('prunes fingerprints whose timestamps are all older than an hour when rewriting rl', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      now = 1790000000000&
      EfQ_Allow(sec, "old", now, {})
      EfQ_Allow(sec, "mixed", now, {})
      EfQ_Allow(sec, "mixed", now + 3000000&, {})
      EfQ_Allow(sec, "fresh", now + 3600005&, {})
      rl = ParseJson(sec.Read("rl"))
      print "EFTEST:" + FormatJson({ keys: rl.Keys(), mixed: rl.mixed.Count() })
    `);
    expect(lines[0].keys.sort()).toEqual(['fresh', 'mixed']);
    expect(lines[0].mixed).toBe(1);
  });

  it('EfQ_Fit never returns more than EfQ_MaxChars(), whatever the record holds', async () => {
    const { lines } = await runBrs(LIBS, `
      frames = []
      for i = 0 to 30
        frames.Push({ "function": String(120, "f"), file: "pkg:/" + String(150, "p") + ".brs", line: i, raw: String(300, "r") })
      end for
      rec = { v: 1, id: "id-big-xxxxxxxx", t: 1790000000100&, kind: "crash", handled: false, fatal: true, exceptionType: String(500, "E"), message: String(5000, "m"), frames: frames, crumbs: [], context: String(300, "c"), route: String(300, "s"), user: { id: String(900, "i"), email: String(900, "e"), "displayName": String(900, "d") }, "exitInfo": { "exitCode": "EXIT_BRIGHTSCRIPT_CRASH", "consoleLog": String(1000, "l") } }
      json = EfQ_Fit(rec)
      back = ParseJson(json)
      print "EFTEST:" + FormatJson({ len: Len(json), max: EfQ_MaxChars(), parsed: type(back) = "roAssociativeArray", frames: back.frames.Count() })
    `);
    expect(lines[0].parsed).toBe(true);
    expect(lines[0].len).toBeLessThanOrEqual(lines[0].max);
    expect(lines[0].frames).toBeGreaterThanOrEqual(1);
  });

  it('a record the registry refuses returns "" and never sets the crash marker', async () => {
    const { lines } = await runBrs(LIBS, `
      store = {}
      m.store = store
      sec = {
        GetKeyList: function() : return m.data.Keys() : end function,
        Exists: function(k) : return m.data.DoesExist(k) : end function,
        Read: function(k) : return m.data[k] : end function,
        Delete: function(k) : m.data.Delete(k) : return true : end function,
        Write: function(k, v) : return false : end function,
        Flush: function() : return true : end function,
        data: store
      }
      key = EfQ_Put(sec, ${REC('1790000000100')})
      print "EFTEST:" + FormatJson({ key: key, marker: store.DoesExist("lastCrashT") })
    `);
    expect(lines[0]).toEqual({ key: '', marker: false });
  });
});
