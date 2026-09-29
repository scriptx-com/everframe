// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { runBrs } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_fingerprint.brs', 'ef_frames.brs', 'ef_record.brs', 'ef_queue.brs', 'ef_envelope.brs', 'ef_multipart.brs', 'ef_drain.brs'];
const REC = (t: string, msg = 'm') => `{ v: 1, id: "id-${t}-xxxxxxxx", t: ${t}&, kind: "crash", handled: false, fatal: true, mechanism: "try-catch", exceptionType: "RuntimeError(&hEC)", message: "${msg}", frames: [{ "function": "f", file: "pkg:/a.brs", line: 1 }], crumbs: [] }`;

// The stub sender pops scripted statuses off m.statuses and logs each call in m.calls.
const PRELUDE = `
  m.calls = []
  sec = CreateObject("roRegistrySection", "Everframe")
  ctx = EfE_Context("0.1.0")
  state = { seen: {}, allowed: {} }
`;
const STUB = `
function Stub(env as object) as integer
    m.calls.Push(env.payload.crash.fingerprint)
    s = m.statuses.Shift()
    return s
end function
`;

async function go(statuses: number[], body: string) {
  // Stub is appended into main via a temp lib-less trick: define it in the main body file.
  return runBrs(LIBS, `${PRELUDE}\n m.statuses = ${JSON.stringify(statuses)}\n${body}\nend sub\n${STUB}\nsub Unused()`);
}

describe('ef_drain.brs', () => {
  it('removes a record after 2xx', async () => {
    const { lines } = await go([200], `
      EfQ_Put(sec, ${REC('1790000000100')})
      retry = EfD_Drain(sec, ctx, state, Stub)
      print "EFTEST:" + FormatJson({ retry: retry, left: EfQ_List(sec).Count(), calls: m.calls.Count() })
    `);
    expect(lines[0]).toEqual({ retry: false, left: 0, calls: 1 });
  });

  it('drops a record on 400 without retry', async () => {
    const { lines } = await go([400], `
      EfQ_Put(sec, ${REC('1790000000100')})
      retry = EfD_Drain(sec, ctx, state, Stub)
      print "EFTEST:" + FormatJson({ retry: retry, left: EfQ_List(sec).Count() })
    `);
    expect(lines[0]).toEqual({ retry: false, left: 0 });
  });

  for (const status of [0, 503, 429]) {
    it(`keeps the record on ${status} and re-sends it on the next drain`, async () => {
      const { lines } = await go([status, 200], `
        EfQ_Put(sec, ${REC('1790000000100')})
        r1 = EfD_Drain(sec, ctx, state, Stub)
        left1 = EfQ_List(sec).Count()
        r2 = EfD_Drain(sec, ctx, state, Stub)
        print "EFTEST:" + FormatJson({ r1: r1, left1: left1, r2: r2, left2: EfQ_List(sec).Count(), calls: m.calls.Count() })
      `);
      expect(lines[0]).toEqual({ r1: true, left1: 1, r2: false, left2: 0, calls: 2 });
    });
  }

  it('does not burn extra hourly slots on retries', async () => {
    const { lines } = await go([503, 503, 503, 200], `
      EfQ_Put(sec, ${REC('1790000000100')})
      for i = 1 to 4
        EfD_Drain(sec, ctx, state, Stub)
      end for
      print "EFTEST:" + FormatJson({ left: EfQ_List(sec).Count(), calls: m.calls.Count() })
    `);
    expect(lines[0]).toEqual({ left: 0, calls: 4 });
  });

  it('drops a second record with the same fingerprint in one launch', async () => {
    const { lines } = await go([200, 200], `
      EfQ_Put(sec, ${REC('1790000000100')})
      EfQ_Put(sec, ${REC('1790000000200')})
      retry = EfD_Drain(sec, ctx, state, Stub)
      print "EFTEST:" + FormatJson({ retry: retry, left: EfQ_List(sec).Count(), calls: m.calls.Count() })
    `);
    expect(lines[0]).toEqual({ retry: false, left: 0, calls: 1 });
  });

  it('removes an unbuildable record and still sends the next one', async () => {
    const { lines } = await go([200], `
      sec.Write("r1790000000000_xxxxxxxx", FormatJson({ v: 1, id: "x" }))
      EfQ_Put(sec, ${REC('1790000000200')})
      retry = EfD_Drain(sec, ctx, state, Stub)
      print "EFTEST:" + FormatJson({ retry: retry, left: EfQ_List(sec).Count(), calls: m.calls.Count() })
    `);
    expect(lines[0]).toEqual({ retry: false, left: 0, calls: 1 });
  });
});
