// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { runBrs } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_exitinfo.brs'];
const INFO = (code: string, ts = '2026-09-29T10:00:05Z', log = '') =>
  `{ exit_code: "${code}", timestamp: "${ts}", app_state: "foreground", media_player_state: "stopped", mem_limit: 512, console_log: ${log || '""'} }`;

describe('ef_exitinfo.brs', () => {
  it('classifies exit codes', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson([
      EfX_IsAbnormal("EXIT_BRIGHTSCRIPT_CRASH"), EfX_IsAbnormal("EXIT_OUT_OF_MEMORY"),
      EfX_IsAbnormal("EXIT_CHANNEL_MEM_LIMIT_BG"), EfX_IsAbnormal("EXIT_SYSTEM_KILL"),
      EfX_IsAbnormal("EXIT_AM_LOWRESOURCE"), EfX_IsAbnormal("EXIT_SOMETHING_CRASH_NEW"),
      EfX_IsAbnormal("EXIT_UNKNOWN"), EfX_IsAbnormal("EXIT_USER_NAV")])`);
    expect(lines[0]).toEqual([true, true, true, true, true, true, false, false]);
  });

  it('reports an OOM exit as a new record with exit metadata', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      r = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      rec = EfQ_List(sec)[0].rec
      print "EFTEST:" + FormatJson({ r: r, rec: rec, lastExitTs: sec.Read("lastExitTs") })
    `);
    const { r, rec, lastExitTs } = lines[0];
    expect(r).toBe('reported');
    expect(lastExitTs).toBe('2026-09-29T10:00:05Z');
    expect(rec).toMatchObject({ kind: 'exit', mechanism: 'exit-info', fatal: true, handled: false, exceptionType: 'EXIT_OUT_OF_MEMORY', frames: [], thread: 'main' });
    expect(rec.exitInfo).toEqual({ exitCode: 'EXIT_OUT_OF_MEMORY', appState: 'foreground', mediaPlayerState: 'stopped', memLimitMb: 512 });
  });

  it('ignores an exit already handled (same timestamp on the next launch)', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      a = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      b = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      print "EFTEST:" + FormatJson({ a: a, b: b, n: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ a: 'reported', b: 'none', n: 1 });
  });

  it('records a normal exit timestamp without reporting', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      r = EfX_Process(sec, ${INFO('EXIT_UNKNOWN')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count(), ts: sec.Read("lastExitTs") })
      print "EFTEST:" + FormatJson(EfX_Process(sec, invalid))
    `);
    expect(lines[0]).toEqual({ r: 'seen', n: 0, ts: '2026-09-29T10:00:05Z' });
    expect(lines[1]).toBe('none');
  });

  it('suppresses Path B when Path A recorded the crash (merges exit info)', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      pathA = { v: 1, id: "aaaaaaaa-1", t: EfU_MsFromIso("2026-09-29T10:00:03Z"), kind: "crash", handled: false, fatal: true, exceptionType: "RuntimeError(&hEC)", message: "m", frames: [], crumbs: [] }
      EfQ_Put(sec, pathA)
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      items = EfQ_List(sec)
      print "EFTEST:" + FormatJson({ r: r, n: items.Count(), code: items[0].rec.exitInfo.exitCode, lastCrash: sec.Exists("lastCrashT") })
    `);
    expect(lines[0]).toEqual({ r: 'merged', n: 1, code: 'EXIT_BRIGHTSCRIPT_CRASH', lastCrash: false });
  });

  it('serializes the merged exitInfo key in camelCase', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      pathA = { v: 1, id: "aaaaaaaa-1", t: EfU_MsFromIso("2026-09-29T10:00:03Z"), kind: "crash", handled: false, fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [] }
      k = EfQ_Put(sec, pathA)
      EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ raw: sec.Read(k) })
    `);
    const stored = JSON.parse(lines[0].raw);
    expect(Object.keys(stored)).toContain('exitInfo');
    expect(Object.keys(stored)).not.toContain('exitinfo');
    expect(Object.keys(stored.exitInfo)).toEqual(expect.arrayContaining(['exitCode', 'memLimitMb', 'appState', 'mediaPlayerState']));
  });

  it('suppresses Path B when the Path A record was already sent', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("lastCrashT", EfU_MsFromIso("2026-09-29T10:00:03Z").ToStr())
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ r: 'merged', n: 0 });
  });

  it('parses frames from console_log when present', async () => {
    const log = `"boom. (runtime error &hec) in pkg:/components/A.brs(9)" + Chr(10) + "Backtrace:" + Chr(10) + "#0  Function go() As Void" + Chr(10) + "   file/line: pkg:/components/A.brs(9)"`;
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH', '2026-09-29T10:00:05Z', log)})
      print "EFTEST:" + FormatJson(EfQ_List(sec)[0].rec)
    `);
    expect(lines[0]).toMatchObject({ exceptionType: 'RuntimeError(&hEC)', message: 'boom.', frames: [{ function: 'go', line: 9 }] });
  });
});
