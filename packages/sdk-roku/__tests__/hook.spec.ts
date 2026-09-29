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
});
