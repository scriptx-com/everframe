// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  CaptureControlRender,
  DOM_SNAPSHOT_CONTENT_TYPE,
  DOM_SNAPSHOT_VERSION,
  MAX_DOM_SNAPSHOT_COMPRESSED_BYTES,
  MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES,
  MAX_DOM_SNAPSHOT_NODES,
  ReportEnvelope,
  countDomSnapshotNodes,
  domSnapshotPartName,
  parseDomSnapshot,
  parseDomSnapshotPartName,
  readCaptureControlRender,
} from '../src/index.js';
import { baseEnvelope } from './helpers/base-envelope.js';

function validSnapshot(): Record<string, any> {
  return {
    v: 1,
    events: [
      { type: 4, timestamp: 1_760_000_000_000, data: { href: 'https://tv.example/home', width: 960, height: 540 } },
      {
        type: 2,
        timestamp: 1_760_000_000_000,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [] }],
          },
          initialOffset: { top: 120, left: 0 },
        },
      },
    ],
    context: {
      dpr: 2,
      platform: 'webos',
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79.0',
      fonts: { status: 'loaded', loaded: ['Museo Sans'], failed: [] },
      focusedId: 2,
      media: { prefersColorScheme: 'dark', prefersReducedMotion: 'no-preference', forcedColors: 'none' },
      viewport: { width: 960, height: 540 },
    },
  };
}

describe('parseDomSnapshot', () => {
  it('accepts a v1 snapshot', () => {
    const result = parseDomSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.v).toBe(DOM_SNAPSHOT_VERSION);
      expect(result.snapshot.context.focusedId).toBe(2);
    }
  });

  it('reports an unknown version as unsupported, not invalid', () => {
    const result = parseDomSnapshot({ ...validSnapshot(), v: 2 });
    expect(result).toEqual({ ok: false, error: 'unsupported_version', version: 2 });
  });

  it('rejects a bare rrweb event array (the replay format)', () => {
    const result = parseDomSnapshot(validSnapshot().events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_snapshot');
  });

  it('rejects an object without a version', () => {
    const { v: _v, ...rest } = validSnapshot();
    const result = parseDomSnapshot(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_snapshot');
  });

  it('requires the Meta event before the FullSnapshot', () => {
    const snap = validSnapshot();
    snap.events.reverse();
    expect(parseDomSnapshot(snap).ok).toBe(false);
  });

  it('rejects a non-finite scroll offset', () => {
    const snap = validSnapshot();
    snap.events[1].data.initialOffset.top = Number.NaN;
    expect(parseDomSnapshot(snap).ok).toBe(false);
  });

  it('rejects a viewport edge beyond the render cap', () => {
    const snap = validSnapshot();
    snap.context.viewport.width = 5000;
    expect(parseDomSnapshot(snap).ok).toBe(false);
  });

  it('accepts no focused element', () => {
    const snap = validSnapshot();
    snap.context.focusedId = null;
    expect(parseDomSnapshot(snap).ok).toBe(true);
  });

  it('rejects an unknown platform family', () => {
    const snap = validSnapshot();
    snap.context.platform = 'roku';
    expect(parseDomSnapshot(snap).ok).toBe(false);
  });

  it('rejects a FullSnapshot whose root is not a Document node', () => {
    const snap = validSnapshot();
    snap.events[1].data.node.type = 2;
    expect(parseDomSnapshot(snap).ok).toBe(false);
  });
});

describe('countDomSnapshotNodes', () => {
  it('counts the document and every descendant', () => {
    const result = parseDomSnapshot(validSnapshot());
    if (!result.ok) throw new Error('fixture invalid');
    expect(countDomSnapshotNodes(result.snapshot, 100)).toBe(2);
  });

  it('stops counting once the limit is exceeded', () => {
    const snap = validSnapshot();
    snap.events[1].data.node.childNodes[0].childNodes = Array.from({ length: 500 }, (_, i) => ({
      type: 3,
      id: 10 + i,
      textContent: 'x',
    }));
    const result = parseDomSnapshot(snap);
    if (!result.ok) throw new Error('fixture invalid');
    expect(countDomSnapshotNodes(result.snapshot, 10)).toBe(11);
  });
});

describe('dom-snapshot constants and part names', () => {
  it('pins the size caps and content type', () => {
    expect(MAX_DOM_SNAPSHOT_COMPRESSED_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_DOM_SNAPSHOT_NODES).toBe(50_000);
    expect(DOM_SNAPSHOT_CONTENT_TYPE).toBe('application/gzip');
  });

  it('mirrors the screenshot part naming', () => {
    expect(domSnapshotPartName(1)).toBe('dom-snapshot');
    expect(domSnapshotPartName(3)).toBe('dom-snapshot-3');
    expect(parseDomSnapshotPartName('dom-snapshot')).toBe(1);
    expect(parseDomSnapshotPartName('dom-snapshot-3')).toBe(3);
    expect(parseDomSnapshotPartName('dom-snapshot-x')).toBeNull();
    for (const bad of ['dom-snapshot-0', 'dom-snapshot-1', 'dom-snapshot-01', 'dom-snapshot-02', 'dom-snapshot-']) {
      expect(parseDomSnapshotPartName(bad)).toBeNull();
    }
    expect(parseDomSnapshotPartName('dom-snapshot-12')).toBe(12);
    expect(parseDomSnapshotPartName('screenshot-3')).toBeNull();
    expect(() => domSnapshotPartName(0)).toThrow(RangeError);
  });
});

describe('captureControl.render', () => {
  const render = {
    platform: 'tizen',
    viewport: { width: 1920, height: 1080 },
    dpr: 1,
    fontStatus: 'loading',
  };

  it('rides the captureControl passthrough on an envelope', () => {
    const env = baseEnvelope();
    env.captureControl.render = render;
    const parsed = ReportEnvelope.parse(env);
    expect(readCaptureControlRender(parsed)).toEqual(render);
    expect(CaptureControlRender.safeParse(render).success).toBe(true);
  });

  it('reads null when absent or malformed', () => {
    expect(readCaptureControlRender(baseEnvelope())).toBeNull();
    const env = baseEnvelope();
    env.captureControl.render = { ...render, platform: 'roku' };
    expect(readCaptureControlRender(env)).toBeNull();
  });
});
