// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayCapture } from '@everframe/sdk-core';
import {
  CAPTURE_COOLDOWN_MS,
  createQuickCapture,
  type QuickCapture,
} from '../../src/quickcapture/pipeline.js';
import type { QuickCaptureHost } from '../../src/quickcapture/host.js';
import type { DeviceLinkController, LinkSnapshot } from '../../src/quickcapture/device-link.js';
import type { SubmitOutcome } from '../../src/transport/submit.js';
import type { ShotCapture } from '../../src/capture/shot-capture.js';
import type { WebPlatformAdapter } from '../../src/adapter.js';

const TOKEN = 'evf_dev_' + 'A'.repeat(32);
const TOKEN_B = 'evf_dev_' + 'B'.repeat(32);
const FP = '0123456789abcdef';
const ID = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let order: string[];
let lifecycleState: string;
let lifecycle: {
  readonly state: string;
  freeze: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};
let crumbs: {
  freeze: ReturnType<typeof vi.fn>;
  takeFrozen: ReturnType<typeof vi.fn>;
  discardAndResume: ReturnType<typeof vi.fn>;
};
let bodies: typeof crumbs;
let adapter: Record<string, unknown>;
let shot: ReturnType<typeof vi.fn<() => Promise<ShotCapture>>>;
let submit: ReturnType<typeof vi.fn<(o: Record<string, unknown>) => Promise<SubmitOutcome>>>;
let snapshot: LinkSnapshot | null;
let link: DeviceLinkController & { forget: ReturnType<typeof vi.fn> };
let overlay: {
  showBanner: ReturnType<typeof vi.fn<(n: number) => void>>;
  hideBanner: ReturnType<typeof vi.fn<() => void>>;
  toast: ReturnType<typeof vi.fn<(t: string) => void>>;
  destroy: ReturnType<typeof vi.fn<() => void>>;
};
let killed: boolean;
let current: boolean;
let clock: number;
let debugBuild: boolean;
let beginAttempt: ReturnType<typeof vi.fn<(id: string, n: number, nonce: string) => void>>;
let qc: QuickCapture;

const REPLAY: ReplayCapture = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: 'application/gzip',
  format: 'rrweb',
  durationMs: 1000,
} as unknown as ReplayCapture;

function ok(over: Partial<SubmitOutcome> = {}): SubmitOutcome {
  return { ok: true, retryable: false, reportId: 'r-1', status: 200, threadId: null, ...over };
}

function build(): QuickCapture {
  const host: QuickCaptureHost = {
    config: { sdkKey: 'k', appName: 'tv', appVersion: '1' },
    adapter: adapter as unknown as WebPlatformAdapter,
    sdkName: 'everframe-web',
    sdkVersion: '1.5.0',
    getUser: () => ({ id: 'u-1' }) as never,
    getExtra: () => 'extra-1',
    isKilled: () => killed,
  };
  return createQuickCapture({
    host,
    link,
    overlay,
    deviceModel: () => 'Samsung TV',
    debugBuild,
    isCurrent: () => current,
    now: () => clock,
    beginAttempt,
    submit: submit as never,
    captureShot: shot as never,
    nonce: () => 'n'.repeat(40),
  });
}

beforeEach(() => {
  order = [];
  lifecycleState = 'BUFFERING';
  lifecycle = {
    get state() {
      return lifecycleState;
    },
    freeze: vi.fn(() => {
      order.push('freeze');
      lifecycleState = 'FROZEN';
    }),
    complete: vi.fn(async () => {
      lifecycleState = 'BUFFERING';
      return REPLAY;
    }),
    cancel: vi.fn(() => {
      lifecycleState = 'BUFFERING';
    }),
  };
  const buffer = () => ({
    freeze: vi.fn(),
    takeFrozen: vi.fn(() => [{ kind: 'nav', message: 'x' }]),
    discardAndResume: vi.fn(),
  });
  crumbs = buffer();
  bodies = buffer();
  shot = vi.fn(async () => {
    order.push('shot');
    return {
      image: {
        blob: new Blob([new Uint8Array([9])], { type: 'image/png' }),
        width: 1920,
        height: 1080,
        sha256: 'b'.repeat(64),
      },
    };
  });
  adapter = {
    __replayLifecycle: lifecycle,
    __getBreadcrumbBuffer: () => crumbs,
    __getNetworkBodiesBuffer: () => bodies,
    __breadcrumbTrimOptions: () => ({ byteBudget: 1, consoleEntryCap: 1 }),
    captureRecentLogs: () => [{ level: 'info', message: 'log', ts: 1 }],
    captureRecentNetwork: () => [],
    getDeviceMetadata: () => ({
      os: 'Tizen',
      osVersion: '6.5',
      screenSize: { width: 1920, height: 1080 },
      pixelRatio: 1,
      locale: 'en',
      timezone: 'UTC',
    }),
    captureFocusedNode: () => null,
    __captureIdentityAtSubmitBoundary: async () => 'id-token',
    __identityTokenReader: { get: async () => null },
    outbox: { enqueue: vi.fn(), list: vi.fn(), delete: vi.fn() },
  };
  submit = vi.fn(async () => {
    order.push('submit');
    return ok();
  });
  snapshot = { token: TOKEN, owner: { kind: 'user', name: 'Aurimas' }, fingerprint: FP };
  link = {
    get owner() {
      return snapshot?.owner ?? null;
    },
    linkingEnabled: true,
    snapshot: () => snapshot,
    applyConfig: () => null,
    sendHello: () => undefined,
    beginAttempt: () => undefined,
    forget: vi.fn(() => true),
    teardown: () => undefined,
  } as unknown as DeviceLinkController & { forget: ReturnType<typeof vi.fn> };
  overlay = {
    showBanner: vi.fn<(n: number) => void>(),
    hideBanner: vi.fn<() => void>(),
    toast: vi.fn((t: string) => {
      order.push('toast');
      void t;
    }),
    destroy: vi.fn<() => void>(),
  };
  killed = false;
  current = true;
  clock = 10_000;
  debugBuild = false;
  beginAttempt = vi.fn();
  qc = build();
});
afterEach(() => vi.restoreAllMocks());

describe('quick-capture pipeline', () => {
  it('a linked capture freezes evidence, toasts the owner, then uploads with the token', async () => {
    expect(await qc.capture()).toBe('submitted');
    expect(order).toEqual(['freeze', 'shot', 'toast', 'submit']);
    expect(overlay.toast).toHaveBeenCalledWith('Captured · Aurimas');
    expect(overlay.toast).toHaveBeenCalledTimes(1);
    const opts = submit.mock.calls[0]![0];
    expect(opts).toMatchObject({
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: 'n'.repeat(40) },
      capturedIdentityToken: 'id-token',
      user: { id: 'u-1' },
      sdkName: 'everframe-web',
      sdkVersion: '1.5.0',
    });
    expect(opts['draft']).toEqual({
      title: '',
      description: '',
      excludedArtifacts: [],
      annotations: [],
      redactions: [],
      extra: 'extra-1',
    });
    expect(crumbs.freeze).toHaveBeenCalledTimes(1);
    expect(bodies.freeze).toHaveBeenCalledTimes(1);
    expect(crumbs.takeFrozen).toHaveBeenCalledTimes(1);
    expect(bodies.takeFrozen).toHaveBeenCalledTimes(1);
    expect(qc.inFlight).toBe(false);
  });

  it('a team device toasts Captured · team device', async () => {
    snapshot = { token: TOKEN, owner: { kind: 'team' }, fingerprint: FP };
    expect(await qc.capture()).toBe('submitted');
    expect(overlay.toast).toHaveBeenCalledWith('Captured · team device');
  });

  it('an unlinked debug capture toasts the device model and uploads shared', async () => {
    snapshot = null;
    debugBuild = true;
    qc = build();
    expect(await qc.capture()).toBe('submitted');
    expect(overlay.toast).toHaveBeenCalledWith('Captured · Samsung TV');
    expect(submit.mock.calls[0]![0]['deviceLink']).toBeUndefined();
    expect(submit.mock.calls[0]![0]['quickCapture']).toBe(true);
  });

  it('an unlinked release device never captures', async () => {
    snapshot = null;
    expect(await qc.capture()).toBe('ignored');
    expect(lifecycle.freeze).not.toHaveBeenCalled();
    expect(shot).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(overlay.toast).not.toHaveBeenCalled();
  });

  it("a gesture while the reporter holds the freeze is ignored and leaves the reporter's replay intact", async () => {
    lifecycleState = 'FROZEN';
    expect(await qc.capture()).toBe('ignored');
    expect(lifecycle.freeze).not.toHaveBeenCalled();
    expect(lifecycle.cancel).not.toHaveBeenCalled();
    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(crumbs.freeze).not.toHaveBeenCalled();
    expect(crumbs.discardAndResume).not.toHaveBeenCalled();
    expect(crumbs.takeFrozen).not.toHaveBeenCalled();
    expect(bodies.discardAndResume).not.toHaveBeenCalled();
    expect(overlay.toast).not.toHaveBeenCalled();
  });

  it('a gesture while the reporter is open without a replay buffer is ignored too', async () => {
    lifecycleState = 'IDLE';
    adapter['__isReporterOpen'] = () => true;
    expect(await qc.capture()).toBe('ignored');
    expect(crumbs.freeze).not.toHaveBeenCalled();
  });

  it('one capture at a time, and a second within 2 s is ignored', async () => {
    const d = deferred<ShotCapture>();
    shot.mockReturnValueOnce(d.promise);
    const first = qc.capture();
    expect(qc.inFlight).toBe(true);
    expect(await qc.capture()).toBe('ignored');
    d.resolve({});
    expect(await first).toBe('submitted');
    clock += CAPTURE_COOLDOWN_MS - 1;
    expect(await qc.capture()).toBe('ignored');
    clock += 1;
    expect(await qc.capture()).toBe('submitted');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('kill() between freeze and upload sends nothing and resumes live capture', async () => {
    const d = deferred<ShotCapture>();
    shot.mockReturnValueOnce(d.promise);
    const p = qc.capture();
    killed = true;
    d.resolve({});
    expect(await p).toBe('failed');
    expect(submit).not.toHaveBeenCalled();
    expect(lifecycle.cancel).toHaveBeenCalledTimes(1);
    expect(crumbs.discardAndResume).toHaveBeenCalledTimes(1);
    expect(bodies.discardAndResume).toHaveBeenCalledTimes(1);
    expect(overlay.toast).not.toHaveBeenCalled();
  });

  it('a teardown during the shot sends nothing and resumes live capture', async () => {
    const d = deferred<ShotCapture>();
    shot.mockReturnValueOnce(d.promise);
    const p = qc.capture();
    current = false;
    d.resolve({});
    expect(await p).toBe('failed');
    expect(submit).not.toHaveBeenCalled();
    expect(lifecycle.cancel).toHaveBeenCalledTimes(1);
  });

  it('a link that changed during the capture is never sent under another identity', async () => {
    shot.mockImplementationOnce(async () => {
      snapshot = { token: TOKEN_B, owner: { kind: 'team' }, fingerprint: 'f' };
      return {};
    });
    expect(await qc.capture()).toBe('rejected');
    expect(submit).not.toHaveBeenCalled();
    expect(overlay.toast).toHaveBeenLastCalledWith("Capture didn't upload");
  });

  it('a link forgotten during an unlinked-debug-eligible capture never falls back to shared', async () => {
    debugBuild = true;
    qc = build();
    shot.mockImplementationOnce(async () => {
      snapshot = null;
      return {};
    });
    expect(await qc.capture()).toBe('rejected');
    expect(submit).not.toHaveBeenCalled();
  });

  it('device_unlinked forgets the token and toasts This device was unlinked', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      retryable: false,
      reportId: 'r',
      threadId: null,
      status: 403,
      deviceUnlinked: true,
    });
    expect(await qc.capture()).toBe('unlinked');
    expect(link.forget).toHaveBeenCalledWith(TOKEN);
    // The controller's forget() shows "This device was unlinked" itself.
    expect(overlay.toast).toHaveBeenCalledTimes(1);
  });

  it('device_unlinked for a token a takeover already replaced reads as rejected', async () => {
    link.forget.mockReturnValueOnce(false);
    submit.mockResolvedValueOnce({
      ok: false,
      retryable: false,
      reportId: 'r',
      threadId: null,
      deviceUnlinked: true,
    });
    expect(await qc.capture()).toBe('rejected');
    expect(overlay.toast).toHaveBeenLastCalledWith("Capture didn't upload");
  });

  it('a takeover linkPending starts an attempt with the upload nonce', async () => {
    submit.mockResolvedValueOnce(ok({ linkPending: { attemptId: ID, number: 47 } }));
    expect(await qc.capture()).toBe('submitted');
    expect(beginAttempt).toHaveBeenCalledWith(ID, 47, 'n'.repeat(40));
  });

  it('a takeover that lands after teardown is dropped', async () => {
    submit.mockImplementationOnce(async () => {
      current = false;
      return ok({ linkPending: { attemptId: ID, number: 47 } });
    });
    await qc.capture();
    expect(beginAttempt).not.toHaveBeenCalled();
  });

  it('a queued capture shows no second toast', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      retryable: true,
      reportId: 'r',
      threadId: null,
      status: 503,
    });
    expect(await qc.capture()).toBe('queued');
    expect(overlay.toast).toHaveBeenCalledTimes(1);
  });

  it('a transient failure that could not be queued reads as rejected', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      retryable: true,
      reportId: 'r',
      threadId: null,
      notQueued: true,
    });
    expect(await qc.capture()).toBe('rejected');
    expect(overlay.toast).toHaveBeenLastCalledWith("Capture didn't upload");
  });

  it('any other failure toasts Capture didn’t upload', async () => {
    submit.mockResolvedValueOnce({ ok: false, retryable: false, reportId: 'r', threadId: null });
    expect(await qc.capture()).toBe('rejected');
    expect(overlay.toast).toHaveBeenLastCalledWith("Capture didn't upload");
  });

  it('a throw before the toast unwinds and toasts Capture failed', async () => {
    adapter['captureRecentLogs'] = () => {
      throw new Error('boom');
    };
    adapter['getDeviceMetadata'] = () => {
      throw new Error('boom');
    };
    // Logs and metadata are best effort; a throw from the clock is not.
    let calls = 0;
    qc = createQuickCapture({
      host: {
        config: { sdkKey: 'k' },
        adapter: adapter as unknown as WebPlatformAdapter,
        sdkName: 'everframe-web',
        sdkVersion: '1',
        getUser: () => null,
        getExtra: () => undefined,
        isKilled: () => false,
      },
      link,
      overlay,
      deviceModel: () => {
        throw new Error('model');
      },
      debugBuild: false,
      isCurrent: () => true,
      now: () => {
        calls += 1;
        return clock;
      },
      beginAttempt,
      submit: submit as never,
      captureShot: shot as never,
      nonce: () => 'n'.repeat(40),
    });
    expect(await qc.capture()).toBe('failed');
    expect(calls).toBeGreaterThan(0);
    expect(lifecycle.cancel).toHaveBeenCalledTimes(1);
    expect(crumbs.discardAndResume).toHaveBeenCalledTimes(1);
    expect(overlay.toast).toHaveBeenLastCalledWith('Capture failed');
    expect(submit).not.toHaveBeenCalled();
  });

  it('the replay window travels with the capture', async () => {
    await qc.capture();
    const bundle = submit.mock.calls[0]![0]['bundle'] as Record<string, unknown>;
    expect(bundle['replayCapture']).toBe(REPLAY);
    expect(bundle['replaySha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle['breadcrumbs']).toEqual([{ kind: 'nav', message: 'x' }]);
    expect(bundle['networkBodies']).toEqual([{ kind: 'nav', message: 'x' }]);
    expect(bundle['screenshotWidth']).toBe(1920);
    expect(bundle['logs']).toEqual([{ level: 'info', message: 'log', ts: 1 }]);
    expect(lifecycle.complete).toHaveBeenCalledTimes(1);
  });

  it('a TV snapshot shot ships its DOM snapshot and render context', async () => {
    shot.mockResolvedValueOnce({
      snapshot: { bytes: new Uint8Array([1]), sha256: 'c'.repeat(64), byteLength: 1 },
      render: { path: 'snapshot' } as never,
      degradedReason: 'screenshot_render_failed',
    });
    await qc.capture();
    const bundle = submit.mock.calls[0]![0]['bundle'] as Record<string, unknown>;
    expect(bundle['screenshotBlob']).toBeNull();
    expect(bundle['domSnapshots']).toEqual([
      { shotNumber: 1, bytes: new Uint8Array([1]), sha256: 'c'.repeat(64) },
    ]);
    expect(bundle['render']).toEqual({ path: 'snapshot' });
    expect(bundle['degradedReason']).toBe('screenshot_render_failed');
  });

  it('a failed shot still files the capture, flagged screenshot_failed', async () => {
    shot.mockRejectedValueOnce(new Error('no pixels'));
    expect(await qc.capture()).toBe('submitted');
    const bundle = submit.mock.calls[0]![0]['bundle'] as Record<string, unknown>;
    expect(bundle['degradedReason']).toBe('screenshot_failed');
  });

  it('a killed host never starts a capture', async () => {
    killed = true;
    expect(await qc.capture()).toBe('ignored');
    expect(lifecycle.freeze).not.toHaveBeenCalled();
  });

  it('a kill() during the upload is carried into the transport and ends silently', async () => {
    submit.mockImplementationOnce(async (o) => {
      const owned = o['isOwned'] as () => boolean;
      expect(owned()).toBe(true);
      killed = true;
      expect(owned()).toBe(false);
      return { ok: false, retryable: false, reportId: 'r', threadId: null, abandoned: true };
    });
    expect(await qc.capture()).toBe('failed');
    expect(overlay.toast).toHaveBeenCalledTimes(1); // only the optimistic toast
  });

  it('a teardown during the upload is carried into the transport too', async () => {
    submit.mockImplementationOnce(async (o) => {
      current = false;
      expect((o['isOwned'] as () => boolean)()).toBe(false);
      return { ok: false, retryable: false, reportId: 'r', threadId: null, abandoned: true };
    });
    expect(await qc.capture()).toBe('failed');
  });

  it('a failed replay export unwinds the freeze and still files the capture', async () => {
    lifecycle.complete.mockImplementationOnce(async () => {
      throw new Error('gzip failed');
    });
    expect(await qc.capture()).toBe('submitted');
    expect(lifecycle.cancel).toHaveBeenCalledTimes(1);
    expect(lifecycleState).toBe('BUFFERING');
    const bundle = submit.mock.calls[0]![0]['bundle'] as Record<string, unknown>;
    expect(bundle['replayCapture']).toBeUndefined();
    // A later gesture is not shut out by a stuck freeze.
    clock += CAPTURE_COOLDOWN_MS;
    expect(await qc.capture()).toBe('submitted');
  });

  it('a takeover reply is dropped when another takeover replaced the link during the upload', async () => {
    submit.mockImplementationOnce(async () => {
      snapshot = { token: TOKEN_B, owner: { kind: 'team' }, fingerprint: 'f' };
      return ok({ linkPending: { attemptId: ID, number: 47 } });
    });
    expect(await qc.capture()).toBe('submitted');
    expect(beginAttempt).not.toHaveBeenCalled();
  });

  it('a takeover reply is dropped when the link was forgotten during the upload', async () => {
    submit.mockImplementationOnce(async () => {
      snapshot = null;
      return ok({ linkPending: { attemptId: ID, number: 47 } });
    });
    await qc.capture();
    expect(beginAttempt).not.toHaveBeenCalled();
  });

  it('a reporter opened while the capture awaits its shot takes over the freeze; the capture consumes nothing', async () => {
    let seq = 0;
    adapter['__reporterOpenSeq'] = () => seq;
    const d = deferred<ShotCapture>();
    shot.mockReturnValueOnce(d.promise);
    const p = qc.capture();
    // open() arrives: its freeze() reuses the capture's frozen buffers.
    seq += 1;
    d.resolve({});
    expect(await p).toBe('ignored');
    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(lifecycle.cancel).not.toHaveBeenCalled();
    expect(crumbs.takeFrozen).not.toHaveBeenCalled();
    expect(crumbs.discardAndResume).not.toHaveBeenCalled();
    expect(bodies.takeFrozen).not.toHaveBeenCalled();
    expect(bodies.discardAndResume).not.toHaveBeenCalled();
    expect(lifecycleState).toBe('FROZEN'); // still held, now for the reporter
    expect(overlay.toast).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('breadcrumbs and bodies are taken before the replay export, so a reporter opening during it freezes its own', async () => {
    let seq = 0;
    adapter['__reporterOpenSeq'] = () => seq;
    const exported = deferred<ReplayCapture | null>();
    lifecycle.complete.mockImplementationOnce(() => {
      expect(crumbs.takeFrozen).toHaveBeenCalledTimes(1);
      expect(bodies.takeFrozen).toHaveBeenCalledTimes(1);
      return exported.promise.then((c) => {
        lifecycleState = 'BUFFERING';
        return c;
      });
    });
    let reporterOpen = false;
    adapter['__isReporterOpen'] = () => reporterOpen;
    const p = qc.capture();
    await vi.waitFor(() => expect(lifecycle.complete).toHaveBeenCalledTimes(1));
    seq += 1; // the reporter opens mid-export and freezes its own evidence
    reporterOpen = true;
    exported.resolve(REPLAY);
    expect(await p).toBe('submitted');
    // The resumed buffer is frozen again for the reporter that opened meanwhile.
    expect(lifecycle.freeze).toHaveBeenCalledTimes(2);
    expect(lifecycleState).toBe('FROZEN');
  });

  it('a reporter opened and cancelled during the replay export leaves no orphaned freeze', async () => {
    let seq = 0;
    let reporterOpen = false;
    adapter['__reporterOpenSeq'] = () => seq;
    adapter['__isReporterOpen'] = () => reporterOpen;
    const exported = deferred<ReplayCapture | null>();
    lifecycle.complete.mockImplementationOnce(() =>
      exported.promise.then((c) => {
        lifecycleState = 'BUFFERING';
        return c;
      }),
    );
    const p = qc.capture();
    await vi.waitFor(() => expect(lifecycle.complete).toHaveBeenCalledTimes(1));
    seq += 1; // the reporter opens...
    reporterOpen = true;
    reporterOpen = false; // ...and is cancelled before the export finishes
    exported.resolve(REPLAY);
    expect(await p).toBe('submitted');
    expect(lifecycle.freeze).toHaveBeenCalledTimes(1); // only the capture's own
    expect(lifecycleState).toBe('BUFFERING');
    // A later gesture is not blocked by a stray freeze.
    clock += CAPTURE_COOLDOWN_MS;
    expect(await qc.capture()).toBe('submitted');
  });
});
