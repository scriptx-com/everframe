// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import path from 'node:path';
import {
  RokuReleaseHealthRecordSchema,
  RokuReleaseHealthExitCodeSchema,
} from '@everframe/protocol';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runBrs, HOOK_DIR, LIB_DIR } from './brs-harness.js';
const LIBS = ['ef_util.brs', 'ef_version.brs', 'ef_health.brs'];
const PREP = `sec = EfU_Section()
cfg = { sdkKey: "key-one", endpoint: "https://one.test", debugBuild: false }
EfH_SetBridge(true)
cfg.releaseHealthLaunch = ReadAsciiFile("tmp:/everframe-health-launch.json")
now = EfU_NowMs()
app = { v: "1.2.3", b: "4", d: false }`;
const run = (body: string) =>
  runBrs(
    LIBS,
    `${PREP}\n${body.replace(/EfH_SetBridge\((true|false)\)/g, '$&\ncfg.releaseHealthLaunch = ReadAsciiFile("tmp:/everframe-health-launch.json")')}`,
  );
describe('Roku release health', () => {
  it('starts exactly once per launch with an anonymous release exposure', async () => {
    const { lines, stdout } = await run(`
      a = EfH_Start(sec, cfg, app, now)
      b = EfH_Start(sec, cfg, app, now + 10)
      items = EfH_List(sec)
      print "EFTEST:" + FormatJson({ a: a, b: b, n: items.Count(), env: EfH_Envelope(items[0].rec), armed: sec.Exists("hSession") })`);
    expect(lines.length, stdout).toBe(1);
    expect(lines[0]).toMatchObject({
      a: true,
      b: false,
      n: 1,
      armed: true,
      env: {
        schemaVersion: 7,
        phase: 'start',
        sequence: 0,
        elapsedMs: 0,
        exposure: {
          platform: 'roku',
          subject: { kind: 'anonymous' },
          app: { version: '1.2.3', build: '4', debug: false },
          loadedBuildId: null,
          loadedBundleStatus: 'not_applicable',
          sessionPolicy: 'launch-v1',
          coverage: {
            policy: 'roku-exit-info-v1',
            sampleRate: 1,
            priorQueueLosses: null,
            queueLossAccounting: 'unavailable',
          },
        },
      },
    });
    expect(RokuReleaseHealthRecordSchema.safeParse(lines[0].env).success).toBe(true);
    expect(lines[0].env.capturedAt).toBe(lines[0].env.exposure.startedAt);
    expect(lines[0].env.recordId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('requires a current capable bridge and excludes debug and opted-out launches', async () => {
    const { lines } = await run(`
      EfH_SetBridge(false)
      missing = EfH_Start(sec, cfg, app, now)
      EfH_SetBridge(true)
      app.d = true
      debug = EfH_Start(sec, cfg, app, now)
      app.d = false
      cfg.releaseHealth = false
      optout = EfH_Start(sec, cfg, app, now)
      print "EFTEST:" + FormatJson({ missing: missing, debug: debug, optout: optout, n: EfH_List(sec).Count(), armed: sec.Exists("hSession") })`);
    expect(lines[0]).toEqual({ missing: false, debug: false, optout: false, n: 0, armed: false });
  });
  for (const [code, phase, outcome] of [
    ['EXIT_USER_NAV', 'end', 'completed'],
    ['EXIT_BRIGHTSCRIPT_CRASH', 'exit', 'terminated'],
    ['EXIT_NATIVE_CRASH', 'exit', 'terminated'],
    ['EXIT_OUT_OF_MEMORY', 'exit', 'terminated'],
    ['EXIT_SYSTEM_KILL', 'exit', 'terminated'],
    ['EXIT_UNKNOWN', 'exit', 'terminated'],
  ]) {
    it(`freezes previous release and binding for ${code}`, async () => {
      const { lines } = await run(`
        EfH_Start(sec, cfg, app, now)
        previous = EfH_TakeSession(sec)
        EfH_Exit(sec, previous, { exit_code: "${code}", timestamp: EfU_IsoFromMs(now + 5000) })
        items = EfH_List(sec)
        print "EFTEST:" + FormatJson({ n: items.Count(), env: EfH_Envelope(items[1].rec), k: items[1].rec.k, e: items[1].rec.e, armed: sec.Exists("hSession") })`);
      expect(lines[0]).toMatchObject({
        n: 2,
        k: createHash('sha256').update('key-one').digest('hex'),
        e: 'https://one.test',
        armed: false,
        env: {
          phase,
          outcome,
          elapsedMs: 5000,
          exposure: { app: { version: '1.2.3', build: '4', debug: false } },
        },
      });
      expect(RokuReleaseHealthRecordSchema.safeParse(lines[0].env).success).toBe(true);
      expect(lines[0].env.reportId).toBeUndefined();
    });
  }
  it('never attributes exits across launches with no enabled library, or repeats an OS exit', async () => {
    const { lines } = await run(`
      EfH_Start(sec, cfg, app, now)
      previous = EfH_TakeSession(sec)
      info = { exit_code: "EXIT_USER_NAV", timestamp: EfU_IsoFromMs(now + 1000) }
      EfH_Exit(sec, previous, info)
      info = { exit_code: "EXIT_NATIVE_CRASH", timestamp: EfU_IsoFromMs(now + 2000) }
      EfH_Exit(sec, EfH_TakeSession(sec), info)
      EfH_SetBridge(true)
      EfH_Start(sec, cfg, app, now + 3000)
      EfH_Exit(sec, EfH_TakeSession(sec), info)
      print "EFTEST:" + FormatJson({ n: EfH_List(sec).Count(), armed: sec.Exists("hSession") })`);
    expect(lines[0]).toEqual({ n: 3, armed: false });
  });
  it('missing and unrecognized exit evidence cannot complete or terminate an exposure', async () => {
    const { lines } = await run(`
      EfH_Start(sec, cfg, app, now)
      previous = EfH_TakeSession(sec)
      EfH_Exit(sec, previous, invalid)
      EfH_Exit(sec, previous, { exit_code: "EXIT_NEW_CRASH", timestamp: EfU_IsoFromMs(now + 1000) })
      print "EFTEST:" + FormatJson(EfH_List(sec).Count())`);
    expect(lines[0]).toBe(1);
  });
  it('purges only health on opt-out', async () => {
    const { lines } = await run(`
      EfH_Start(sec, cfg, app, now)
      sec.Write("r123", "report")
      sec.Write("crumbs", "crumbs")
      EfH_Purge(sec)
      print "EFTEST:" + FormatJson({ n: EfH_List(sec).Count(), armed: sec.Exists("hSession"), report: sec.Read("r123"), crumbs: sec.Read("crumbs") })`);
    expect(lines[0]).toEqual({ n: 0, armed: false, report: 'report', crumbs: 'crumbs' });
  });
});

const POST = `
end sub
function HealthPost(env as object) as integer
  m.sent.Push(env)
  return m.status
end function
sub Unused()`;
describe('Roku health durable delivery', () => {
  for (const status of [0, 429, 503]) {
    it(`retries ${status} with stable observation identity independent of report throttles`, async () => {
      const { lines } = await run(`
        EfH_Start(sec, cfg, app, now)
        sec.Write("rl", "throttled reports")
        m.sent = []
        m.status = ${status}
        first = EfH_Drain(sec, cfg, now, HealthPost)
        m.status = 200
        second = EfH_Drain(sec, cfg, now + 1000, HealthPost)
        print "EFTEST:" + FormatJson({ first: first, second: second, n: EfH_List(sec).Count(), sent: m.sent })
${POST}`);
      expect(lines[0]).toMatchObject({ first: true, second: false, n: 0 });
      expect(lines[0].sent).toHaveLength(2);
      expect(lines[0].sent[0]).toEqual(lines[0].sent[1]);
    });
  }
  for (const changed of [
    'cfg.sdkKey = "other"',
    'cfg.endpoint = "https://two.test"',
    'now = now + 604800001&',
  ]) {
    it(`drops unrouteable or expired observations: ${changed}`, async () => {
      const { lines } = await run(`
        EfH_Start(sec, cfg, app, now)
        ${changed}
        m.sent = []
        m.status = 200
        EfH_Drain(sec, cfg, now, HealthPost)
        print "EFTEST:" + FormatJson({ n: EfH_List(sec).Count(), sent: m.sent.Count() })
${POST}`);
      expect(lines[0]).toEqual({ n: 0, sent: 0 });
    });
  }
  it('does not send previous release observations from a debug launch', async () => {
    const { lines } = await run(`
      EfH_Start(sec, cfg, app, now)
      cfg.debugBuild = true
      m.sent = []
      m.status = 200
      EfH_Drain(sec, cfg, now, HealthPost)
      print "EFTEST:" + FormatJson({ sent: m.sent.Count() })
${POST}`);
    expect(lines[0]).toEqual({ sent: 0 });
  });
  it('bounds UTF-8 queue plus session storage under three KiB, dropping oldest first', async () => {
    const { lines } = await run(`
      app.v = "版本版本版本"
      for i = 0 to 19
        EfH_TakeSession(sec)
        EfH_SetBridge(true)
        EfH_Start(sec, cfg, app, now + i)
      end for
      size = 0
      for each k in sec.GetKeyList()
        if Left(k, 1) = "h" then size = size + EfH_Bytes(k) + EfH_Bytes(sec.Read(k))
      end for
      items = EfH_List(sec)
      print "EFTEST:" + FormatJson({ size: size, n: items.Count(), first: items[0].rec.s - now, last: items[items.Count() - 1].rec.s - now })`);
    expect(lines[0].size).toBeLessThanOrEqual(3072);
    expect(lines[0].n).toBeGreaterThan(0);
    expect(lines[0].n).toBeLessThanOrEqual(6);
    expect(lines[0].first).toBeGreaterThan(0);
    expect(lines[0].last).toBe(19);
  });
});

describe('Roku health persistence safety', () => {
  for (const failure of ['write', 'flush', 'pointer']) {
    it(`does not arm a previous-session pointer after ${failure} failure`, async () => {
      const { lines } = await run(`
        sec = {
          data: {}, mode: "${failure}",
          GetKeyList: function() : return m.data.Keys() : end function,
          Exists: function(k) : return m.data.DoesExist(k) : end function,
          Read: function(k) : return m.data[k] : end function,
          Delete: function(k) : m.data.Delete(k) : return true : end function,
          Write: function(k, v)
            if m.mode = "write" or (m.mode = "pointer" and k = "hSession") then return false
            m.data[k] = v
            return true
          end function,
          Flush: function() : return m.mode <> "flush" : end function
        }
        started = EfH_Start(sec, cfg, app, now)
        print "EFTEST:" + FormatJson({ started: started, armed: sec.Exists("hSession"), n: EfH_List(sec).Count() })`);
      expect(lines[0]).toEqual({ started: false, armed: false, n: 0 });
    });
  }
  it('rejects oversized identity metadata without truncating release ownership', async () => {
    const { lines } = await run(`
      app.v = String(900, "x")
      started = EfH_Start(sec, cfg, app, now)
      print "EFTEST:" + FormatJson({ started: started, armed: sec.Exists("hSession"), n: EfH_List(sec).Count() })`);
    expect(lines[0]).toEqual({ started: false, armed: false, n: 0 });
  });
});

describe('Roku health metadata admission', () => {
  for (const version of ['""', '"   "', '"bad" + Chr(10)', 'String(65, "x")']) {
    it(`declines invalid version ${version}`, async () => {
      const { lines } = await run(`
        app.v = ${version}
        print "EFTEST:" + FormatJson({ started: EfH_Start(sec, cfg, app, now), n: EfH_List(sec).Count() })`);
      expect(lines[0]).toEqual({ started: false, n: 0 });
    });
  }
});

const HOOK_LIBS = [...LIBS, 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_fingerprint.brs'];
describe('updated host bridge health ownership', () => {
  it('rotates every launch independently from a retained abnormal report, even when disabled', async () => {
    const { lines } = await runBrs(
      HOOK_LIBS,
      `${PREP}
      EfH_Start(sec, cfg, app, now)
      Everframe__StoreExit({ exit_code: "EXIT_NATIVE_CRASH", timestamp: EfU_IsoFromMs(now + 1000) })
      ' Library fails this launch. Next launch is a normal exit of an unmonitored session.
      Everframe__StoreExit({ exit_code: "EXIT_USER_NAV", timestamp: EfU_IsoFromMs(now + 2000) })
      normal = EfH_List(sec).Count()
      cfg.releaseHealthLaunch = ReadAsciiFile("tmp:/everframe-health-launch.json")
      EfH_Start(sec, cfg, app, now + 3000)
      sec.Write("disabled", "1")
      Everframe__StoreExit({ exit_code: "EXIT_USER_NAV", timestamp: EfU_IsoFromMs(now + 4000) })
      print "EFTEST:" + FormatJson({ normal: normal, n: EfH_List(sec).Count(), armed: sec.Exists("hSession"), pending: ParseJson(sec.Read("pendingExit")).exit_code })`,
      { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] },
    );
    expect(lines[0]).toEqual({ normal: 2, n: 3, armed: false, pending: 'EXIT_NATIVE_CRASH' });
  });
  it('releaseHealth false on an already started node purges health without deleting crash reports', async () => {
    const { lines } = await runBrs(
      [...HOOK_LIBS, 'ef_crumbs.brs', 'ef_screen.brs'],
      `${PREP}
      init()
      EfH_Start(sec, cfg, app, now)
      sec.Write("r123", "report")
      m.reporter = { config: cfg, control: "RUN" }
      start({ sdkKey: "key-one", releaseHealth: false })
      print "EFTEST:" + FormatJson({ n: EfH_List(sec).Count(), armed: sec.Exists("hSession"), report: sec.Read("r123"), control: m.reporter.control })`,
      { extraFiles: [path.join(LIB_DIR, '..', 'Everframe.brs')] },
    );
    expect(lines[0]).toEqual({ n: 0, armed: false, report: 'report', control: 'RUN' });
  });
});

it('calling the Main bridge twice in one launch never rotates the current eligible session', async () => {
  const { lines } = await runBrs(
    HOOK_LIBS,
    `${PREP}
      EfH_Start(sec, cfg, app, now)
      id = ParseJson(sec.Read("hSession")).x
      Everframe_RecordLastExit()
      print "EFTEST:" + FormatJson({ same: ParseJson(sec.Read("hSession")).x = id, n: EfH_List(sec).Count() })`,
    { extraFiles: [path.join(HOOK_DIR, 'everframe_hook.brs')] },
  );
  expect(lines[0]).toEqual({ same: true, n: 1 });
});

it('requires the explicit host-read token even if a library-local tmp file exists', async () => {
  const { lines } = await run(`
    cfg.Delete("releaseHealthLaunch")
    print "EFTEST:" + FormatJson({ started: EfH_Start(sec, cfg, app, now), n: EfH_List(sec).Count() })`);
  expect(lines[0]).toEqual({ started: false, n: 0 });
});

it('matches the protocol exit whitelist without accepting speculative crash codes', async () => {
  const codes = [...RokuReleaseHealthExitCodeSchema.options, 'EXIT_USER_NAV', 'EXIT_FUTURE_CRASH'];
  const { lines } = await run(`
    accepted = []
    for each code in ${JSON.stringify(codes)}
      accepted.Push(EfH_KnownExit(code))
    end for
    print "EFTEST:" + FormatJson(accepted)`);
  expect(lines[0]).toEqual([...codes.slice(0, -1).map(() => true), false]);
});

it('keeps null build and clamps a lagging OS clock without changing the frozen exposure', async () => {
  const { lines } = await run(`
    app.Delete("b")
    EfH_Start(sec, cfg, app, now)
    previous = EfH_TakeSession(sec)
    EfH_Exit(sec, previous, { exit_code: "EXIT_NATIVE_CRASH", timestamp: EfU_IsoFromMs(now - 45000) })
    items = EfH_List(sec)
    print "EFTEST:" + FormatJson([EfH_Envelope(items[0].rec), EfH_Envelope(items[1].rec)])`);
  expect(lines[0]).toHaveLength(2);
  for (const record of lines[0])
    expect(RokuReleaseHealthRecordSchema.safeParse(record).success).toBe(true);
  expect(lines[0][1].exposure).toEqual(lines[0][0].exposure);
  expect(lines[0][1].exposure.app.build).toBeNull();
  expect(lines[0][1].elapsedMs).toBe(0);
});
