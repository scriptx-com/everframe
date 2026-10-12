// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transport/submit.js', () => ({ submitReportFromDraft: vi.fn(), drainOutbox: vi.fn() }));

import { submitReportFromDraft } from '../../src/transport/submit.js';
import { createCompanion } from '../../src/companion/state.js';
import {
  handleCompanionReportRequest,
  handleCompanionShotBinaryMarker,
  handleCompanionShotRequest,
  handleCompanionSubmitBinary,
  handleCompanionSubmitText,
  __resetCompanionSubmitFramingForTests,
} from '../../src/companion/capture-bridge.js';
import type { RelayWSClient, ReportSubmit } from '../../src/companion/ws-client.js';
import type { CompanionHost } from '../../src/companion/host-seam.js';
import type { ShotCapture } from '../../src/capture/shot-capture.js';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';

const submitMock = vi.mocked(submitReportFromDraft);
const SNAP1 = { bytes: new Uint8Array([1]), sha256: '1'.repeat(64), byteLength: 1 };
const SNAP2 = { bytes: new Uint8Array([2]), sha256: '2'.repeat(64), byteLength: 1 };
const RENDER = { platform: 'webos', viewport: { width: 1280, height: 720 }, dpr: 2, fontStatus: 'loaded' } as ShotCapture['render'];
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const IMAGE = { blob: new Blob([WEBP], { type: 'image/webp' }), width: 1920, height: 1080, sha256: 'a'.repeat(64) };
const CLEAN = { cropped: false, blurred: false, area_selected: false };
const BASE = {
  type: 'report.submit', correlation_id: 'c1', title: 't', description: { text: '', redactions: [] }, annotations: [],
  includes: { logs: true, network: true, uiTree: false, metadata: true, screenshot: true },
} as ReportSubmit;

const client = () => ({ send: vi.fn(), sendBinary: vi.fn(), start: vi.fn(), stop: vi.fn() }) as unknown as RelayWSClient & {
  send: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
};

function host(
  queue: ShotCapture[],
  opts: { active?: boolean; killed?: { v: boolean }; adapter?: Record<string, unknown> } = {},
): CompanionHost {
  const killed = opts.killed ?? { v: false };
  return {
    config: { sdkKey: 'k' } as CompanionHost['config'],
    sdkVersion: '0', getUser: () => null,
    isKilled: () => killed.v,
    adapter: {
      __captureShot: vi.fn(async () => queue.shift()!),
      __tvSnapshotPathActive: () => opts.active ?? true,
      captureScreenshot: vi.fn(), captureRecentLogs: () => [], captureRecentNetwork: () => [],
      getDeviceMetadata: () => null, captureFocusedNode: () => null,
      __captureIdentityAtSubmitBoundary: vi.fn(async () => null), __breadcrumbTrimOptions: () => ({}), outbox: undefined,
      ...opts.adapter,
    } as unknown as CompanionHost['adapter'],
  };
}

// Image decodes in jsdom never fire load/error, so each one waits out its
// 300 ms budget — a three-shot submit legitimately takes ~1 s.
async function submitted(): Promise<CaptureBundle> {
  await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  return submitMock.mock.calls[0]![0].bundle;
}

beforeEach(() => {
  submitMock.mockReset().mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
  __resetCompanionSubmitFramingForTests();
});

describe('companion submit — snapshot gating', () => {
  it('attaches the primary snapshot when the phone reports the primary unredacted', async () => {
    const ws = client();
    const h = host([{ image: IMAGE, snapshot: SNAP1, render: RENDER }]);
    await handleCompanionReportRequest('c1', ws, h);
    handleCompanionSubmitText({ ...BASE, primary_shot: { has_image: true, redaction: CLEAN } } as ReportSubmit, ws, h, createCompanion());
    handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
    const bundle = await submitted();
    expect(bundle.domSnapshots).toEqual([{ shotNumber: 1, bytes: SNAP1.bytes, sha256: SNAP1.sha256 }]);
    expect(bundle.render).toEqual(RENDER);
  });

  it.each([
    ['an old phone (no redaction state)', { primary_shot: { has_image: true } }],
    ['a cropped primary', { primary_shot: { has_image: true, redaction: { ...CLEAN, cropped: true } } }],
    ['a blurred primary', { primary_shot: { has_image: true, redaction: { ...CLEAN, blurred: true } } }],
    ['an area-selected primary', { primary_shot: { has_image: true, redaction: { ...CLEAN, area_selected: true } } }],
    ['a blur annotation despite a clean flag', { primary_shot: { has_image: true, redaction: CLEAN }, annotations: [{ kind: 'blur', rect: { x: 0, y: 0, w: 1, h: 1 } }] }],
  ])('drops the primary snapshot for %s', async (_label, extra) => {
    const ws = client();
    const h = host([{ image: IMAGE, snapshot: SNAP1, render: RENDER }]);
    await handleCompanionReportRequest('c1', ws, h);
    handleCompanionSubmitText({ ...BASE, ...extra } as ReportSubmit, ws, h, createCompanion());
    handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
    expect((await submitted()).domSnapshots).toBeUndefined();
  });

  it('snapshot-only primary: no image fields, snapshot kept, screenshot_render_failed', async () => {
    const ws = client();
    const h = host([{ snapshot: SNAP1, render: RENDER, degradedReason: 'screenshot_render_failed' }]);
    await handleCompanionReportRequest('c1', ws, h);
    handleCompanionSubmitText({ ...BASE, primary_shot: { has_image: false, redaction: CLEAN } } as ReportSubmit, ws, h, createCompanion());
    const bundle = await submitted();
    expect(bundle.screenshotBlob).toBeNull();
    expect(bundle.screenshots).toBeUndefined();
    expect(bundle.domSnapshots).toEqual([{ shotNumber: 1, bytes: SNAP1.bytes, sha256: SNAP1.sha256 }]);
    expect(bundle.degradedReason).toBe('screenshot_render_failed');
    await vi.waitFor(() => expect(ws.send).toHaveBeenLastCalledWith({ type: 'report.completed', correlation_id: 'c1', event_id: 'r1' }));
  });

  it('unavailable primary: screenshot_unavailable, nothing attached, screenshot not "excluded"', async () => {
    const ws = client();
    const h = host([{ degradedReason: 'screenshot_unavailable' }]);
    await handleCompanionReportRequest('c1', ws, h);
    handleCompanionSubmitText({ ...BASE, primary_shot: { has_image: false, redaction: CLEAN } } as ReportSubmit, ws, h, createCompanion());
    const bundle = await submitted();
    expect(bundle.domSnapshots).toBeUndefined();
    expect(bundle.degradedReason).toBe('screenshot_unavailable');
    expect(submitMock.mock.calls[0]![0].draft.excludedArtifacts).not.toContain('screenshot');
  });

  it('numbers extra shots 2..N and attaches an extra snapshot only when clean and never re-cropped', async () => {
    const ws = client();
    const h = host([
      { image: IMAGE, snapshot: SNAP1 },
      { image: IMAGE, snapshot: SNAP2, degradedReason: 'screenshot_blank' },
      { image: IMAGE, snapshot: SNAP2 },
    ]);
    await handleCompanionReportRequest('c1', ws, h);
    // crop stubbed: jsdom never decodes images, and the crop's bytes are irrelevant here
    await handleCompanionShotRequest(h, ws, { correlation_id: 'c1', shot_id: 's1' }, { crop: async (source) => source });
    await handleCompanionShotRequest(h, ws, { correlation_id: 'c1', shot_id: 's2', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { crop: async (source) => source });
    const msg = {
      ...BASE,
      primary_shot: { has_image: true, redaction: { ...CLEAN, cropped: true } },
      shots: [
        { shot_id: 's1', annotations: [], has_image: true, redaction: CLEAN },
        { shot_id: 's2', annotations: [], has_image: true, redaction: CLEAN },
      ],
    } as ReportSubmit;
    handleCompanionSubmitText(msg, ws, h, createCompanion());
    handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
    for (const id of ['s1', 's2']) {
      handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: id });
      handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
    }
    const bundle = await submitted();
    expect(bundle.screenshots?.map((s) => s.shotNumber)).toEqual([1, 2, 3]);
    expect(bundle.domSnapshots).toEqual([{ shotNumber: 2, bytes: SNAP2.bytes, sha256: SNAP2.sha256 }]);
    expect(bundle.degradedReason).toBe('screenshot_blank');
  });

  it('an image-less primary keeps the extras numbered from 2 (shot numbers are positions, not image indexes)', async () => {
    const ws = client();
    const h = host([
      { snapshot: SNAP1, degradedReason: 'screenshot_render_failed' },
      { image: IMAGE, snapshot: SNAP2 },
    ]);
    await handleCompanionReportRequest('c1', ws, h);
    await handleCompanionShotRequest(h, ws, { correlation_id: 'c1', shot_id: 's1' });
    handleCompanionSubmitText({
      ...BASE,
      primary_shot: { has_image: false, redaction: CLEAN },
      shots: [{ shot_id: 's1', annotations: [], has_image: true, redaction: CLEAN }],
    } as ReportSubmit, ws, h, createCompanion());
    handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: 's1' });
    handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
    const bundle = await submitted();
    expect(bundle.screenshots?.map((s) => s.shotNumber)).toEqual([2]);
    expect(bundle.domSnapshots?.map((s) => s.shotNumber)).toEqual([1, 2]);
    expect(bundle.degradedReason).toBe('screenshot_render_failed');
  });

  it('includes.screenshot:false maps to the screenshot exclusion and attaches no snapshot or shot reason (ruling S25d)', async () => {
    const ws = client();
    const h = host([{ snapshot: SNAP1, render: RENDER, degradedReason: 'screenshot_render_failed' }]);
    await handleCompanionReportRequest('c1', ws, h);
    handleCompanionSubmitText({
      ...BASE,
      includes: { ...BASE.includes, screenshot: false },
      primary_shot: { has_image: false, redaction: CLEAN },
    } as ReportSubmit, ws, h, createCompanion());
    const bundle = await submitted();
    expect(submitMock.mock.calls[0]![0].draft.excludedArtifacts).toContain('screenshot');
    expect(bundle.domSnapshots).toBeUndefined();
    expect(bundle.degradedReason).toBeUndefined();
  });
});

describe('report.request — exactly one completion on unexpected throws (ruling S25a)', () => {
  it('a throwing breadcrumb inventory → exactly one report.failed(screenshot_unavailable)', async () => {
    const ws = client();
    const crumbs = { discardAndResume: vi.fn(), freeze: vi.fn(), get size(): number { throw new Error('boom'); } };
    const h = host([{ image: IMAGE }], { adapter: { __getBreadcrumbBuffer: () => crumbs } });
    await handleCompanionReportRequest('c1', ws, h);
    expect(ws.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'screenshot_unavailable' }]]);
    expect(ws.sendBinary).not.toHaveBeenCalled();
  });

  it('a rejecting image read → exactly one report.failed(screenshot_unavailable)', async () => {
    const ws = client();
    const blob = new Blob([WEBP], { type: 'image/webp' });
    Object.defineProperty(blob, 'arrayBuffer', { value: () => Promise.reject(new Error('read failed')) });
    const h = host([{ image: { ...IMAGE, blob } }]);
    await handleCompanionReportRequest('c1', ws, h);
    expect(ws.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'screenshot_unavailable' }]]);
    expect(ws.sendBinary).not.toHaveBeenCalled();
  });

  it('a throw after the assembled frame went out sends nothing more', async () => {
    const ws = client();
    ws.sendBinary.mockImplementation(() => { throw new Error('socket gone'); });
    const h = host([{ image: IMAGE }]);
    await handleCompanionReportRequest('c1', ws, h);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls[0]![0]).toMatchObject({ type: 'report.assembled' });
  });

  it('kill() during the image read → report.failed(submit_unavailable), no pixels', async () => {
    const ws = client();
    const killed = { v: false };
    const blob = new Blob([WEBP], { type: 'image/webp' });
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => { killed.v = true; return WEBP.buffer; } });
    const h = host([{ image: { ...IMAGE, blob } }], { killed });
    await handleCompanionReportRequest('c1', ws, h);
    expect(ws.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'submit_unavailable' }]]);
    expect(ws.sendBinary).not.toHaveBeenCalled();
  });
});

describe('report.request resets submit framing (ruling S25b)', () => {
  it('a stray binary received before the request cannot pair with the next report', async () => {
    const ws = client();
    const h = host([{ image: IMAGE }]);
    handleCompanionSubmitBinary(new Uint8Array([9, 9]).buffer, ws, h, createCompanion()); // stray
    await handleCompanionReportRequest('c1', ws, h);
    handleCompanionSubmitText({ ...BASE, primary_shot: { has_image: true, redaction: CLEAN } } as ReportSubmit, ws, h, createCompanion());
    await new Promise((r) => setTimeout(r, 20));
    expect(submitMock).not.toHaveBeenCalled(); // still waiting for ITS primary binary
    handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
    const bundle = await submitted();
    expect(bundle.screenshotBlob?.size).toBe(WEBP.byteLength);
  });
});

describe('image-frame degraded_reason is gated on the TV snapshot path (ruling S25c)', () => {
  it('path on → the image frame echoes the shot reason', async () => {
    const ws = client();
    await handleCompanionReportRequest('c1', ws, host([{ image: IMAGE, degradedReason: 'screenshot_blank' }], { active: true }));
    expect(ws.send.mock.calls[0]![0]).toMatchObject({ type: 'report.assembled', degraded_reason: 'screenshot_blank' });
  });

  it('path off → the image frame is the legacy shape, no degraded_reason', async () => {
    const ws = client();
    await handleCompanionReportRequest('c1', ws, host([{ image: IMAGE, degradedReason: 'screenshot_blank' }], { active: false }));
    const frame = ws.send.mock.calls[0]![0];
    expect(frame).toMatchObject({ type: 'report.assembled', mime: 'image/webp' });
    expect(frame).not.toHaveProperty('degraded_reason');
    expect(ws.sendBinary).toHaveBeenCalledTimes(1);
  });
});

describe('lazy submit chunk', () => {
  it('a chunk that fails to load still answers the phone exactly once', async () => {
    vi.resetModules();
    vi.doMock('../../src/companion/companion-submit.js', () => {
      throw new Error('chunk load failed');
    });
    try {
      const bridge = await import('../../src/companion/capture-bridge.js');
      const ws = client();
      const h = host([{ image: IMAGE }]);
      await bridge.handleCompanionReportRequest('c1', ws, h);
      ws.send.mockClear();
      bridge.handleCompanionSubmitText({ ...BASE, primary_shot: { has_image: true, redaction: CLEAN } } as ReportSubmit, ws, h, createCompanion());
      bridge.handleCompanionSubmitBinary(WEBP.buffer, ws, h, createCompanion());
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(ws.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'ingest_error' }]]);
    } finally {
      vi.doUnmock('../../src/companion/companion-submit.js');
      vi.resetModules();
    }
  });
});
