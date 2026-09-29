// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runBrs, HOOK_DIR } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'];

describe('everframe_hook.brs (no SceneGraph node yet)', () => {
  it('persists a fatal record with entry context and main thread', async () => {
    const { lines } = await runBrs(LIBS, `
      try
        x = invalid
        x.go()
      catch e
        Everframe_OnError(e, "Main (source/main.brs)", false)
      end try
      sec = EfU_Section()
      print "EFTEST:" + FormatJson({ rec: EfQ_List(sec)[0].rec, lastCrashT: sec.Exists("lastCrashT") })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0].rec).toMatchObject({ kind: 'crash', mechanism: 'try-catch', thread: 'main', context: 'Main (source/main.brs)', exceptionType: 'RuntimeError(&hEC)' });
    expect(lines[0].lastCrashT).toBe(true);
  });

  it('attaches the current memory reading from registry "mem"', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      sec.Write("mem", FormatJson({ "percent": 64, "limitMb": 286, "t": EfU_NowMs() - 2000 }))
      try
        x = invalid
        x.go()
      catch e
        Everframe_OnError(e, "Main (source/main.brs)", false)
      end try
      print "EFTEST:" + FormatJson(EfQ_List(sec)[0].rec.memory)
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0]).toEqual({ percent: 64, limitMb: 286 });
  });

  it('never throws, even with garbage input', async () => {
    const { lines } = await runBrs(LIBS, `
      Everframe_OnError(invalid, "x", false)
      Everframe_Crumb("tap", "key OK", invalid)
      print "EFTEST:" + FormatJson("survived")
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0]).toBe('survived');
  });

  it('Everframe_KeyCrumb never throws for any press/key type', async () => {
    const { lines } = await runBrs(LIBS, `
      Everframe_KeyCrumb("OK", true)
      Everframe_KeyCrumb("OK", false)
      Everframe_KeyCrumb("OK", "yes")
      Everframe_KeyCrumb("OK", invalid)
      Everframe_KeyCrumb(invalid, true)
      Everframe_KeyCrumb({}, true)
      print "EFTEST:" + FormatJson("survived")
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0]).toBe('survived');
  });

  // brs-node implements roAppManager.GetLastExitInfo() but returns
  // { exit_code: "EXIT_UNKNOWN", timestamp: invalid, ... }: no timestamp, so
  // nothing may be written. The device path (a real record) is covered by
  // swapping in a fake roAppManager-like object via Everframe__StoreExit.
  it('Everframe_RecordLastExit never throws; brs-node returns no timestamp, so nothing is stored', async () => {
    const { lines } = await runBrs(LIBS, `
      raw = CreateObject("roAppManager").GetLastExitInfo()
      Everframe_RecordLastExit()
      Everframe_RecordLastExit()
      sec = EfU_Section()
      print "EFTEST:" + FormatJson({ raw: raw, pending: sec.Exists("pendingExit") })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0].raw).toMatchObject({ exit_code: 'EXIT_UNKNOWN', timestamp: null });
    expect(lines[0].pending).toBe(false);
  });

  it('Everframe__StoreExit writes a device-shaped record verbatim and ignores incomplete ones', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = EfU_Section()
      out = []
      for each info in [invalid, "x", {}, { exit_code: "EXIT_UNKNOWN", timestamp: invalid }, { exit_code: 3, timestamp: "t" }]
        Everframe__StoreExit(info)
        out.Push(sec.Exists("pendingExit"))
      end for
      Everframe__StoreExit({ "exit_code": "EXIT_BRIGHTSCRIPT_CRASH", "timestamp": "2026-09-29T11:58:22.036Z", "mem_limit": invalid, "console_log": "x" })
      print "EFTEST:" + FormatJson({ skipped: out, stored: ParseJson(sec.Read("pendingExit")) })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0].skipped).toEqual([false, false, false, false, false]);
    expect(lines[0].stored).toEqual({ exit_code: 'EXIT_BRIGHTSCRIPT_CRASH', timestamp: '2026-09-29T11:58:22.036Z', mem_limit: null, console_log: 'x' });
  });

  it('records nothing once start() ran with enabled: false, and that start clears the queue', async () => {
    const node = path.join(HOOK_DIR, '..', 'library/components/Everframe/Everframe.brs');
    const { lines } = await runBrs([...LIBS, 'ef_crumbs.brs', 'ef_screen.brs'], `
      sec = EfU_Section()
      EfQ_Put(sec, { v: 1, id: "id-old-xxxxxxxx", t: 1790000000100&, kind: "crash", handled: false, fatal: true, exceptionType: "E", message: "m", frames: [], crumbs: [] })
      init()
      started = start({ "sdkKey": "k", enabled: false })
      captured = captureException("handled")
      try
        x = invalid
        x.go()
      catch e
        Everframe_OnError(e, "Main (source/main.brs)", false)
      end try
      print "EFTEST:" + FormatJson({ started: started, captured: captured, queued: EfQ_List(sec).Count(), disabled: sec.Exists("disabled") })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs'), node] });
    expect(lines[0]).toEqual({ started: false, captured: false, queued: 0, disabled: true });
  });

  it('uses a registry section per channel ID (Roku shares the registry across a developer\'s channels)', async () => {
    const { lines } = await runBrs(LIBS, `
      print "EFTEST:" + FormatJson(EfU_SectionName())
    `);
    expect(lines[0]).toBe('Everframe_dev');
  });

  it('an exit from a session that ran with enabled: false is never stored, and disabling clears a pending one', async () => {
    const node = path.join(HOOK_DIR, '..', 'library/components/Everframe/Everframe.brs');
    const { lines } = await runBrs([...LIBS, 'ef_crumbs.brs', 'ef_screen.brs'], `
      sec = EfU_Section()
      sec.Write("pendingExit", "{}")
      init()
      start({ "sdkKey": "k", enabled: false })
      cleared = not sec.Exists("pendingExit")
      Everframe__StoreExit({ exit_code: "EXIT_BRIGHTSCRIPT_CRASH", timestamp: "2026-09-29T11:58:22.036Z" })
      print "EFTEST:" + FormatJson({ cleared: cleared, stored: sec.Exists("pendingExit") })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs'), node] });
    expect(lines[0]).toEqual({ cleared: true, stored: false });
  });

  it('Everframe_ScreenIf matches whole names case-insensitively and never throws', async () => {
    const { lines } = await runBrs(LIBS, `
      l = "DetailsScreen, OtherScreen"
      r = [
        Everframe__InList("DetailsScreen", l), Everframe__InList("detailsscreen", l), Everframe__InList("OTHERSCREEN", l),
        Everframe__InList("Details", l), Everframe__InList("Screen", l), Everframe__InList("DetailsScreenX", l),
        Everframe__InList("Widget", l), Everframe__InList("", l), Everframe__InList("", ""),
        Everframe__InList(invalid, l), Everframe__InList("DetailsScreen", invalid), Everframe__InList(3, l), Everframe__InList({}, "a")
      ]
      Everframe_ScreenIf("DetailsScreen", l)
      Everframe_ScreenIf(invalid, invalid)
      Everframe_ScreenIf({}, [])
      print "EFTEST:" + FormatJson(r)
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0]).toEqual([true, true, true, false, false, false, false, false, false, false, false, false, false]);
  });
});
