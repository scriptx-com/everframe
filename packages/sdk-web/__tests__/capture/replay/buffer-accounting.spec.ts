// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { createRollingBuffer, type BufferEvent } from '../../../src/capture/replay/buffer.js';

describe('replay buffer accounting without serialization', () => {
  it.each([
    { node: { tagName: 'div', attributes: { class: 'card' }, childNodes: [] } },
    { text: '漢字 😀 \ud800 \udc00 " \\ \n \u0000', values: [null, true, false, 1e-200] },
    { values: [undefined, , NaN, Infinity], omitted: undefined },
    { nested: [{ a: { b: ['x', 'y', -0, -1.7976931348623157e308] } }] },
  ])('never undercounts encoded JSON for %j', (data) => {
    const event = { type: 2, timestamp: 0, data };
    const buf = createRollingBuffer({ durationSec: 30 });
    buf.push(event);
    expect(buf.frames()).toEqual([event]);
    expect(buf.byteSize()).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(event)));
    expect(buf.capBreached()).toBe(false);
  });

  it('enforces the byte cap for multibyte text', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxBytes: 3000 });
    buf.push({ type: 2, timestamp: 0, data: { text: '漢'.repeat(1500) } });
    expect(buf.capBreached()).toBe(true);
  });

  it('fails closed on cyclic, oversized or custom-serialized payloads', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = 'leaf';
    for (let i = 0; i < 1000; i++) deep = { child: deep };
    for (const data of [cycle, deep, { toJSON: () => 'x'.repeat(10000) }]) {
      const buf = createRollingBuffer({ durationSec: 30, maxBytes: 100 });
      expect(() => buf.push({ type: 2, timestamp: 0, data })).not.toThrow();
      expect(buf.capBreached()).toBe(true);
    }
  });

  it('accepts a small deeply nested rrweb tree without overflowing the byte cap', () => {
    let node: unknown = { type: 3, id: 1001, textContent: 'Visible content' };
    for (let id = 1000; id > 0; id--) {
      node = { type: 2, id, tagName: 'div', attributes: {}, childNodes: [node] };
    }
    const event = { type: 2, timestamp: 0, data: { node } };
    const buf = createRollingBuffer({ durationSec: 30 });
    buf.push(event);
    expect(buf.capBreached()).toBe(false);
    expect(buf.byteSize()).toBe(Buffer.byteLength(JSON.stringify(event)));
    expect(buf.frames()).toEqual([event]);
  });

  it('counts repeated references in deep trees without mistaking them for cycles', () => {
    const leaf = { text: 'Shared content' };
    let data: unknown = [leaf, leaf];
    for (let i = 0; i < 200; i++) data = { child: data };
    const event = { type: 2, timestamp: 0, data };
    const buf = createRollingBuffer({ durationSec: 30 });
    buf.push(event);
    expect(buf.capBreached()).toBe(false);
    expect(buf.byteSize()).toBe(Buffer.byteLength(JSON.stringify(event)));
  });

  it('counts deep sparse arrays and escaped text conservatively', () => {
    let data: unknown = { omitted: undefined, array: [undefined, , '漢字 😀 " \\ \n', NaN] };
    for (let i = 0; i < 200; i++) data = { child: data };
    const event = { type: 2, timestamp: 0, data };
    const buf = createRollingBuffer({ durationSec: 30 });
    buf.push(event);
    expect(buf.capBreached()).toBe(false);
    expect(buf.byteSize()).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(event)));
    expect(buf.byteSize()).toBeLessThan(3000);
  });

  it('terminates deep cycles and pathological nesting under the normal byte cap', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = null;
    for (let i = 0; i < 10000; i++) deep = [deep];
    for (const data of [cycle, deep]) {
      const buf = createRollingBuffer({ durationSec: 30 });
      expect(() => buf.push({ type: 2, timestamp: 0, data })).not.toThrow();
      expect(buf.capBreached()).toBe(true);
    }
  });

  it('does not revisit retained events when pruning cannot advance the anchor', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    let reads = 0;
    for (let i = 0; i < 5000; i++) {
      const event: BufferEvent = {
        get type() { reads++; return i === 0 ? 2 : 3; },
        get timestamp() { reads++; return i; },
      };
      buf.push(event);
      buf.rotate(i);
    }
    reads = 0;
    for (let i = 0; i < 100; i++) buf.rotate(5000 + i);
    expect(reads).toBe(0);
    expect(buf.size()).toBe(5000);
  });
});

describe('snapshot segment retention', () => {
  it.each(['meta', 'snapshot'] as const)('does not breach at a checkout Meta when %s carries the checkout flag', (flag) => {
    const first = [
      { type: 4, timestamp: 0 },
      { type: 2, timestamp: 0, data: { text: 'x'.repeat(100) } },
      { type: 3, timestamp: 1, data: { text: 'y'.repeat(100) } },
    ];
    for (const cap of [{ maxEvents: 3 }, { maxBytes: first.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0) }]) {
      const buf = createRollingBuffer({ durationSec: 30, ...cap });
      const next = [{ type: 4, timestamp: 15000 }, { type: 2, timestamp: 15000 }];
      for (const e of [...first, ...next]) {
        buf.push(e, e.type === (flag === 'meta' ? 4 : 2));
        buf.rotate(e.timestamp);
        expect(buf.capBreached()).toBe(false);
      }
      expect(buf.frames()).toEqual(next);
    }
  });

  it('keeps the anchor before the cutoff across three checkouts, then releases it', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    const events: BufferEvent[] = [];
    for (const timestamp of [0, 15000, 30000]) {
      for (const event of [{ type: 4, timestamp }, { type: 2, timestamp }, { type: 3, timestamp: timestamp + 1 }]) {
        events.push(event);
        buf.push(event, event.type === 4);
        buf.rotate(event.timestamp);
      }
    }
    buf.rotate(40000);
    expect(buf.frames()).toEqual(events);
    buf.rotate(45000);
    expect(buf.frames()).toEqual(events.slice(3));
    expect(buf.size()).toBe(6);
    const retainedBytes = buf.byteSize();
    buf.rotate(45001);
    expect(buf.byteSize()).toBe(retainedBytes);
    buf.clear();
    expect(buf.frames()).toEqual([]);
    expect(buf.byteSize()).toBe(0);
    expect(buf.size()).toBe(0);
    expect(buf.oldestTs()).toBeNull();
  });

  it('sheds complete old segments during normal per-event rotation and preserves Meta', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxBytes: 500 });
    for (const timestamp of [0, 15000, 30000, 45000]) {
      for (const event of [
        { type: 4, timestamp },
        { type: 2, timestamp, data: { text: 'x'.repeat(100) } },
        { type: 3, timestamp: timestamp + 1, data: { text: 'y'.repeat(100) } },
      ]) {
        buf.push(event, event.type === 4);
        buf.rotate(event.timestamp);
        expect(buf.capBreached()).toBe(false);
      }
    }
    expect(buf.frames().slice(0, 2).map(e => [e.type, e.timestamp])).toEqual([[4, 45000], [2, 45000]]);
    expect(buf.size()).toBe(buf.frames().length);
    expect(buf.byteSize()).toBeLessThanOrEqual(500);
  });
});

describe('incomplete checkouts', () => {
  it('drops an unplayable orphan prefix when cap shedding removes its previous anchor', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxEvents: 6 });
    const fresh = [{ type: 4, timestamp: 30000 }, { type: 2, timestamp: 30000 }, { type: 3, timestamp: 30001 }];
    for (const event of [
      { type: 4, timestamp: 0 }, { type: 2, timestamp: 0 },
      { type: 4, timestamp: 15000 }, { type: 3, timestamp: 15001 },
      ...fresh,
    ]) buf.push(event);
    expect(buf.capBreached()).toBe(false);
    buf.rotate(65000);
    expect(buf.frames()).toEqual(fresh);
    expect(buf.size()).toBe(3);
    expect(buf.byteSize()).toBe(fresh.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0));
  });

  it('prunes past orphan Meta segments only after a complete replacement anchor is eligible', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    const old = [{ type: 4, timestamp: 0 }, { type: 2, timestamp: 0 }];
    const orphan = [{ type: 4, timestamp: 15000 }, { type: 3, timestamp: 15001 }];
    for (const event of [...old, ...orphan]) buf.push(event);
    buf.rotate(65000);
    expect(buf.frames()).toEqual([...old, ...orphan]);
    const fresh = [{ type: 4, timestamp: 30000 }, { type: 2, timestamp: 30000 }, { type: 3, timestamp: 30001 }];
    for (const event of fresh) buf.push(event);
    buf.rotate(59000);
    expect(buf.frames()).toEqual([...old, ...orphan, ...fresh]);
    buf.rotate(65000);
    expect(buf.frames()).toEqual(fresh);
    expect(buf.oldestTs()).toBe(30000);
    expect(buf.size()).toBe(3);
    expect(buf.byteSize()).toBe(fresh.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0));
  });

  it('retains a pending checkout after pruning earlier orphan segments', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    const events = [
      { type: 4, timestamp: 0 }, { type: 2, timestamp: 0 },
      { type: 4, timestamp: 15000 }, { type: 3, timestamp: 15001 },
      { type: 4, timestamp: 30000 }, { type: 2, timestamp: 30000 },
      { type: 4, timestamp: 45000 },
    ];
    for (const event of events) buf.push(event);
    buf.rotate(100000);
    expect(buf.frames()).toEqual(events.slice(4));
    buf.push({ type: 2, timestamp: 45000 });
    buf.rotate(100000);
    expect(buf.frames().map(e => [e.type, e.timestamp])).toEqual([[4, 45000], [2, 45000]]);
  });
});
