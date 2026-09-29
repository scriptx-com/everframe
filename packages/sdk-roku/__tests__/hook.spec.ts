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
      sec = CreateObject("roRegistrySection", "Everframe")
      print "EFTEST:" + FormatJson({ rec: EfQ_List(sec)[0].rec, lastCrashT: sec.Exists("lastCrashT") })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0].rec).toMatchObject({ kind: 'crash', mechanism: 'try-catch', thread: 'main', context: 'Main (source/main.brs)', exceptionType: 'RuntimeError(&hEC)' });
    expect(lines[0].lastCrashT).toBe(true);
  });

  it('attaches the current memory reading from registry "mem"', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
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
      sec = CreateObject("roRegistrySection", "Everframe")
      print "EFTEST:" + FormatJson({ raw: raw, pending: sec.Exists("pendingExit") })
    `, { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] });
    expect(lines[0].raw).toMatchObject({ exit_code: 'EXIT_UNKNOWN', timestamp: null });
    expect(lines[0].pending).toBe(false);
  });

  it('Everframe__StoreExit writes a device-shaped record verbatim and ignores incomplete ones', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
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
});
