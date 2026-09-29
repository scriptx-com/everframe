// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Parser } from 'brighterscript';
import { wrapFunctions, MARKER, type WrapTarget } from '../src/wrap.js';
import { runBrs } from './brs-harness.js';

const T = (entries: Record<string, WrapTarget>) => new Map(Object.entries(entries));

describe('wrapFunctions', () => {
  it('wraps on the same lines so line numbers are preserved', () => {
    const src = ['sub Main()', '  print 1', 'end sub', ''].join('\n');
    const out = wrapFunctions(src, T({ main: { entry: 'Main (source/main.brs)', isTask: false } }));
    expect(out.code.split('\n')).toHaveLength(4);
    expect(out.code.split('\n')[0]).toBe(`sub Main() : try ${MARKER}`);
    expect(out.code.split('\n')[2]).toBe('catch everframe_e : Everframe_OnError(everframe_e, "Main (source/main.brs)", false) : throw everframe_e : end try : end sub');
    expect(out.wrapped).toEqual(['Main']);
    expect(Parser.parse(out.code).diagnostics).toEqual([]);
  });

  it('matches names case-insensitively and keeps trailing comments intact', () => {
    const src = ['Function OnKeyEvent(k as string, p as boolean) as boolean \' handle keys', '  return false', 'End Function'].join('\n');
    const out = wrapFunctions(src, T({ onkeyevent: { entry: 'onKeyEvent (components/Home.brs)', isTask: false, crumb: 'key' } }));
    const first = out.code.split('\n')[0]!;
    expect(first).toBe(`Function OnKeyEvent(k as string, p as boolean) as boolean : try : Everframe_KeyCrumb(k, p) ${MARKER} ' handle keys`);
    expect(Parser.parse(out.code).diagnostics).toEqual([]);
  });

  it('adds the init lifecycle crumb', () => {
    const out = wrapFunctions('sub init()\nend sub\n', T({ init: { entry: 'HomeScene', isTask: false, crumb: 'init' } }));
    expect(out.code).toContain(`sub init() : try : Everframe_Crumb("lifecycle", "init HomeScene", invalid) ${MARKER}`);
  });

  it('is idempotent', () => {
    const t = T({ main: { entry: 'Main', isTask: false } });
    const once = wrapFunctions('sub Main()\n  print 1\nend sub\n', t).code;
    const twice = wrapFunctions(once, t);
    expect(twice.code).toBe(once);
    expect(twice.wrapped).toEqual([]);
  });

  it('skips single-line functions and code before end', () => {
    const src = ['sub a() : end sub', 'sub b()', '  x = 1 : end sub', 'sub c() : x = 1', 'end sub'].join('\n');
    const out = wrapFunctions(src, T({ a: { entry: 'a', isTask: false }, b: { entry: 'b', isTask: false }, c: { entry: 'c', isTask: false } }));
    expect(out.code).toBe(src);
    expect(out.skipped.map((s) => s.fn).sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves unparsable files untouched', () => {
    const src = 'sub broken(\n';
    const out = wrapFunctions(src, T({ broken: { entry: 'x', isTask: false } }));
    expect(out.code).toBe(src);
    expect(out.skipped[0]!.reason).toMatch(/parse/);
  });

  it('preserves CRLF line endings', () => {
    const out = wrapFunctions('sub Main()\r\n  print 1\r\nend sub\r\n', T({ main: { entry: 'Main', isTask: false } }));
    expect(out.code.split('\r\n')).toHaveLength(4);
  });

  it('wrapped code runs: error is reported with entry, then re-thrown as a crash', async () => {
    const src = ['sub Main()', '  Boom()', 'end sub', 'sub Boom()', '  x = invalid', '  x.go()', 'end sub', ''].join('\n');
    const code = wrapFunctions(src, T({ main: { entry: 'Main (source/main.brs)', isTask: false } })).code;
    const dir = mkdtempSync(path.join(tmpdir(), 'efwrap-'));
    const app = path.join(dir, 'app.brs');
    const stub = path.join(dir, 'stub.brs');
    // Rename Main so the harness's own Main drives it.
    writeFileSync(app, code.replace('sub Main()', 'sub App()'));
    writeFileSync(stub, 'sub Everframe_OnError(e as object, entry as string, isTask as boolean)\n  print "EFTEST:" + FormatJson({ entry: entry, isTask: isTask, line: e.backtrace[e.backtrace.Count() - 1].line_number })\nend sub\n');
    const { lines, stdout } = await runBrs([], 'App()', { extraFiles: [app, stub] });
    expect(lines[0]).toEqual({ entry: 'Main (source/main.brs)', isTask: false, line: 6 });
    expect(stdout).toContain('EXIT_BRIGHTSCRIPT_CRASH');
  });

  const STUBS =
    'sub Everframe_Crumb(cat as string, msg as string, data as dynamic)\n  print "EFTEST:" + FormatJson({ crumb: [cat, msg] })\nend sub\n' +
    'sub Everframe_KeyCrumb(key as dynamic, press as dynamic)\n  print "EFTEST:" + FormatJson({ keyCrumb: [key, press] })\nend sub\n' +
    'sub Everframe_OnError(e as object, entry as string, isTask as boolean)\n  print "EFTEST:" + FormatJson({ onError: entry })\nend sub\n';
  const runWith = (code: string, mainBody: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'efwrap-'));
    const app = path.join(dir, 'app.brs');
    const stub = path.join(dir, 'stub.brs');
    writeFileSync(app, code);
    writeFileSync(stub, STUBS);
    return runBrs([], mainBody, { extraFiles: [app, stub] });
  };

  it('crumb key variant runs: helper gets (key, press) on every call, reports, then crashes', async () => {
    const src = ['function OnKey(k as string, p as boolean) as boolean', '  x = invalid', '  x.go()', '  return true', 'end function', ''].join('\n');
    const code = wrapFunctions(src, T({ onkey: { entry: 'OnKey (c.brs)', isTask: false, crumb: 'key' } })).code;
    const { lines, stdout } = await runWith(code, '  try : OnKey("ok", false) : catch e : print "EFTEST:" + FormatJson({ released: true }) : end try\n  OnKey("ok", true)');
    expect(Parser.parse(code).diagnostics).toEqual([]);
    expect(lines).toEqual([{ keyCrumb: ['ok', false] }, { onError: 'OnKey (c.brs)' }, { released: true }, { keyCrumb: ['ok', true] }, { onError: 'OnKey (c.brs)' }]);
    expect(stdout).toContain('EXIT_BRIGHTSCRIPT_CRASH');
  });

  it('crumb init variant runs: crumb, report, crash', async () => {
    const src = ['sub init()', '  x = invalid', '  x.go()', 'end sub', ''].join('\n');
    const code = wrapFunctions(src, T({ init: { entry: 'HomeScene', isTask: false, crumb: 'init' } })).code;
    const { lines, stdout } = await runWith(code, '  init()');
    expect(Parser.parse(code).diagnostics).toEqual([]);
    expect(lines).toEqual([{ crumb: ['lifecycle', 'init HomeScene'] }, { onError: 'HomeScene' }]);
    expect(stdout).toContain('EXIT_BRIGHTSCRIPT_CRASH');
  });

  it('reports a key-crumb target with fewer than 2 parameters but still wraps it', () => {
    const out = wrapFunctions('sub onKeyEvent(k as string)\n  print k\nend sub\n', T({ onkeyevent: { entry: 'K', isTask: false, crumb: 'key' } }));
    expect(out.wrapped).toEqual(['onKeyEvent']);
    expect(out.skipped).toEqual([{ fn: 'onKeyEvent', reason: 'onKeyEvent has fewer than 2 parameters; no key breadcrumb' }]);
    expect(out.code.split('\n')[0]).toBe(`sub onKeyEvent(k as string) : try ${MARKER}`);
    expect(Parser.parse(out.code).diagnostics).toEqual([]);
  });

  it('recordExit prelude: Everframe_RecordLastExit() first, on the signature line', () => {
    const src = ['sub Main(args as dynamic)', '  print 1', 'end sub', ''].join('\n');
    const out = wrapFunctions(src, T({ main: { entry: 'Main (source/main.brs)', isTask: false, prelude: 'recordExit' } }));
    expect(out.code.split('\n')).toHaveLength(4);
    expect(out.code.split('\n')[0]).toBe(`sub Main(args as dynamic) : try : Everframe_RecordLastExit() ${MARKER}`);
    expect(Parser.parse(out.code).diagnostics).toEqual([]);
  });

  it('recordExit prelude runs before any host code in the body', async () => {
    const src = ['sub App()', '  print "EFTEST:" + FormatJson("body")', 'end sub', ''].join('\n');
    const code = wrapFunctions(src, T({ app: { entry: 'App', isTask: false, prelude: 'recordExit' } })).code;
    const dir = mkdtempSync(path.join(tmpdir(), 'efwrap-'));
    const app = path.join(dir, 'app.brs');
    const stub = path.join(dir, 'stub.brs');
    writeFileSync(app, code);
    writeFileSync(stub, STUBS + 'sub Everframe_RecordLastExit()\n  print "EFTEST:" + FormatJson("recordLastExit")\nend sub\n');
    const { lines } = await runBrs([], '  App()', { extraFiles: [app, stub] });
    expect(lines).toEqual(['recordLastExit', 'body']);
  });
  it('screen: Everframe_Screen(<expression>) on the signature line, after the scene crumb', () => {
    const src = ['sub init()', '  print 1', 'end sub', ''].join('\n');
    const out = wrapFunctions(src, T({ init: { entry: 'DetailsScreen', isTask: false, screen: 'm.top.subtype()' } }));
    expect(out.code.split('\n')).toHaveLength(4);
    expect(out.code.split('\n')[0]).toBe(`sub init() : try : Everframe_Screen(m.top.subtype()) ${MARKER}`);
    expect(Parser.parse(out.code).diagnostics).toEqual([]);
    const both = wrapFunctions(src, T({ init: { entry: 'HomeScreen', isTask: false, crumb: 'init', screen: 'm.top.subtype()' } }));
    expect(both.code.split('\n')[0]).toBe(`sub init() : try : Everframe_Crumb("lifecycle", "init HomeScreen", invalid) : Everframe_Screen(m.top.subtype()) ${MARKER}`);
    expect(Parser.parse(both.code).diagnostics).toEqual([]);
  });

  it('screen variant runs: screen hook first, then the body; an error is still reported and re-thrown', async () => {
    const src = ['sub init()', '  print "EFTEST:" + FormatJson("body")', '  x = invalid', '  x.go()', 'end sub', ''].join('\n');
    const code = wrapFunctions(src, T({ init: { entry: 'DetailsScreen', isTask: false, screen: '"DetailsScreen"' } })).code;
    const dir = mkdtempSync(path.join(tmpdir(), 'efwrap-'));
    const app = path.join(dir, 'app.brs');
    const stub = path.join(dir, 'stub.brs');
    writeFileSync(app, code);
    writeFileSync(stub, STUBS + 'sub Everframe_Screen(name as dynamic)\n  print "EFTEST:" + FormatJson({ screen: name })\nend sub\n');
    const { lines, stdout } = await runBrs([], '  init()', { extraFiles: [app, stub] });
    expect(lines).toEqual([{ screen: 'DetailsScreen' }, 'body', { onError: 'DetailsScreen' }]);
    expect(stdout).toContain('EXIT_BRIGHTSCRIPT_CRASH');
  });
});
