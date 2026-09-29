// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBrs, LIB_DIR } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_memory.brs'];

// Feeds a sequence of readings through EfMem_Check and returns the messages
// of the crumbs it emitted (null where none).
const run = async (readings: number[], limit = '286') => {
  const { lines } = await runBrs(LIBS, `
    st = EfMem_NewState()
    out = []
    for each p in [${readings.join(', ')}]
      c = EfMem_Check(st, p, ${limit})
      if c = invalid then out.Push(invalid) else out.Push(c)
    end for
    print "EFTEST:" + FormatJson(out)
  `);
  return lines[0] as Array<null | { kind: string; level: string; message: string; data: Record<string, number> }>;
};

describe('ef_memory.brs (memory pressure thresholds)', () => {
  it('emits no crumb below 75 %', async () => {
    expect(await run([10, 50, 74, 60])).toEqual([null, null, null, null]);
  });

  it('crossing 75, 90 and 95 emits once each', async () => {
    const out = await run([70, 76, 80, 91, 93, 96, 99]);
    expect(out.map((c) => c?.message ?? null)).toEqual([
      null, 'memory 76% of 286 MB', null, 'memory 91% of 286 MB', null, 'memory 96% of 286 MB', null,
    ]);
    expect(out[3]).toEqual({ kind: 'custom', level: 'warn', message: 'memory 91% of 286 MB', data: { percent: 91, limitMb: 286 } });
  });

  it('a jump over several thresholds emits one crumb and arms none of them again', async () => {
    const out = await run([50, 96, 97]);
    expect(out.map((c) => c?.message ?? null)).toEqual([null, 'memory 96% of 286 MB', null]);
  });

  it('re-arms a threshold only after usage drops at least 5 points below it', async () => {
    const out = await run([76, 72, 77, 70, 76]);
    expect(out.map((c) => c?.message ?? null)).toEqual([
      'memory 76% of 286 MB', null, null, null, 'memory 76% of 286 MB',
    ]);
  });

  it('omits the limit when unknown and ignores non-numeric readings', async () => {
    const out = await run([80, 1], 'invalid');
    expect(out[0]).toEqual({ kind: 'custom', level: 'warn', message: 'memory 80%', data: { percent: 80 } });
    const { lines } = await runBrs(LIBS, `
      st = EfMem_NewState()
      print "EFTEST:" + FormatJson([EfMem_Check(st, invalid, 286), EfMem_Check(st, "90", 286)])
    `);
    expect(lines[0]).toEqual([null, null]);
  });

  it('OS warning crumb', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson([EfMem_WarningCrumb(82, 286), EfMem_WarningCrumb(invalid, invalid)])`);
    expect(lines[0][0]).toEqual({ kind: 'custom', level: 'warn', message: 'memory warning from OS (82%)', data: { percent: 82, limitMb: 286 } });
    expect(lines[0][1]).toEqual({ kind: 'custom', level: 'warn', message: 'memory warning from OS', data: {} });
  });

  it('limit: MB from maxForegroundMemory, KB values converted, zero or missing is unknown', async () => {
    const { lines } = await runBrs(LIBS, `print "EFTEST:" + FormatJson([
      EfMem_LimitMb({ maxForegroundMemory: 286 }),
      EfMem_LimitMb({ maxForegroundMemory: 292864 }),
      EfMem_LimitMb({ maxForegroundMemory: 0 }),
      EfMem_LimitMb({}),
      EfMem_LimitMb(invalid)
    ])`);
    expect(lines[0]).toEqual([286, 286, null, null, null]);
  });

  it('persist throttle: first reading, a change of >= 1 point, or 30 s elapsed', async () => {
    const { lines } = await runBrs(LIBS, `
      last = EfMem_Reading(40, 286, 100000&)
      print "EFTEST:" + FormatJson({
        reading: last,
        a: EfMem_ShouldPersist(invalid, 40, 100000&),
        b: EfMem_ShouldPersist(last, 40, 120000&),
        c: EfMem_ShouldPersist(last, 41, 101000&),
        d: EfMem_ShouldPersist(last, 40, 130000&)
      })
    `);
    expect(lines[0]).toEqual({ reading: { percent: 40, limitMb: 286, t: 100000 }, a: true, b: false, c: true, d: true });
  });

  it('EfU_ReadMem returns a fresh reading, ignores stale or garbled ones', async () => {
    const { lines } = await runBrs(['ef_util.brs'], `
      sec = EfU_Section()
      a = EfU_ReadMem(sec, 1000&)
      sec.Write("mem", "{""percent"":88,""limitMb"":286,""t"":1790000000000}")
      b = EfU_ReadMem(sec, 1790000010000&)
      c = EfU_ReadMem(sec, 1790000400000&)
      sec.Write("mem", "{not json")
      d = EfU_ReadMem(sec, 1790000010000&)
      sec.Write("mem", "{""percent"":12,""t"":1790000000000}")
      e = EfU_ReadMem(sec, 1790000000000&)
      print "EFTEST:" + FormatJson([a, b, c, d, e])
    `);
    expect(lines[0]).toEqual([null, { percent: 88, limitMb: 286 }, null, null, { percent: 12 }]);
  });

  it('reporter: monitor feature-detected in the Task, 5 s idle poll, crumbs via the Everframe node', () => {
    const src = readFileSync(path.join(LIB_DIR, '..', 'EverframeReporter.brs'), 'utf8');
    expect(src).toMatch(/CreateObject\("roAppMemoryMonitor"\)/);
    expect(src).toMatch(/FindMemberFunction\(mon, "GetMemoryLimitPercent"\)/);
    expect(src).toMatch(/FindMemberFunction\(mon, "EnableMemoryWarningEvent"\)/);
    expect(src).toMatch(/roAppMemoryNotificationEvent/);
    expect(src).toMatch(/callFunc\("addBreadcrumb"/);
    expect(src).not.toMatch(/wait\(0, port\)/);
    const node = readFileSync(path.join(LIB_DIR, '..', 'Everframe.brs'), 'utf8');
    expect(node).not.toMatch(/roAppMemoryMonitor/); // not allowed on the render thread
    const xml = readFileSync(path.join(LIB_DIR, '..', 'EverframeReporter.xml'), 'utf8');
    expect(xml).toMatch(/lib\/ef_memory\.brs/);
  });
});
