// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBrs, brsString, LIB_DIR } from './brs-harness.js';

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

  // Roku only returns the exit record to the channel's own code (pkg:/), never to
  // the ComponentLibrary. Main() stores it in "pendingExit"; the reporter takes it.
  const DEVICE_JSON = '{"app_state":"foreground","console_log":"x","exit_code":"EXIT_BRIGHTSCRIPT_CRASH","media_player_state":"stopped","mem_limit":null,"timestamp":"2026-09-29T11:58:22.036Z"}';

  it('EfX_TakePending returns the stored record once and deletes the key', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("pendingExit", ${brsString(DEVICE_JSON)})
      sec.Flush()
      a = EfX_TakePending(sec)
      print "EFTEST:" + FormatJson({ a: a, left: sec.Exists("pendingExit"), b: EfX_TakePending(sec) })
    `);
    expect(lines[0]).toEqual({ a: JSON.parse(DEVICE_JSON), left: false, b: null });
  });

  it('EfX_TakePending drops garbled or non-object values', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      out = []
      for each raw in ["{not json", "[1,2]", "42", ""]
        sec.Write("pendingExit", raw)
        out.Push({ v: EfX_TakePending(sec), left: sec.Exists("pendingExit") })
      end for
      print "EFTEST:" + FormatJson(out)
    `);
    expect(lines[0]).toEqual([
      { v: null, left: false }, { v: null, left: false }, { v: null, left: false }, { v: null, left: false },
    ]);
  });

  it('a device record taken from pendingExit is processed (ms timestamp), then de-duplicated', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("pendingExit", ${brsString(DEVICE_JSON)})
      a = EfX_Process(sec, EfX_TakePending(sec))
      sec.Write("pendingExit", ${brsString(DEVICE_JSON)})
      b = EfX_Process(sec, EfX_TakePending(sec))
      rec = EfQ_List(sec)[0].rec
      print "EFTEST:" + FormatJson({ a: a, b: b, n: EfQ_List(sec).Count(), t: rec.t, type: rec.exceptionType, ts: sec.Read("lastExitTs") })
    `);
    expect(lines[0]).toEqual({ a: 'reported', b: 'none', n: 1, t: Date.UTC(2026, 8, 29, 11, 58, 22, 36), type: 'EXIT_BRIGHTSCRIPT_CRASH', ts: '2026-09-29T11:58:22.036Z' });
  });

  it('the reporter never calls roAppManager (the library cannot read exit info) and takes pendingExit', () => {
    const src = readFileSync(path.join(LIB_DIR, '..', 'EverframeReporter.brs'), 'utf8');
    expect(src).not.toMatch(/roAppManager|GetLastExitInfo\(/);
    expect(src).toMatch(/EfX_Process\(m\.sec, EfX_TakePending\(m\.sec\)\)/);
  });
});
