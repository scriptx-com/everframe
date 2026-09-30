// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runBrs, brsString } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs'];

describe('ef_frames.brs', () => {
  it('formats exception types as RuntimeError(&hXX)', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson([EfF_ExceptionType(236), EfF_ExceptionType(40), EfF_ExceptionType(invalid)])`);
    expect(lines[0]).toEqual(['RuntimeError(&hEC)', 'RuntimeError(&h28)', 'RuntimeError']);
  });

  it('turns a real backtrace into innermost-first frames', async () => {
    const { lines } = await runBrs(LIBS, `
      try
        Outer()
      catch e
        print "EFTEST:" + FormatJson(EfF_FromBacktrace(e.backtrace))
      end try
    end sub
    sub Outer()
      Inner()
    end sub
    sub Inner()
      x = invalid
      x.go()
    `);
    const frames = lines[0];
    expect(frames.map((f: any) => f.function)).toEqual(['Inner', 'Outer', 'Main']);
    expect(frames[0].file).toMatch(/^pkg:\/source\/main\.brs$/);
    expect(typeof frames[0].line).toBe('number');
    expect(frames[0].raw).toMatch(/^Inner\(\) As Void at pkg:\/source\/main\.brs\(\d+\)$/);
  });

  it('returns [] for a missing backtrace', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson(EfF_FromBacktrace(invalid))`);
    expect(lines[0]).toEqual([]);
  });

  it('parses the Roku crash console output', async () => {
    const log = readFileSync(new URL('./fixtures/console-crash.txt', import.meta.url), 'utf8');
    const lit = log.split('\n').map((l) => brsString(l)).join(' + Chr(10) + ');
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson(EfF_ParseConsoleLog(${lit}))`);
    expect(lines[0]).toEqual({
      number: 236,
      message: "'Dot' Operator attempted with invalid BrightScript Component or interface reference.",
      frames: [
        { raw: 'onkeyevent at pkg:/components/HomeScene.brs(42)', function: 'onkeyevent', file: 'pkg:/components/HomeScene.brs', line: 42 },
        { raw: 'init at pkg:/components/HomeScene.brs(10)', function: 'init', file: 'pkg:/components/HomeScene.brs', line: 10 },
      ],
    });
  });

  it('falls back to the header location when there is no Backtrace block', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson(EfF_ParseConsoleLog("boom. (runtime error &h28) in pkg:/source/main.brs(7)"))`);
    expect(lines[0].frames).toEqual([{ raw: 'pkg:/source/main.brs(7)', file: 'pkg:/source/main.brs', line: 7 }]);
  });

  it('returns invalid for beacon-only logs', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson({ r: EfF_ParseConsoleLog("[beacon.signal] |AppLaunchComplete") = invalid, n: EfF_ParseConsoleLog(invalid) = invalid })`);
    expect(lines[0]).toEqual({ r: true, n: true });
  });
});

describe('ef_record.brs', () => {
  it('builds a fatal record from a caught exception', async () => {
    const { lines } = await runBrs(LIBS, `
      try
        throw "custom boom"
      catch e
        print "EFTEST:" + FormatJson(EfR_FromException(e, "try-catch", false))
      end try
    `);
    const r = lines[0];
    expect(r).toMatchObject({ v: 1, kind: 'crash', mechanism: 'try-catch', handled: false, fatal: true, exceptionType: 'RuntimeError(&h28)', message: 'custom boom', crumbs: [] });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(r.t)).toMatch(/^\d{13}$/);
    expect(r.frames[0].function).toBe('Main');
  });

  it('accepts a plain string as a handled error', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson(EfR_FromException("just text", "captureException", true))`);
    expect(lines[0]).toMatchObject({ kind: 'error', handled: true, fatal: false, message: 'just text', exceptionType: 'RuntimeError', frames: [] });
  });
});
