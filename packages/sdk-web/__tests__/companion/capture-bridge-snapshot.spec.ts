// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transport/submit.js', () => ({ submitReportFromDraft: vi.fn(), drainOutbox: vi.fn() }));

import { relay } from '@everframe/protocol';
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
import { createShotStash, type StashedShotCapture } from '../../src/companion/shot-stash.js';

const submitMock = vi.mocked(submitReportFromDraft);
const SNAP = { bytes: new Uint8Array([0x1f, 0x8b, 1, 2]), sha256: 'f'.repeat(64), byteLength: 4 };
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const IMAGE = { blob: new Blob([WEBP], { type: 'image/webp' }), width: 1920, height: 1080, sha256: 'a'.repeat(64) };
const CLEAN = { cropped: false, blurred: false, area_selected: false };

function ws() {
  const send = vi.fn();
  const sendBinary = vi.fn();
  return { send, sendBinary, client: { send, sendBinary, start: vi.fn(), stop: vi.fn() } as unknown as RelayWSClient };
}

function host(capture: () => Promise<ShotCapture>, opts: { active?: boolean; killed?: { v: boolean } } = {}): CompanionHost {
  const killed = opts.killed ?? { v: false };
  return {
    config: { apiKey: 'k' } as CompanionHost['config'],
    sdkVersion: '0.0.0-test',
    getUser: () => null,
    isKilled: () => killed.v,
    adapter: {
      __captureShot: vi.fn(capture),
      __tvSnapshotPathActive: () => opts.active ?? true,
      captureScreenshot: vi.fn(),
      captureRecentLogs: () => [],
      captureRecentNetwork: () => [],
      getDeviceMetadata: () => null,
      captureFocusedNode: () => null,
      __captureIdentityAtSubmitBoundary: vi.fn(async () => null),
      __breadcrumbTrimOptions: () => ({}),
      outbox: undefined,
    } as unknown as CompanionHost['adapter'],
  };
}

const SUBMIT = {
  type: 'report.submit',
  correlation_id: 'c1',
  title: 'Rail stuck',
  description: { text: '', redactions: [] },
  annotations: [],
  includes: { logs: true, network: true, uiTree: false, metadata: true, screenshot: true },
} as ReportSubmit;

beforeEach(() => {
  submitMock.mockReset();
  __resetCompanionSubmitFramingForTests();
});

describe('report.request — exactly one completion', () => {
  it('snapshot-only capture → one image-less report.assembled (outcome snapshot), no binary', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => ({ snapshot: SNAP, degradedReason: 'screenshot_render_failed' })));
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.sendBinary).not.toHaveBeenCalled();
    const frame = t.send.mock.calls[0]![0];
    expect(frame).toMatchObject({ type: 'report.assembled', correlation_id: 'c1', outcome: 'snapshot', size: 0, degraded_reason: 'screenshot_render_failed', snapshot: { byte_length: 4, sha256: SNAP.sha256 } });
    expect(relay.ReportAssembled.safeParse(frame).success).toBe(true);
  });

  it('neither image nor snapshot → one unavailable report.assembled', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => ({ degradedReason: 'screenshot_unavailable' })));
    const frame = t.send.mock.calls[0]![0];
    expect(frame).toMatchObject({ outcome: 'unavailable', size: 0, degraded_reason: 'screenshot_unavailable' });
    expect(relay.ReportAssembled.safeParse(frame).success).toBe(true);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('server path off and the capture throws → exactly one report.failed(screenshot_unavailable) (Review Focus 4)', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => { throw new Error('x'); }, { active: false }));
    expect(t.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'screenshot_unavailable' }]]);
  });

  it('an image shot carries outcome image and its degraded reason on the image frame', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => ({ image: { ...IMAGE, degradedReason: 'screenshot_blank' }, degradedReason: 'screenshot_blank' })));
    const frame = t.send.mock.calls[0]![0];
    expect(frame).toMatchObject({ mime: 'image/webp', outcome: 'image', degraded_reason: 'screenshot_blank' });
    expect(relay.ReportAssembled.safeParse(frame).success).toBe(true);
    expect(t.sendBinary).toHaveBeenCalledTimes(1);
  });

  it('path active: a render-OK image + snapshot shot announces outcome image (the capability signal), no reason', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => ({ image: IMAGE, snapshot: SNAP })));
    const frame = t.send.mock.calls[0]![0];
    expect(frame).toMatchObject({ type: 'report.assembled', correlation_id: 'c1', outcome: 'image', size: WEBP.byteLength });
    expect(frame).not.toHaveProperty('degraded_reason');
    expect(frame).not.toHaveProperty('snapshot');
    expect(relay.ReportAssembled.safeParse(frame).success).toBe(true);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.sendBinary).toHaveBeenCalledTimes(1);
  });

  it('kill() during the server render → report.failed(submit_unavailable) and nothing else (Review Focus 5)', async () => {
    const t = ws();
    const killed = { v: false };
    await handleCompanionReportRequest('c1', t.client, host(async () => { killed.v = true; return { image: IMAGE, snapshot: SNAP }; }, { killed }));
    expect(t.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'submit_unavailable' }]]);
    expect(t.sendBinary).not.toHaveBeenCalled();
  });
});

describe('report.submit framing', () => {
  it('runs without waiting for a primary binary when primary_shot.has_image is false', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
    const t = ws();
    const h = host(async () => ({ snapshot: SNAP, degradedReason: 'screenshot_render_failed' }));
    await handleCompanionReportRequest('c1', t.client, h);
    handleCompanionSubmitText({ ...SUBMIT, primary_shot: { has_image: false, redaction: CLEAN } } as ReportSubmit, t.client, h, createCompanion());
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
  });

  it('still waits for the primary binary on a legacy submit', async () => {
    const t = ws();
    const h = host(async () => ({ image: IMAGE }));
    handleCompanionSubmitText(SUBMIT, t.client, h, createCompanion());
    await new Promise((r) => setTimeout(r, 0));
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('does not wait for (or bind a marker to) an extra shot announced has_image:false', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
    const t = ws();
    const h = host(async () => ({ image: IMAGE }));
    const msg = { ...SUBMIT, primary_shot: { has_image: true, redaction: CLEAN }, shots: [{ shot_id: 's1', annotations: [], has_image: false }] } as ReportSubmit;
    handleCompanionSubmitText(msg, t.client, h, createCompanion());
    handleCompanionShotBinaryMarker({ correlation_id: 'c1', shot_id: 's1' });
    handleCompanionSubmitBinary(WEBP.buffer, t.client, h, createCompanion());
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0]![0].bundle.screenshotBlob).toBeInstanceOf(Blob);
  });
});

describe('render-OK image + snapshot — request → submit round trip (final review finding 1)', () => {
  it('outcome image → new submit shape with clean redaction → the dom-snapshot part rides', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
    const t = ws();
    const h = host(async () => ({ image: IMAGE, snapshot: SNAP }));
    await handleCompanionReportRequest('c1', t.client, h);
    expect(t.send.mock.calls[0]![0]).toMatchObject({ outcome: 'image' });
    handleCompanionSubmitText({ ...SUBMIT, primary_shot: { has_image: true, redaction: CLEAN } } as ReportSubmit, t.client, h, createCompanion());
    handleCompanionSubmitBinary(WEBP.buffer, t.client, h, createCompanion());
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    const bundle = submitMock.mock.calls[0]![0].bundle;
    expect(bundle.screenshotBlob).toBeInstanceOf(Blob);
    expect(bundle.domSnapshots).toEqual([{ shotNumber: 1, bytes: SNAP.bytes, sha256: SNAP.sha256 }]);
  });

  it('a legacy submit for the same capture fails closed: no dom-snapshot part', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
    const t = ws();
    const h = host(async () => ({ image: IMAGE, snapshot: SNAP }));
    await handleCompanionReportRequest('c1', t.client, h);
    handleCompanionSubmitText(SUBMIT, t.client, h, createCompanion());
    handleCompanionSubmitBinary(WEBP.buffer, t.client, h, createCompanion());
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0]![0].bundle.domSnapshots).toBeUndefined();
  });
});

describe('shot.request on the snapshot path', () => {
  it('answers shot.failed with the degraded reason when the shot has no image', async () => {
    const t = ws();
    await handleCompanionShotRequest(host(async () => ({ snapshot: SNAP, degradedReason: 'screenshot_render_failed' })), t.client, { correlation_id: 'c1', shot_id: 's1' });
    expect(t.send.mock.calls[0]![0]).toMatchObject({ type: 'shot.failed', shot_id: 's1', reason: 'screenshot_render_failed' });
  });
});

describe('companion captures never consume the dialog pre-capture (ruling S23)', () => {
  it('report.request and shot.request both ask the adapter for a fresh shot (no consumePreCapture)', async () => {
    const t = ws();
    const h = host(async () => ({ image: IMAGE }));
    // A fresh correlation: the shot stash is per-correlation module state.
    await handleCompanionReportRequest('c-s23', t.client, h);
    await handleCompanionShotRequest(h, t.client, { correlation_id: 'c-s23', shot_id: 's1' });
    const calls = vi.mocked(h.adapter.__captureShot!).mock.calls;
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args).toEqual([]);
  });
});

describe('report.request — legacy compatibility', () => {
  it('path off: an image capture sends the pre-snapshot frame shape byte-for-byte (no outcome, no degraded_reason) + binary', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => ({ image: { ...IMAGE, degradedReason: 'screenshot_blank' }, degradedReason: 'screenshot_blank' }), { active: false }));
    const frame = t.send.mock.calls[0]![0];
    expect(Object.keys(frame).sort()).toEqual(['correlation_id', 'counts', 'mime', 'size', 'toggles', 'type']);
    expect(frame).toMatchObject({ type: 'report.assembled', mime: 'image/webp', size: WEBP.byteLength });
    expect(relay.ReportAssembled.safeParse(frame).success).toBe(true);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.sendBinary).toHaveBeenCalledTimes(1);
  });

  it('server path off and a snapshot-only result (gate flipped mid-capture) → report.failed, never an image-less frame', async () => {
    const t = ws();
    await handleCompanionReportRequest('c1', t.client, host(async () => ({ snapshot: SNAP, degradedReason: 'screenshot_render_failed' }), { active: false }));
    expect(t.send.mock.calls).toEqual([[{ type: 'report.failed', correlation_id: 'c1', reason: 'screenshot_unavailable' }]]);
  });

  it('a legacy submit (no primary_shot) runs once its primary binary arrives', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
    const t = ws();
    const h = host(async () => ({ image: IMAGE }));
    handleCompanionSubmitText(SUBMIT, t.client, h, createCompanion());
    handleCompanionSubmitBinary(WEBP.buffer, t.client, h, createCompanion());
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0]![0].bundle.screenshotBlob).toBeInstanceOf(Blob);
  });

  it('an image-less primary submits with no primary screenshot', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });
    const t = ws();
    const h = host(async () => ({ degradedReason: 'screenshot_unavailable' }));
    handleCompanionSubmitText({ ...SUBMIT, primary_shot: { has_image: false } } as ReportSubmit, t.client, h, createCompanion());
    await vi.waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    const bundle = submitMock.mock.calls[0]![0].bundle;
    expect(bundle.screenshotBlob).toBeNull();
    expect(bundle.screenshotSha256).toBeNull();
  });
});

describe('shot stash — snapshot info and re-crop tracking', () => {
  const source: StashedShotCapture = {
    bytes: new ArrayBuffer(4),
    mime: 'image/webp',
    width: 100,
    height: 50,
    snapshot: SNAP,
    degradedReason: 'screenshot_blank',
  };

  it('exposes the stashed snapshot + reason, and marks a shot recropped once a rect is applied', async () => {
    const stash = createShotStash({
      correlationId: 'c1',
      capture: async () => source,
      crop: async (s) => s,
      send: vi.fn(),
      sendBinary: vi.fn(),
    });
    expect(stash.info('s1')).toBeUndefined();
    await stash.handle({ shotId: 's1' });
    expect(stash.info('s1')).toEqual({ snapshot: SNAP, degradedReason: 'screenshot_blank', recropped: false });
    await stash.handle({ shotId: 's1', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    expect(stash.info('s1')?.recropped).toBe(true);
    stash.clear();
    expect(stash.info('s1')).toBeUndefined();
  });

  it('a capture without a snapshot reports only the recropped flag', async () => {
    const stash = createShotStash({
      correlationId: 'c1',
      capture: async () => ({ bytes: new ArrayBuffer(4), mime: 'image/png', width: 10, height: 10 }),
      crop: async (s) => s,
      send: vi.fn(),
      sendBinary: vi.fn(),
    });
    await stash.handle({ shotId: 's1', rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(stash.info('s1')).toEqual({ recropped: true });
  });
});
