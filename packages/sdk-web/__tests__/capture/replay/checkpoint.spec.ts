// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { scrubReplayEvents } from '../../../src/capture/replay/scrub.js';
import { checkpointWindow, ReplayCheckpointOmitted } from '../../../src/capture/replay/checkpoint.js';
import { beginErrorReplay } from '../../../src/capture/replay/error-replay.js';
const full = () => ({ type: 2, timestamp: 1, data: { node: { id: 1, type: 0, childNodes: [
  { id: 2, type: 2, attributes: {}, childNodes: [{ id: 3, type: 3, textContent: 'before' }] },
  { id: 4, type: 2, attributes: {}, childNodes: [] },
] } } });
const mutation = (data: object) => ({ type: 3, timestamp: 2, data: { source: 0, ...data } });
describe('exported start checkpoint', () => {
  it('folds stable mutation order, removes and reparented subtrees without changing originals', () => {
    const anchor = full();
    const before = JSON.stringify(anchor);
    const events = [anchor, mutation({ texts: [{ id: 3, value: 'first' }] }),
      mutation({ removes: [{ parentId: 2, id: 3 }], adds: [{ parentId: 4, nextId: null, node: { id: 3, type: 3, textContent: 'moved' } }] }),
      mutation({ texts: [{ id: 3, value: 'last' }] }),
      { type: 3, timestamp: 20, data: { source: 0, texts: [{ id: 3, value: 'later' }] } }];
    const checkpoint = checkpointWindow(events, 10);
    expect(checkpoint).toHaveLength(2);
    const dom = (checkpoint[0]!.data as typeof anchor.data).node;
    expect(dom.childNodes[0]!.childNodes).toEqual([]);
    expect(dom.childNodes[1]!.childNodes).toEqual([{ id: 3, type: 3, textContent: 'last' }]);
    expect(checkpoint[1]!.timestamp).toBe(20);
    expect(JSON.stringify(anchor)).toBe(before);
  });
  it('folds cutoff-equal mutations in stable order even when the full snapshot is at cutoff', () => {
    const anchor = full();
    for (const start of [1, 10]) {
      anchor.timestamp = start;
      const result = checkpointWindow([anchor,
        { ...mutation({ texts: [{ id: 3, value: 'first' }] }), timestamp: start },
        { ...mutation({ texts: [{ id: 3, value: 'cutoff' }] }), timestamp: start },
      ], start);
      expect(result).toHaveLength(1);
      expect(JSON.stringify(result)).toContain('cutoff');
    }
  });
  it('keeps toggled form choice masked through checkpoint, scrub and gzip', () => {
    const anchor = full();
    anchor.data.node.childNodes[0]!.attributes = { type: 'checkbox', checked: true };
    const events = checkpointWindow([anchor,
      { type: 3, timestamp: 2, data: { source: 5, id: 2, text: 'private-choice', isChecked: false } },
      { type: 3, timestamp: 3, data: { source: 5, id: 2, text: 'private-choice', isChecked: true } },
      { type: 3, timestamp: 11, data: { source: 5, id: 2, text: 'private-choice', isChecked: true } },
    ], 10);
    const exported = gunzipSync(gzipSync(JSON.stringify(scrubReplayEvents(events)))).toString();
    expect(exported).not.toContain('private-choice');
    expect(exported).not.toContain('"checked"');
    expect(exported).not.toContain('"isChecked":true');
    expect(exported).toContain('"isChecked":false');
  });
  it('folds masked inputs and held element scroll positions', () => {
    const result = checkpointWindow([full(),
      { type: 3, timestamp: 2, data: { source: 5, id: 2, text: 'must never leak' } },
      { type: 3, timestamp: 3, data: { source: 3, id: 4, x: 12, y: 34 } },
    ], 10);
    const dom = (result[0]!.data as ReturnType<typeof full>['data']).node;
    expect(dom.childNodes[0]!.attributes).toEqual({ value: '***' });
    expect(dom.childNodes[1]!.attributes).toEqual({ rr_scrollLeft: 12, rr_scrollTop: 34 });
    expect(JSON.stringify(result)).not.toContain('must never leak');
  });
  it('omits style object diffs and shadow/iframe additions instead of corrupting the checkpoint', () => {
    for (const change of [
      mutation({ attributes: [{ id: 2, attributes: { style: { color: 'red' } } }] }),
      mutation({ adds: [{ parentId: 2, nextId: null, node: { id: 8, type: 2, isShadow: true } }] }),
      mutation({ isAttachIframe: true, adds: [] }),
    ]) expect(() => checkpointWindow([full(), change], 10)).toThrow(ReplayCheckpointOmitted);
  });
  it('allows only finite numeric held scroll state through export scrubbing', () => {
    for (const unsafe of ['private-scroll-token', Infinity, NaN, { secret: 'private' }]) {
      const event = { data: { node: { attributes: { rr_scrollTop: unsafe, rr_scrollLeft: 12 } } } };
      const scrubbed = scrubReplayEvents([event]);
      expect(scrubbed[0]!.data.node.attributes).toEqual({ rr_scrollLeft: 12 });
    }
  });
  it('sizes the initial viewport from the most recent pre-cutoff resize', () => {
    const result = checkpointWindow([{ type: 4, timestamp: 1, data: { width: 100, height: 200, href: '/' } }, full(),
      { type: 3, timestamp: 2, data: { source: 4, width: 600, height: 400 } }], 10);
    expect(result[0]!.data).toEqual({ width: 600, height: 400, href: '/' });
  });
  it.each([7, 8, 13, 15])('omits unsupported pre-cutoff source %s and preserves the error path', async source => {
    const events = [full(), { type: 3, timestamp: 2, data: { source } }];
    expect(() => checkpointWindow(events, 10)).toThrow(ReplayCheckpointOmitted);
    expect(await beginErrorReplay({ lifecycleState: () => 'BUFFERING', snapshot: () => {
      checkpointWindow(events, 10); return Promise.resolve(null);
    } })).toEqual({ kind: 'omitted', reason: 'unsupported_state' });
    expect(events[0]!.timestamp).toBe(1);
  });
});
