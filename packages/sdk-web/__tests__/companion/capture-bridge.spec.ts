// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 Task 1 — capture-bridge.ts unit specs. Mocks
// `captureScreenshot` to assert composition without actually rendering the
// DOM (jsdom can't run modern-screenshot end-to-end).
import { describe, expect, it, vi } from 'vitest';

// Mock the screenshot module BEFORE importing the bridge.
const fakePngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakeBlob = new Blob([fakePngBytes as BlobPart], { type: 'image/png' });

vi.mock('../../src/capture/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({
    blob: fakeBlob,
    width: 1280,
    height: 720,
    sha256: 'deadbeef',
  })),
}));

// Spec 2026-08-29 (Task 5) — mocked ONLY so the tap-to-identify test below can
// inspect the `bundle` the bridge hands to the standard ingest submit path,
// exactly as the sibling capture-bridge-submit.spec.ts does. Every
// pre-existing test in this file never reaches the submit phase, so this mock
// is inert for them.
vi.mock('../../src/transport/submit.js', () => ({
  submitReportFromDraft: vi.fn(),
  drainOutbox: vi.fn(),
}));

import { captureScreenshot } from '../../src/capture/screenshot.js';
import { submitReportFromDraft } from '../../src/transport/submit.js';
import { draftToEnvelope } from '../../src/transport/draft-to-envelope.js';
import { createCompanion } from '../../src/companion/state.js';
import {
  handleReportRequest,
  handleReportSubmit,
  handleCompanionReportRequest,
  handleCompanionReportCancelled,
  handleCompanionSubmitText,
  handleCompanionSubmitBinary,
} from '../../src/companion/capture-bridge.js';
import type { RelayWSClient, ReportSubmit } from '../../src/companion/ws-client.js';
import type { CompanionHost } from '../../src/companion/host-seam.js';
import type { UITree } from '@everframe/protocol';

const submitMock = vi.mocked(submitReportFromDraft);

function fakeWs(): RelayWSClient & {
  send: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    sendBinary: vi.fn(),
  } as unknown as RelayWSClient & {
    send: ReturnType<typeof vi.fn>;
    sendBinary: ReturnType<typeof vi.fn>;
  };
}

const fakeBreadcrumbs = {
  freeze: vi.fn(),
  takeFrozen: vi.fn(() => [{ kind: 'custom', message: 'before', ts: 1 }]),
  discardAndResume: vi.fn(),
  size: 1,
};
const fakeLifecycle = {
  freeze: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(async () => ({
    format: 'rrweb',
    bytes: new Uint8Array([1, 2, 3]),
    durationMs: 10,
    contentType: 'application/octet-stream',
  })),
};

function fakeHost(): CompanionHost {
  return {
    config: { apiKey: 'k' } as CompanionHost['config'],
    sdkVersion: '0.0.0-test',
    // Task 15 (2026-08-12) — this file never exercises identity, so a fixed
    // "nobody signed in" getter matches its pre-existing behavior.
    getUser: () => null,
    adapter: {
      captureScreenshot: vi.fn(async () => ({
        blob: fakeBlob,
        width: 1280,
        height: 720,
        sha256: 'deadbeef',
      })),
      captureRecentLogs: vi.fn(() => []),
      captureRecentNetwork: vi.fn(() => []),
      getDeviceMetadata: vi.fn(() => null),
      captureFocusedNode: vi.fn(() => null),
      __getBreadcrumbBuffer: () => fakeBreadcrumbs,
      __replayLifecycle: fakeLifecycle,
      __breadcrumbTrimOptions: () => ({ byteBudget: 100_000, consoleEntryCap: 50 }),
    } as unknown as CompanionHost['adapter'],
  };
}

describe('companion/capture-bridge', () => {
  it('handleReportRequest sends report.assembled then binary PNG', async () => {
    const ws = fakeWs();

    await handleReportRequest('corr-42', ws, {
      logs: 12,
      network: 3,
      uiTreeNodes: 88,
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.sendBinary).toHaveBeenCalledTimes(1);

    const sentMsg = ws.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sentMsg.type).toBe('report.assembled');
    expect(sentMsg.correlation_id).toBe('corr-42');
    expect(sentMsg.mime).toBe('image/png');
    expect(sentMsg.size).toBe(fakePngBytes.byteLength);
    expect(sentMsg.counts).toEqual({ logs: 12, network: 3, uiTreeNodes: 88 });
    // `uiTree` is FALSE on every producer now (both natives already send
    // false). Announcing `true` for an artifact that no longer exists makes
    // the phone echo it back in `includes`, which downstream reads as a
    // deliberate user choice.
    expect(sentMsg.toggles).toEqual({
      logs: true,
      network: true,
      uiTree: false,
      metadata: true,
      screenshot: true,
    });

    const binaryArg = ws.sendBinary.mock.calls[0]![0] as ArrayBuffer;
    expect(binaryArg).toBeInstanceOf(ArrayBuffer);
    expect(binaryArg.byteLength).toBe(fakePngBytes.byteLength);
  });

  it('ships an already-WebP capture as-is (correct mime, no re-encode)', async () => {
    // The TV capture profile encodes WebP at the source (screenshot.ts) — the
    // relay hop must pass those bytes through instead of relabelling them
    // image/png (the pre-fix fallback) or decoding + re-encoding them.
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50,
    ]);
    vi.mocked(captureScreenshot).mockResolvedValueOnce({
      blob: new Blob([webpBytes as BlobPart], { type: 'image/webp' }),
      width: 1280,
      height: 720,
      sha256: 'cafe',
    });
    const ws = fakeWs();

    await handleReportRequest('corr-webp', ws, { logs: 0, network: 0, uiTreeNodes: 0 });

    const sentMsg = ws.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sentMsg.mime).toBe('image/webp');
    expect(sentMsg.size).toBe(webpBytes.byteLength);
    const binaryArg = ws.sendBinary.mock.calls[0]![0] as ArrayBuffer;
    expect(new Uint8Array(binaryArg)).toEqual(webpBytes);
  });

  it('text frame precedes binary frame (D-05 ordering)', async () => {
    const ws = fakeWs();
    const order: string[] = [];
    ws.send.mockImplementation(() => order.push('text'));
    ws.sendBinary.mockImplementation(() => order.push('binary'));

    await handleReportRequest('c-1', ws, { logs: 0, network: 0, uiTreeNodes: 0 });

    expect(order).toEqual(['text', 'binary']);
  });

  it('handleReportSubmit returns resolved Promise (passive observer slot)', async () => {
    await expect(
      handleReportSubmit({
        type: 'report.submit',
        correlation_id: 'c-1',
        title: 't',
        description: { text: 'd', redactions: [] },
        annotations: [],
        includes: {
          logs: true,
          network: true,
          uiTree: true,
          metadata: true,
          screenshot: true,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('freezes breadcrumbs and replay at report.request (discard-then-freeze)', async () => {
    const ws = fakeWs();
    const host = fakeHost();

    await handleCompanionReportRequest('corr-1', ws, host);

    expect(fakeBreadcrumbs.discardAndResume).toHaveBeenCalled();
    expect(fakeBreadcrumbs.freeze).toHaveBeenCalled();
    expect(fakeLifecycle.cancel).toHaveBeenCalled();
    expect(fakeLifecycle.freeze).toHaveBeenCalled();
  });

  it('report.cancelled discards the frozen state', () => {
    const host = fakeHost();
    handleCompanionReportCancelled(host);
    expect(fakeBreadcrumbs.discardAndResume).toHaveBeenCalled();
    expect(fakeLifecycle.cancel).toHaveBeenCalled();
  });
});
