// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ReportEnvelope } from '@everframe/protocol';
import { runBrs } from './brs-harness.js';

// Mirrors ingest: unknown top-level keys are rejected.
const Strict = (ReportEnvelope as unknown as z.ZodObject<z.ZodRawShape>).catchall(z.never());
const LIBS = ['ef_util.brs', 'ef_fingerprint.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_envelope.brs', 'ef_multipart.brs'];

describe('ef_envelope.brs', () => {
  it('builds a schema-valid crash envelope from a Path A record', async () => {
    const { lines } = await runBrs(LIBS, `
      try
        throw "kaboom"
      catch e
        rec = EfR_FromException(e, "try-catch", false)
      end try
      rec.thread = "render"
      rec.context = "onKeyEvent (components/Home.brs)"
      rec.crumbs = [{ t: 1790000000000&, seq: 0, kind: "tap", message: "key OK" }]
      rec.user = { id: "u1" }
      ctx = EfE_Context("0.1.0")
      print "EFTEST:" + FormatJson(EfE_Build(rec, ctx, EfU_NowMs()))
    `);
    const env = lines[0];
    const parsed = Strict.safeParse(env);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(env.sdk).toEqual({ name: 'everframe-roku', version: '0.1.0', platform: 'roku', formFactor: 'tv' });
    expect(env.source).toBe('crash');
    expect(env.reporter).toEqual({ title: 'RuntimeError(&h28): kaboom', description: '', user: { id: 'u1' } });
    expect(env.payload.crash).toMatchObject({ mechanism: 'try-catch', handled: false, fatal: true, threadName: 'render', details: { context: 'onKeyEvent (components/Home.brs)' } });
    expect(Object.keys(env.payload.crash)).toContain('threadName');
    expect(Object.keys(env.payload.crash)).not.toContain('threadname');
    expect(env.payload.crash.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(env.captures.breadcrumbs).toBe(true);
    expect(env.context.device.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });

  it('builds a schema-valid handled error with exit metadata and no crumbs', async () => {
    const { lines } = await runBrs(LIBS, `
      rec = EfR_FromException("soft", "captureException", true)
      rec.exitInfo = { exitCode: "EXIT_OUT_OF_MEMORY", memLimitMb: 512 }
      print "EFTEST:" + FormatJson(EfE_Build(rec, EfE_Context("0.1.0"), EfU_NowMs()))
    `);
    const env = lines[0];
    expect(Strict.safeParse(env).success).toBe(true);
    expect(env.source).toBe('error');
    expect(env.captures.breadcrumbs).toBe(false);
    expect(env.payload.crash.details.metadata).toEqual({ exitCode: 'EXIT_OUT_OF_MEMORY', memLimitMb: 512 });
  });

  it('merges the memory reading into metadata without clobbering exit metadata', async () => {
    const { lines } = await runBrs(LIBS, `
      rec = EfR_FromException("oom", "exit-info", false)
      rec["exitInfo"] = { "exitCode": "EXIT_CHANNEL_MEM_LIMIT_FG", "memLimitMb": 286, "appState": "foreground" }
      rec.memory = { "percent": 97, "limitMb": 286 }
      a = EfE_Build(rec, EfE_Context("0.1.0"), EfU_NowMs())
      rec2 = EfR_FromException("soft", "captureException", true)
      rec2.memory = { "percent": 41 }
      b = EfE_Build(rec2, EfE_Context("0.1.0"), EfU_NowMs())
      rec3 = EfR_FromException("soft", "captureException", true)
      rec3.memory = { "percent": "bad" }
      c = EfE_Build(rec3, EfE_Context("0.1.0"), EfU_NowMs())
      print "EFTEST:" + FormatJson({ a: a, b: b, c: c, exitInfo: rec.exitInfo })
    `);
    const { a, b, c, exitInfo } = lines[0];
    for (const env of [a, b, c]) {
      const parsed = Strict.safeParse(env);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    expect(a.payload.crash.details.metadata).toEqual({
      exitCode: 'EXIT_CHANNEL_MEM_LIMIT_FG', memLimitMb: 286, appState: 'foreground', memory: { percent: 97, limitMb: 286 },
    });
    expect(exitInfo).not.toHaveProperty('memory'); // the record itself is not mutated
    expect(b.payload.crash.details.metadata).toEqual({ memory: { percent: 41 } });
    expect(c.payload.crash.details).toBeUndefined();
  });

  it('serializes a numeric user id as a string', async () => {
    const { lines } = await runBrs(LIBS, `
      rec = EfR_FromException("soft", "captureException", true)
      rec.user = EfU_NormalizeUser({ id: 42, displayName: "Ann" })
      print "EFTEST:" + FormatJson(EfE_Build(rec, EfE_Context("0.1.0"), EfU_NowMs()))
    `);
    const env = lines[0];
    expect(Strict.safeParse(env).success).toBe(true);
    expect(env.reporter.user).toEqual({ id: '42', displayName: 'Ann' });
  });

  it('multipart body parses as form-data with one envelope part', async () => {
    const { lines } = await runBrs(LIBS, `
      b = EfM_Boundary()
      print "EFTEST:" + FormatJson({ b: b, body: EfM_Body("{""x"":1}", b) })
    `);
    const { b, body } = lines[0];
    const form = await new Response(body, { headers: { 'content-type': `multipart/form-data; boundary=${b}` } }).formData();
    const part = form.get('envelope') as File;
    expect(part.name).toBe('envelope.json');
    expect(part.type).toBe('application/json');
    expect(JSON.parse(await part.text())).toEqual({ x: 1 });
  });

  it('a record keeps its own session\'s version and build, not the running app\'s', async () => {
    const { lines } = await runBrs(LIBS, `
      ctx = EfE_Context("0.1.0")
      ctx.app.build = "9"
      base = { v: 1, id: "id-v-xxxxxxxx", t: 1790000000100&, kind: "crash", handled: false, fatal: true, mechanism: "exit-info", exceptionType: "E", message: "m", frames: [], crumbs: [] }
      a = EfE_Build(base, ctx, EfU_NowMs()).context.app
      base["appVersion"] = "1.0.0"
      b = EfE_Build(base, ctx, EfU_NowMs()).context.app
      base["appBuild"] = "7"
      c = EfE_Build(base, ctx, EfU_NowMs()).context.app
      print "EFTEST:" + FormatJson({ a: a.build, b: [b.version, b.build], c: [c.version, c.build] })
    `);
    expect(lines[0]).toEqual({ a: '9', b: ['1.0.0', null], c: ['1.0.0', '7'] });
  });
});
