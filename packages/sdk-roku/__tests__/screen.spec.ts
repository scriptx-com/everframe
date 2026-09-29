// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Screen tracking (context.route). The Everframe node's functions only touch
// `m` and the lib helpers, so Everframe.brs runs under brs-cli as plain
// functions (the global `m` stands in for the node's `m`); start() is not run
// (it needs SceneGraph), so tests set m.sec themselves where start() would.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ReportEnvelope } from '@everframe/protocol';
import { runBrs, LIB_DIR, HOOK_DIR } from './brs-harness.js';

const NODE = path.join(LIB_DIR, '..', 'Everframe.brs');
const NODE_LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_crumbs.brs', 'ef_screen.brs'];
const Strict = (ReportEnvelope as unknown as z.ZodObject<z.ZodRawShape>).catchall(z.never());

describe('ef_screen.brs', () => {
  it('normalises names: trims, stringifies scalars, caps at 128, rejects empty/invalid/non-scalar', async () => {
    const { lines } = await runBrs(['ef_util.brs', 'ef_screen.brs'], `
      out = []
      for each v in ["  Home  ", 42, true, "", "   ", invalid, {}, [], String(200, "x")]
        out.Push(EfS_Normalize(v))
      end for
      print "EFTEST:" + FormatJson(out)
    `);
    expect(lines[0]).toEqual(['Home', '42', 'true', null, null, null, null, null, 'x'.repeat(128)]);
  });

  it('navigation crumb carries from/to (from omitted on the first screen)', async () => {
    const { lines } = await runBrs(['ef_util.brs', 'ef_screen.brs'], `
      print "EFTEST:" + FormatJson([EfS_Crumb("Home", "Details"), EfS_Crumb(invalid, "Home")])
    `);
    expect(lines[0]).toEqual([
      { kind: 'navigation', message: 'screen: Details', data: { from: 'Home', to: 'Details' } },
      { kind: 'navigation', message: 'screen: Home', data: { to: 'Home' } },
    ]);
  });

  it('rotate moves "screen" to "prevScreen"; with no "screen" a stale "prevScreen" is dropped', async () => {
    const { lines } = await runBrs(['ef_util.brs', 'ef_screen.brs'], `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("prevScreen", "Old")
      EfS_Persist(sec, "Details")
      EfS_Rotate(sec)
      a = { prev: sec.Read("prevScreen"), has: sec.Exists("screen") }
      EfS_Rotate(sec)
      b = { prev: sec.Exists("prevScreen"), has: sec.Exists("screen") }
      print "EFTEST:" + FormatJson({ a: a, b: b })
    `);
    expect(lines[0]).toEqual({ a: { prev: 'Details', has: false }, b: { prev: false, has: false } });
  });

  it('EfS_TakePrev returns the previous screen once and deletes the key', async () => {
    const { lines } = await runBrs(['ef_util.brs', 'ef_screen.brs'], `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("prevScreen", "Details")
      a = EfS_TakePrev(sec)
      b = EfS_TakePrev(sec)
      sec.Write("prevScreen", "")
      c = EfS_TakePrev(sec)
      print "EFTEST:" + FormatJson({ a: a, b: b, c: c, left: sec.Exists("prevScreen") })
    `);
    expect(lines[0]).toEqual({ a: 'Details', b: null, c: null, left: false });
  });
});

describe('Everframe node: setScreen / getScreen', () => {
  it('stores the screen, adds a navigation crumb, persists "screen", and ignores repeats and junk', async () => {
    const { lines } = await runBrs(NODE_LIBS, `
      init()
      m.sec = CreateObject("roRegistrySection", "Everframe")
      r = [setScreen("Home"), setScreen("  Details "), setScreen("Details"), setScreen(invalid), setScreen(""), setScreen({})]
      print "EFTEST:" + FormatJson({ r: r, screen: getScreen(invalid), stored: m.sec.Read("screen"), crumbs: getCrumbs(invalid) })
    `, { extraFiles: [NODE] });
    const { r, screen, stored, crumbs } = lines[0];
    expect(r).toEqual([true, true, false, false, false, false]);
    expect(screen).toBe('Details');
    expect(stored).toBe('Details');
    expect(crumbs.map((c: { message: string; data: unknown; kind: string }) => [c.kind, c.message, c.data])).toEqual([
      ['navigation', 'screen: Home', { to: 'Home' }],
      ['navigation', 'screen: Details', { from: 'Home', to: 'Details' }],
    ]);
  });

  it('before start() (no registry section yet) keeps the screen in memory only', async () => {
    const { lines } = await runBrs(NODE_LIBS, `
      init()
      setScreen("Home")
      sec = CreateObject("roRegistrySection", "Everframe")
      print "EFTEST:" + FormatJson({ screen: getScreen(invalid), stored: sec.Exists("screen") })
    `, { extraFiles: [NODE] });
    expect(lines[0]).toEqual({ screen: 'Home', stored: false });
  });

  it('getScreen is invalid until a screen is set; captureException carries the route', async () => {
    const { lines } = await runBrs(NODE_LIBS, `
      init()
      a = getScreen(invalid)
      captureException("no screen")
      setScreen("Player")
      captureException("with screen")
      sec = CreateObject("roRegistrySection", "Everframe")
      recs = EfQ_List(sec)
      out = []
      for each item in recs
        out.Push({ message: item.rec.message, route: item.rec.route })
      end for
      print "EFTEST:" + FormatJson({ a: a, recs: out })
    `, { extraFiles: [NODE] });
    expect(lines[0].a).toBeNull();
    expect(lines[0].recs).toEqual(expect.arrayContaining([
      { message: 'no screen', route: null },
      { message: 'with screen', route: 'Player' },
    ]));
  });

  it('start() rotates "screen" before persisting and the XML exposes setScreen/getScreen', () => {
    const src = readFileSync(NODE, 'utf8');
    const start = src.match(/function start\([\s\S]*?end function/)?.[0] ?? '';
    const rotateAt = start.indexOf('EfS_Rotate(');
    expect(rotateAt).toBeGreaterThan(-1);
    expect(rotateAt).toBeLessThan(start.indexOf('EfS_Persist('));
    expect(rotateAt).toBeLessThan(start.indexOf('CreateObject("roSGNode", "EverframeReporter")'));
    const xml = readFileSync(path.join(LIB_DIR, '..', 'Everframe.xml'), 'utf8');
    expect(xml).toMatch(/<function name="setScreen"/);
    expect(xml).toMatch(/<function name="getScreen"/);
    expect(xml).toMatch(/lib\/ef_screen\.brs/);
    expect(readFileSync(path.join(LIB_DIR, '..', 'EverframeReporter.xml'), 'utf8')).toMatch(/lib\/ef_screen\.brs/);
  });
});

describe('route on reports', () => {
  it('EfE_Build emits context.route (schema-valid) only when the record has one', async () => {
    const { lines } = await runBrs(['ef_util.brs', 'ef_fingerprint.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_envelope.brs'], `
      a = EfR_FromException("x", "captureException", true)
      a.route = "DetailsScreen"
      b = EfR_FromException("x", "captureException", true)
      c = EfR_FromException("x", "captureException", true)
      c.route = 42
      ctx = EfE_Context("0.1.0")
      print "EFTEST:" + FormatJson([EfE_Build(a, ctx, EfU_NowMs()), EfE_Build(b, ctx, EfU_NowMs()), EfE_Build(c, ctx, EfU_NowMs())])
    `);
    for (const env of lines[0]) {
      const parsed = Strict.safeParse(env);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    expect(lines[0][0].context.route).toBe('DetailsScreen');
    expect(lines[0][1].context).not.toHaveProperty('route');
    expect(lines[0][2].context).not.toHaveProperty('route');
  });

  const EXIT_LIBS = ['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_screen.brs', 'ef_exitinfo.brs'];
  const INFO = (code: string) =>
    `{ exit_code: "${code}", timestamp: "2026-09-29T10:00:05Z", app_state: "foreground", media_player_state: "stopped", mem_limit: 512, console_log: "" }`;

  it('an exit-info record carries the previous session\'s screen (prevScreen), which is then deleted', async () => {
    const { lines } = await runBrs(EXIT_LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("prevScreen", "DetailsScreen")
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ r: r, route: EfQ_List(sec)[0].rec.route, left: sec.Exists("prevScreen") })
    `);
    expect(lines[0]).toEqual({ r: 'reported', route: 'DetailsScreen', left: false });
  });

  it('prevScreen is deleted even with no pending exit, and a merged Path A record keeps its own route', async () => {
    const { lines } = await runBrs(EXIT_LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("prevScreen", "Stale")
      EfX_Process(sec, invalid)
      l1 = sec.Exists("prevScreen")
      pathA = { v: 1, id: "aaaaaaaa-1", t: EfU_MsFromIso("2026-09-29T10:00:03Z"), kind: "crash", handled: false, fatal: true, "exceptionType": "E", message: "m", frames: [], crumbs: [], route: "Live" }
      EfQ_Put(sec, pathA)
      sec.Write("prevScreen", "Persisted")
      r = EfX_Process(sec, ${INFO('EXIT_BRIGHTSCRIPT_CRASH')})
      print "EFTEST:" + FormatJson({ l1: l1, r: r, route: EfQ_List(sec)[0].rec.route, l2: sec.Exists("prevScreen") })
    `);
    expect(lines[0]).toEqual({ l1: false, r: 'merged', route: 'Live', l2: false });
  });
});

describe('hook: Everframe_Screen and the route on Path A records', () => {
  const HOOK = path.join(HOOK_DIR, 'everframe_hook.brs');

  it('Everframe_Screen is a silent no-op with no Everframe node, for any input', async () => {
    const { lines } = await runBrs(['ef_util.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs'], `
      Everframe_Screen("DetailsScreen")
      Everframe_Screen(invalid)
      Everframe_Screen({})
      print "EFTEST:" + FormatJson("survived")
    `, { extraFiles: [HOOK] });
    expect(lines[0]).toBe('survived');
  });

  it('Everframe_OnError reads the current screen from the node (getScreen) into rec.route', () => {
    const src = readFileSync(HOOK, 'utf8');
    const body = src.match(/sub Everframe_OnError\([\s\S]*?end sub/)?.[0] ?? '';
    expect(body).toMatch(/callFunc\("getScreen", invalid\)/);
    expect(body).toMatch(/rec\.route = /);
    const screen = src.match(/sub Everframe_Screen\(name as dynamic\)[\s\S]*?end sub/)?.[0] ?? '';
    expect(screen).toMatch(/callFunc\("setScreen", name\)/);
  });
});
