// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Codex round-1 findings 1 and 2 (P1, kill switch). `client.kill()` is the
// public consent / GDPR switch: the host calls it and nothing more may be
// captured or sent. It reaches this adapter through `onKill()`, which flips
// the `killed` flag eight other paths already consult (bodyCapture.enabled,
// the periodic config refresh, applyLiveConfig, the 'online' drain listener…).
// Two paths did not consult it, in BOTH `@everframe/web` and the published
// `@everframe/react` that shares this file:
//
//   1. `__openReporter()` — `open()` (and, through the registered show-modal
//      callback, the hotkey) still mounted the dialog and captured a
//      screenshot of the user's page after the switch was pulled.
//   2. `crashSink` — an uncaught error after the switch still built an
//      envelope, wrote it to the origin-wide outbox and POSTed it.
//
// Each `it` below is paired with a LIVE control that exercises the identical
// path on a non-killed adapter, so a gate that silently swallowed everything
// (or a harness that never reached the sink at all) fails just as loudly as
// the missing gate did.
//
// Both gates read `reportingKilled`, NOT the never-reset `killed` — see the
// third describe block, and the flag's declaration in adapter.ts, for why the
// difference exists and what would break without it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebPlatformAdapter } from '../src/adapter.js';

// installConsolePatcher / the window.onerror patcher are install-once behind
// global Symbol markers, so the crash forwarding slot belongs to whichever
// adapter bound LAST. Every adapter a test creates is torn down here, exactly
// as crash-reporting.spec.ts does.
const adapters: Array<{ __testCleanup: () => void }> = [];

const mk = (config: Parameters<typeof createWebPlatformAdapter>[0]) => {
  const adapter = createWebPlatformAdapter(config);
  adapters.push(adapter);
  return adapter;
};

/** Resolve to the settled value, or the string 'PENDING' after `ms`. Makes an
 *  un-settled promise an assertion failure with a readable diff instead of a
 *  whole-spec timeout. */
async function settledWithin<T>(p: Promise<T>, ms = 50): Promise<T | 'PENDING'> {
  return Promise.race([p, new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms))]);
}

function boom(): TypeError {
  const err = new TypeError('boom');
  err.stack = 'TypeError: boom\n    at f (a.ts:1:1)';
  return err;
}

describe('kill switch: a killed adapter opens nothing and reports nothing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'received' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    while (adapters.length) adapters.pop()!.__testCleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('finding 1 — __openReporter() after kill()', () => {
    it('LIVE control: stages a pending promise and shows the modal', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const shown = vi.fn();
      adapter.__registerShowModal(shown);

      const pending = adapter.__openReporter();

      expect(shown).toHaveBeenCalledTimes(1);
      // Genuinely pending — the user has not answered the dialog yet.
      expect(await settledWithin(pending)).toBe('PENDING');
      adapter.__resolveOpen({ status: 'cancelled' }); // don't leave it dangling
    });

    it('refuses to open, and resolves cancelled/killed instead of hanging', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const shown = vi.fn();
      adapter.__registerShowModal(shown);

      adapter.onKill?.();

      // Both halves are load-bearing and each fails on its own against the
      // unfixed adapter: `shown` was called (a screenshot of the user's page
      // followed), and the promise stayed 'PENDING' forever.
      const result = await settledWithin(adapter.__openReporter());
      expect(shown).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'cancelled', reason: 'killed' });
    });

    it('stays refused on every later call, not just the first', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const shown = vi.fn();
      adapter.__registerShowModal(shown);
      adapter.onKill?.();

      expect(await settledWithin(adapter.__openReporter())).toEqual({
        status: 'cancelled',
        reason: 'killed',
      });
      expect(await settledWithin(adapter.__openReporter())).toEqual({
        status: 'cancelled',
        reason: 'killed',
      });
      expect(shown).not.toHaveBeenCalled();
    });
  });

  // The gate is deliberately REVIVABLE through `__rebindCrumbHooks()`, and
  // that is load-bearing rather than a loophole: React StrictMode (the Next.js
  // dev default) simulates an unmount by running provider.tsx's teardown
  // cleanup — which calls `client.kill()` — and then re-running every mount
  // effect against the SAME adapter. Without the revive, the reporter is dead
  // in every StrictMode dev app; sdk-react's breadcrumbs-strictmode.spec.tsx
  // fails on exactly that. `__rebindCrumbHooks()` is the seam a live mount
  // uses to claim the adapter, and a genuine host `kill()` is never followed
  // by one. See the flag's declaration in adapter.ts.
  describe('the StrictMode remount path revives it — and only that path', () => {
    it('a mount rebind after kill() restores open()', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const shown = vi.fn();
      adapter.__registerShowModal(shown);

      adapter.onKill?.(); // provider.tsx's cleanup, run by StrictMode
      adapter.__rebindCrumbHooks(); // provider.tsx's mount effect, re-run

      const pending = adapter.__openReporter();
      expect(shown).toHaveBeenCalledTimes(1);
      expect(await settledWithin(pending)).toBe('PENDING');
      adapter.__resolveOpen({ status: 'cancelled' });
    });

    it('a mount rebind after kill() restores crash reporting', async () => {
      const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });

      adapter.onKill?.();
      adapter.__rebindCrumbHooks();
      window.onerror?.('boom', 'a.ts', 1, 1, boom());

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    });

    // Codex round-2 finding 3 (P1) — a REGRESSION this branch introduced in
    // the PUBLISHED `@everframe/react`, not a gap in the vanilla SDK. Round 1
    // gated the 'online' outbox-drain listener on `killed`, which is set once
    // and never reset; `__rebindCrumbHooks()` revives `reportingKilled` but
    // deliberately not `killed`. So under React 18 StrictMode — i.e. every
    // Next.js/CRA dev environment, where the simulated unmount calls
    // `client.kill()` on a LIVE Provider — a report queued while offline
    // never drained on reconnect, for the rest of the session.
    //
    // The listener now consults `reportingKilled`, the same flag
    // `__openReporter()` and `crashSink` use: "a live mount owns this
    // adapter", which only `__rebindCrumbHooks()` can assert.
    it('a mount rebind after kill() restores the reconnect outbox drain', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const drain = vi.fn();
      adapter.__registerOutboxDrainTrigger(drain);

      adapter.onKill?.(); // StrictMode's simulated unmount
      adapter.__rebindCrumbHooks(); // ...and the immediate remount

      window.dispatchEvent(new Event('online'));

      expect(drain).toHaveBeenCalledTimes(1);
    });
  });

  // The pair the revive test above is only meaningful against: the listener
  // has to fire at all on a live adapter, and has to stay silent for an
  // adapter that was genuinely killed (no rebind ever follows a host's
  // `kill()`, which is the whole distinction `reportingKilled` encodes).
  describe("finding 3 — the 'online' drain listener", () => {
    it('LIVE control: a reconnect drains the outbox', () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const drain = vi.fn();
      adapter.__registerOutboxDrainTrigger(drain);

      window.dispatchEvent(new Event('online'));

      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('a genuinely killed adapter still refuses to drain', () => {
      const adapter = mk({ apiKey: 'pk_test' });
      const drain = vi.fn();
      adapter.__registerOutboxDrainTrigger(drain);

      adapter.onKill?.(); // and nothing rebinds — the host pulled the switch

      window.dispatchEvent(new Event('online'));

      expect(drain).not.toHaveBeenCalled();
    });
  });

  // Codex round-3 findings 2 and 4 — the capture primitives themselves. These
  // four are the choke point for reading the user's device: sdk-core's report
  // flow, the reporter dialog and EVERY phone-companion route (report.request's
  // bundle, the preview loop's frames, the shot stash's full-res captures) go
  // through this object, so gating here is what makes "after kill(), nothing is
  // captured" hold for async loops that were started before the switch.
  describe('round-3 — the capture primitives', () => {
    it('LIVE control: a live adapter captures', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      console.log('live-primitive-line');

      await expect(adapter.captureScreenshot()).resolves.toBeDefined();
      expect(adapter.captureRecentLogs().map((e) => e.message)).toContain(
        'live-primitive-line',
      );
      expect(adapter.getDeviceMetadata()).toBeTruthy();
    });

    it('refuses to screenshot the page once killed', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.onKill?.();

      // REJECTS rather than resolving a blank image: every caller has a
      // failure path, and a synthetic blank would be indistinguishable from a
      // real capture of a blank page.
      await expect(adapter.captureScreenshot()).rejects.toThrow(/kill/i);
    });

    it('hands back no logs, no network and no focused node once killed', () => {
      const adapter = mk({ apiKey: 'pk_test' });
      console.log('captured-before-kill');
      adapter.onKill?.();

      expect(adapter.captureRecentLogs()).toEqual([]);
      expect(adapter.captureRecentNetwork()).toEqual([]);
      expect(adapter.captureFocusedNode()).toBeNull();
    });

    it('a StrictMode remount restores them', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.onKill?.();
      adapter.__rebindCrumbHooks();

      console.log('after-remount-line');
      await expect(adapter.captureScreenshot()).resolves.toBeDefined();
      expect(adapter.captureRecentLogs().map((e) => e.message)).toContain(
        'after-remount-line',
      );
    });
  });

  describe('finding 2 — an uncaught error after kill()', () => {
    it('LIVE control: enqueues an envelope and POSTs it', async () => {
      mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });

      window.onerror?.('boom', 'a.ts', 1, 1, boom());

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    });

    it('builds nothing, enqueues nothing and sends nothing', async () => {
      const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });

      adapter.onKill?.();
      // The forwarder itself deliberately survives teardown (it is page-global
      // and install-once), so this call DOES still reach `crashSink` — which is
      // exactly why the gate has to live inside the sink.
      window.onerror?.('boom', 'a.ts', 1, 1, boom());

      // A generous settle window: the unfixed sink's enqueue + POST both land
      // inside it (the LIVE control above resolves in the same window).
      await new Promise((r) => setTimeout(r, 60));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await adapter.outbox!.list()).toEqual([]);
    });

    it('does not consume dedupe or throttle state when a stack getter kills capture', async () => {
      const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });
      const error = boom();
      let killFromGetter = true;
      Object.defineProperty(error, 'stack', {
        configurable: true,
        get() {
          if (killFromGetter) adapter.onKill?.();
          return 'TypeError: boom\n    at f (a.ts:1:1)';
        },
      });

      adapter.captureException?.(error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await adapter.outbox!.list()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();

      killFromGetter = false;
      adapter.__rebindCrumbHooks();
      adapter.captureException?.(error);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    });

    it('removes a crash and skips delivery when ownership changes during async persistence', async () => {
      const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });
      const outbox = adapter.outbox!;
      const realEnqueue = outbox.enqueue.bind(outbox);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const enqueueStarted = new Promise<void>((resolve) => { started = resolve; });
      outbox.enqueue = async (item) => {
        started();
        await gate;
        await realEnqueue(item);
      };

      adapter.captureException?.(boom());
      await enqueueStarted;
      adapter.onKill?.();
      release();

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await outbox.list()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['killed', 'killed-then-reclaimed'] as const)(
      'cancels a crash whose outbox read resumes after ownership is %s',
      async (ownershipChange) => {
        const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });
        const outbox = adapter.outbox!;
        const realList = outbox.list.bind(outbox);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let started!: () => void;
        const listStarted = new Promise<void>((resolve) => { started = resolve; });
        outbox.list = async () => {
          started();
          await gate;
          return realList();
        };

        adapter.captureException?.(boom());
        await listStarted;
        adapter.onKill?.();
        if (ownershipChange === 'killed-then-reclaimed') adapter.__rebindCrumbHooks();
        release();

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(await realList()).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('cancels a crash when ownership changes while reporter credentials load', async () => {
      const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });
      const credentials = adapter.reporterCredentials!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const loadStarted = new Promise<void>((resolve) => { started = resolve; });
      credentials.load = async () => {
        started();
        await gate;
        return null;
      };

      adapter.captureException?.(boom());
      await loadStarted;
      adapter.onKill?.();
      release();

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await adapter.outbox!.list()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not start another retry after ownership changes during its delay', async () => {
      const firstAttempt = new Promise<void>((resolve) => {
        fetchMock.mockImplementationOnce(async () => {
          resolve();
          return new Response('{}', { status: 503 });
        });
      });
      const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0' });

      adapter.captureException?.(boom());
      await firstAttempt;
      adapter.onKill?.();

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await adapter.outbox!.list()).toEqual([]);
    });
  });
});
