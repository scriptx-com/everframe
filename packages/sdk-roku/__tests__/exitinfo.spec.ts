// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBrs, brsString, LIB_DIR, HOOK_DIR } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_screen.brs', 'ef_crumbs.brs', 'ef_exitinfo.brs'];
const HOOK = path.join(HOOK_DIR, 'everframe_hook.brs');
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
      sec = EfU_Section()
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
      sec = EfU_Section()
      a = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      b = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      print "EFTEST:" + FormatJson({ a: a, b: b, n: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ a: 'reported', b: 'none', n: 1 });
  });

  it('records a normal exit timestamp without reporting', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      r = EfX_Process(sec, ${INFO('EXIT_UNKNOWN')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count(), ts: sec.Read("lastExitTs") })
      print "EFTEST:" + FormatJson(EfX_Process(sec, invalid))
    `);
    expect(lines[0]).toEqual({ r: 'seen', n: 0, ts: '2026-09-29T10:00:05Z' });
    expect(lines[1]).toBe('none');
  });

  it('suppresses Path B when Path A recorded the crash (merges exit info)', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      pathA = { v: 1, id: "aaaaaaaa-1", t: EfU_MsFromIso("2026-09-29T10:00:03Z"), kind: "crash", handled: false, fatal: true, exceptionType: "RuntimeError(&hEC)", message: "m", frames: [], crumbs: [] }
      EfQ_Put(sec, pathA)
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      items = EfQ_List(sec)
      print "EFTEST:" + FormatJson({ r: r, n: items.Count(), code: items[0].rec.exitInfo.exitCode, lastCrash: sec.Exists("lastCrashT") })
    `);
    expect(lines[0]).toEqual({ r: 'merged', n: 1, code: 'EXIT_BRIGHTSCRIPT_CRASH', lastCrash: false });
  });

  it('merges by kind, not clock: device skew (OS exit 45 s ahead of the channel clock) is still the same crash', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      exitMs = EfU_MsFromIso("2026-09-29T12:29:32Z")
      pathA = { v: 1, id: "aaaaaaaa-1", t: exitMs - 45000, kind: "crash", handled: false, fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [] }
      EfQ_Put(sec, pathA)
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH', '2026-09-29T12:29:32Z')})
      items = EfQ_List(sec)
      print "EFTEST:" + FormatJson({ r: r, n: items.Count(), kind: items[0].rec.kind, code: items[0].rec.exitInfo.exitCode, lastCrash: sec.Exists("lastCrashT") })
    `);
    expect(lines[0]).toEqual({ r: 'merged', n: 1, kind: 'crash', code: 'EXIT_BRIGHTSCRIPT_CRASH', lastCrash: false });
  });

  it('suppresses (queue empty) for a skewed crash whose Path A record was already sent, any *CRASH* code', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      sec.Write("lastCrashT", (EfU_MsFromIso("2026-09-29T12:29:32Z") - 600000).ToStr())
      r = EfX_Process(sec, ${INFO('EXIT_NATIVE_CRASH', '2026-09-29T12:29:32Z')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ r: 'merged', n: 0 });
  });

  it('a memory/system kill is still reported separately even when lastCrashT is present', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      sec.Write("lastCrashT", EfU_MsFromIso("2026-09-29T10:00:03Z").ToStr())
      r = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count(), left: sec.Exists("lastCrashT") })
    `);
    expect(lines[0]).toEqual({ r: 'reported', n: 1, left: false });
  });

  // Device sequence: session 1 setScreen("Lab") then DetailsScreen, crash. Session 2:
  // Main records pendingExit, start() rotates, the host sets "Lab", the reporter
  // processes the exit. The report must carry session 1's screen and crumbs.
  it('exit report keeps the crashed session\'s screen and crumbs although the new session already set a screen', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      ' session 1 state left in the registry
      EfS_Persist(sec, "DetailsScreen")
      EfC_Persist(sec, [{ t: 1790000000000&, seq: 0, kind: "navigation", message: "screen: DetailsScreen" }])
      ' session 2: Main() -> Everframe__StoreExit (before anything is written)
      Everframe__StoreExit(${INFO('EXIT_OUT_OF_MEMORY')})
      ' start() rotation, then the host's immediate setScreen("Lab") and a crumb
      EfC_Rotate(sec)
      EfS_Rotate(sec)
      EfS_Persist(sec, "Lab")
      EfC_Persist(sec, [{ t: 1790000009000&, seq: 0, kind: "navigation", message: "screen: Lab" }])
      ' reporter Task
      r = EfX_Process(sec, EfX_TakePending(sec))
      rec = EfQ_List(sec)[0].rec
      print "EFTEST:" + FormatJson({ r: r, route: rec.route, crumbs: rec.crumbs, screenNow: sec.Read("screen") })
    `, { extraFiles: [HOOK] });
    expect(lines[0]).toEqual({
      r: 'reported',
      route: 'DetailsScreen',
      crumbs: [{ t: 1790000000000, seq: 0, kind: 'navigation', message: 'screen: DetailsScreen' }],
      screenNow: 'Lab',
    });
  });

  it('without a Main snapshot the rotated prevScreen/prevCrumbs still apply', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      sec.Write("prevScreen", "DetailsScreen")
      EfS_Persist(sec, "Lab")
      EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      print "EFTEST:" + FormatJson(EfQ_List(sec)[0].rec.route)
    `);
    expect(lines[0]).toBe('DetailsScreen');
  });

  it('serializes the merged exitInfo key in camelCase', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
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
      sec = EfU_Section()
      sec.Write("lastCrashT", EfU_MsFromIso("2026-09-29T10:00:03Z").ToStr())
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ r: 'merged', n: 0 });
  });

  it('parses frames from console_log when present', async () => {
    const log = `"boom. (runtime error &hec) in pkg:/components/A.brs(9)" + Chr(10) + "Backtrace:" + Chr(10) + "#0  Function go() As Void" + Chr(10) + "   file/line: pkg:/components/A.brs(9)"`;
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
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
      sec = EfU_Section()
      sec.Write("pendingExit", ${brsString(DEVICE_JSON)})
      sec.Flush()
      a = EfX_TakePending(sec)
      print "EFTEST:" + FormatJson({ a: a, left: sec.Exists("pendingExit"), b: EfX_TakePending(sec) })
    `);
    expect(lines[0]).toEqual({ a: JSON.parse(DEVICE_JSON), left: false, b: null });
  });

  it('EfX_TakePending drops garbled or non-object values', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
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
      sec = EfU_Section()
      sec.Write("pendingExit", ${brsString(DEVICE_JSON)})
      a = EfX_Process(sec, EfX_TakePending(sec))
      sec.Write("pendingExit", ${brsString(DEVICE_JSON)})
      b = EfX_Process(sec, EfX_TakePending(sec))
      rec = EfQ_List(sec)[0].rec
      print "EFTEST:" + FormatJson({ a: a, b: b, n: EfQ_List(sec).Count(), t: rec.t, type: rec.exceptionType, ts: sec.Read("lastExitTs") })
    `);
    expect(lines[0]).toEqual({ a: 'reported', b: 'none', n: 1, t: Date.UTC(2026, 8, 29, 11, 58, 22, 36), type: 'EXIT_BRIGHTSCRIPT_CRASH', ts: '2026-09-29T11:58:22.036Z' });
  });

  it('attaches the previous session\'s persisted crumbs (prevCrumbs) and deletes them', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      sec.Write("prevCrumbs", "[{""t"":1790000000000,""seq"":3,""kind"":""custom"",""message"":""before crash""}]")
      r = EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      print "EFTEST:" + FormatJson({ r: r, crumbs: EfQ_List(sec)[0].rec.crumbs, left: sec.Exists("prevCrumbs") })
    `);
    expect(lines[0]).toEqual({ r: 'reported', crumbs: [{ t: 1790000000000, seq: 3, kind: 'custom', message: 'before crash' }], left: false });
  });

  it('a merged Path A record keeps its own crumbs; prevCrumbs is still deleted', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      pathA = { v: 1, id: "aaaaaaaa-1", t: EfU_MsFromIso("2026-09-29T10:00:03Z"), kind: "crash", handled: false, fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [{ t: 1&, seq: 0, kind: "tap", message: "own" }] }
      EfQ_Put(sec, pathA)
      sec.Write("prevCrumbs", "[{""t"":2,""seq"":9,""kind"":""custom"",""message"":""persisted""}]")
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ r: r, crumbs: EfQ_List(sec)[0].rec.crumbs, left: sec.Exists("prevCrumbs") })
    `);
    expect(lines[0]).toEqual({ r: 'merged', crumbs: [{ t: 1, seq: 0, kind: 'tap', message: 'own' }], left: false });
  });

  it('prevCrumbs is deleted even when no exit is pending or the exit was normal', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      sec.Write("prevCrumbs", "[]")
      a = EfX_Process(sec, invalid)
      l1 = sec.Exists("prevCrumbs")
      sec.Write("prevCrumbs", "garbled{")
      b = EfX_Process(sec, ${INFO('EXIT_UNKNOWN')})
      print "EFTEST:" + FormatJson({ a: a, l1: l1, b: b, l2: sec.Exists("prevCrumbs") })
    `);
    expect(lines[0]).toEqual({ a: 'none', l1: false, b: 'seen', l2: false });
  });

  it('snapshots the previous session\'s memory reading onto the exit record (only when fresh)', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      exitMs = EfU_MsFromIso("2026-09-29T10:00:05Z")
      sec.Write("mem", FormatJson({ "percent": 97, "limitMb": 286, "t": exitMs - 4000 }))
      EfX_Process(sec, ${INFO('EXIT_OUT_OF_MEMORY')})
      a = EfQ_List(sec)[0].rec
      sec2 = CreateObject("roRegistrySection", "Everframe2")
      sec2.Write("mem", FormatJson({ "percent": 97, "limitMb": 286, "t": exitMs - 3600000 }))
      EfX_Process(sec2, ${INFO('EXIT_OUT_OF_MEMORY')})
      b = EfQ_List(sec2)[0].rec
      print "EFTEST:" + FormatJson({ a: a.memory, b: b.memory })
    `);
    expect(lines[0]).toEqual({ a: { percent: 97, limitMb: 286 }, b: null });
  });

  it('the reporter never calls roAppManager (the library cannot read exit info) and takes pendingExit', () => {
    const src = readFileSync(path.join(LIB_DIR, '..', 'EverframeReporter.brs'), 'utf8');
    expect(src).not.toMatch(/roAppManager|GetLastExitInfo\(/);
    expect(src).toMatch(/EfX_Process\(m\.sec, EfX_TakePending\(m\.sec\)\)/);
  });

  it('EfX_ClearRecovered drops a crash marker the channel outlived and keeps a fresh one', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      now = EfU_NowMs()
      sec.Write("lastCrashT", (now - 3000).ToStr())
      EfX_ClearRecovered(sec, now)
      fresh = sec.Exists("lastCrashT")
      sec.Write("lastCrashT", (now - 60000).ToStr())
      EfX_ClearRecovered(sec, now)
      stale = sec.Exists("lastCrashT")
      sec.Write("lastCrashT", "garbage")
      EfX_ClearRecovered(sec, now)
      print "EFTEST:" + FormatJson({ fresh: fresh, stale: stale, garbage: sec.Exists("lastCrashT") })
    `);
    expect(lines[0]).toEqual({ fresh: true, stale: false, garbage: false });
  });

  it('a Path A error the host recovered from does not swallow a later crash exit', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      recovered = { v: 1, id: "aaaaaaaa-1", t: EfU_NowMs() - 60000, kind: "crash", handled: false, fatal: true, exceptionType: "RuntimeError(&hEC)", message: "caught by host", frames: [], crumbs: [] }
      EfQ_Put(sec, recovered)
      EfX_ClearRecovered(sec, EfU_NowMs())
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ r: 'reported', n: 2 });
  });

  for (const code of ['EXIT_BRIGHTSCRIPT_TIMEOUT', 'EXIT_BRIGHTSCRIPT_STOP', 'EXIT_BRIGHTSCRIPT_UNK_FUNC']) {
    it(`reports ${code} (a fatal execution failure) as a new record`, async () => {
      const { lines } = await runBrs(LIBS, `
        sec = EfU_Section()
        r = EfX_Process(sec, ${INFO(code)})
        print "EFTEST:" + FormatJson({ r: r, n: EfQ_List(sec).Count() })
      `);
      expect(lines[0]).toEqual({ r: 'reported', n: 1 });
    });
  }
});
