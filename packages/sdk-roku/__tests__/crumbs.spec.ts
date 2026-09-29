// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBrs, LIB_DIR } from './brs-harness.js';

const LIBS = ['ef_util.brs', 'ef_crumbs.brs'];
const crumbsLiteral = (n: number, msgLen = 10) =>
  `crumbs = []
      for i = 0 to ${n - 1}
        crumbs.Push({ t: 1790000000000& + i, seq: i, kind: "custom", message: String(${msgLen}, "x") + i.ToStr() })
      end for`;

describe('ef_crumbs.brs (breadcrumbs persisted across a crash)', () => {
  it('serializes only the latest 20 crumbs, oldest dropped', async () => {
    const { lines } = await runBrs(LIBS, `
      ${crumbsLiteral(30)}
      print "EFTEST:" + FormatJson({ json: EfC_Serialize(crumbs) })
    `);
    const out = JSON.parse(lines[0].json);
    expect(out).toHaveLength(20);
    expect(out[0].seq).toBe(10);
    expect(out[19].seq).toBe(29);
  });

  it('trims the persisted JSON to at most 2000 chars by dropping the oldest', async () => {
    const { lines } = await runBrs(LIBS, `
      ${crumbsLiteral(20, 300)}
      print "EFTEST:" + FormatJson({ json: EfC_Serialize(crumbs) })
    `);
    expect(lines[0].json.length).toBeLessThanOrEqual(2000);
    const out = JSON.parse(lines[0].json);
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThan(20);
    expect(out[out.length - 1].seq).toBe(19);
  });

  it('keeps a single oversized crumb by truncating its message', async () => {
    const { lines } = await runBrs(LIBS, `
      crumbs = [{ t: 1&, seq: 0, kind: "custom", message: String(2048, "y"), data: { big: String(500, "z") } }]
      print "EFTEST:" + FormatJson({ json: EfC_Serialize(crumbs), empty: EfC_Serialize([]), bad: EfC_Serialize(invalid) })
    `);
    expect(lines[0].json.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(lines[0].json)).toHaveLength(1);
    expect(lines[0].empty).toBe('[]');
    expect(lines[0].bad).toBe('[]');
  });

  it('rotate moves "crumbs" to "prevCrumbs" (overwriting) and clears "crumbs"', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("prevCrumbs", "[{""old"":1}]")
      sec.Write("crumbs", "[{""seq"":7}]")
      EfC_Rotate(sec)
      print "EFTEST:" + FormatJson({ prev: sec.Read("prevCrumbs"), has: sec.Exists("crumbs") })
    `);
    expect(lines[0]).toEqual({ prev: '[{"seq":7}]', has: false });
  });

  it('rotate with no "crumbs" drops a stale "prevCrumbs" from an older session', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      sec.Write("prevCrumbs", "[{""old"":1}]")
      EfC_Rotate(sec)
      print "EFTEST:" + FormatJson({ prev: sec.Exists("prevCrumbs"), has: sec.Exists("crumbs") })
    `);
    expect(lines[0]).toEqual({ prev: false, has: false });
  });

  it('persist writes the serialized crumbs to "crumbs"', async () => {
    const { lines } = await runBrs(LIBS, `
      sec = CreateObject("roRegistrySection", "Everframe")
      ${crumbsLiteral(3)}
      EfC_Persist(sec, crumbs)
      print "EFTEST:" + FormatJson({ raw: sec.Read("crumbs") })
    `);
    expect(JSON.parse(lines[0].raw).map((c: { seq: number }) => c.seq)).toEqual([0, 1, 2]);
  });

  it('throttle: first write goes through, others wait 2 s', async () => {
    const { lines } = await runBrs(LIBS, `
      print "EFTEST:" + FormatJson([
        EfC_ShouldPersist(1000&, invalid),
        EfC_ShouldPersist(2500&, 1000&),
        EfC_ShouldPersist(2999&, 1000&),
        EfC_ShouldPersist(3000&, 1000&)
      ])
    `);
    expect(lines[0]).toEqual([true, false, false, true]);
  });

  it('the node flushes dirty crumbs via flushCrumbs (no Timer); the reporter calls it', () => {
    const dir = path.join(LIB_DIR, '..');
    const src = readFileSync(path.join(dir, 'Everframe.brs'), 'utf8');
    expect(src).not.toMatch(/"Timer"/);
    expect(src).toMatch(/function flushCrumbs\(/);
    expect(src).toMatch(/m\["crumbsDirty"\] = true/);
    expect(readFileSync(path.join(dir, 'Everframe.xml'), 'utf8')).toMatch(/<function name="flushCrumbs"/);
    const rep = readFileSync(path.join(dir, 'EverframeReporter.brs'), 'utf8');
    expect(rep).toMatch(/callFunc\("flushCrumbs", invalid\)/);
  });

  it('the Everframe node rotates on start() before persisting', () => {
    const src = readFileSync(path.join(LIB_DIR, '..', 'Everframe.brs'), 'utf8');
    const start = src.match(/function start\([\s\S]*?end function/)?.[0] ?? '';
    const rotateAt = start.indexOf('EfC_Rotate(');
    expect(rotateAt).toBeGreaterThan(-1);
    expect(rotateAt).toBeLessThan(start.indexOf('EfC_Persist('));
    expect(rotateAt).toBeLessThan(start.indexOf('CreateObject("roSGNode", "EverframeReporter")'));
    const xml = readFileSync(path.join(LIB_DIR, '..', 'Everframe.xml'), 'utf8');
    expect(xml).toMatch(/lib\/ef_crumbs\.brs/);
  });
});
