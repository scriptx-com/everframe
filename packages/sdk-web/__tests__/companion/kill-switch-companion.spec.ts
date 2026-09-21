// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codex round-3 finding 4 (P1) — `CompanionHost.isKilled` covered only part of
// the companion lifecycle.
//
// Round 2 added an `isKilled()` check inside two of the bridge's handlers.
// Round 3 found the shape that produces: a `shot.request` arriving after
// `kill()` had NO check at all and started a fresh full-screen capture, a kill
// while the initial screenshot was pending still shipped those pixels, and a
// kill during submit preparation still reached ingest.
//
// The fix moves the gate to the SEAM — `__getCompanionHost()` answers `null`
// once the host reports killed, which every companion entry point already
// fails closed on with a wire answer the phone renders — plus a re-check at
// each of the three async boundaries the seam gate cannot see past.
//
// Every case is paired with a live control on the identical harness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transport/submit.js', () => ({
  submitReportFromDraft: vi.fn(async () => ({ ok: true, retryable: false, reportId: 'r_1' })),
  drainOutbox: vi.fn(),
}));

// The STANDALONE capture path (`handleReportRequest`) reaches the module-level
// screenshot helper, not the host adapter's — jsdom cannot render it, and the
// round-4 cases below are about whether it is called at all.
vi.mock('../../src/capture/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as BlobPart], {
      type: 'image/png',
    }),
    width: 1280,
    height: 720,
    sha256: 'deadbeef',
  })),
}));

import { submitReportFromDraft } from '../../src/transport/submit.js';
import { createCompanion } from '../../src/companion/state.js';
import { captureScreenshot } from '../../src/capture/screenshot.js';
import {
  handleReportRequest,
  handleCompanionReportRequest,
  handleCompanionShotRequest,
  handleCompanionSubmitText,
  handleCompanionSubmitBinary,
  __resetCompanionSubmitFramingForTests,
} from '../../src/companion/capture-bridge.js';
import {
  __setCompanionHost,
  __getCompanionHost,
  __isCompanionKilled,
  __resetCompanionHostForTests,
  type CompanionHost,
} from '../../src/companion/host-seam.js';
import type { RelayWSClient, ReportSubmit } from '../../src/companion/ws-client.js';

const submitMock = vi.mocked(submitReportFromDraft);

function makeWs(): {
  send: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
  client: RelayWSClient;
} {
  const send = vi.fn();
  const sendBinary = vi.fn();
  const client = { send, sendBinary, start: vi.fn(), stop: vi.fn() } as unknown as RelayWSClient;
  return { send, sendBinary, client };
}

const shot = (): { blob: Blob; width: number; height: number; sha256: string } => ({
  blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
  width: 100,
  height: 50,
  sha256: 'deadbeef',
});

/**
 * `killed` is a MUTABLE box, not a constructor argument: every case here turns
 * the switch on part-way through, which is the whole point of the finding.
 */
function installHost(killed: { value: boolean }, captureScreenshot?: () => Promise<unknown>) {
  const screenshotCalls = vi.fn();
  const host: CompanionHost = {
    config: { apiKey: 'txx_test_key' } as CompanionHost['config'],
    adapter: {
      outbox: undefined,
      captureScreenshot:
        captureScreenshot ??
        (async () => {
          screenshotCalls();
          return shot();
        }),
      captureRecentLogs: () => [],
      captureRecentNetwork: () => [],
      captureFocusedNode: () => null,
      getDeviceMetadata: () => null,
      __getBreadcrumbBuffer: () => undefined,
      __replayLifecycle: undefined,
      __breadcrumbTrimOptions: () => ({ byteBudget: 100_000, consoleEntryCap: 50 }),
      __identityTokenReader: { get: async () => null },
      __captureIdentityAtSubmitBoundary: vi.fn(async () => null),
    } as unknown as CompanionHost['adapter'],
    sdkVersion: '0.0.0-test',
    getUser: () => null,
    isKilled: () => killed.value,
  };
  __setCompanionHost(host);
  return { host, screenshotCalls };
}

const SUBMIT_MSG: ReportSubmit = {
  type: 'report.submit',
  correlation_id: 'c-1',
  title: 'Broken button',
  description: { text: 'It does nothing', redactions: [] },
  annotations: [],
  includes: { logs: true, network: true, uiTree: false, metadata: true, screenshot: true },
} as ReportSubmit;

const baked = (): ArrayBuffer => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer;

beforeEach(() => {
  submitMock.mockClear();
  submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r_1' } as never);
});

afterEach(() => {
  __setCompanionHost(null);
  __resetCompanionSubmitFramingForTests();
  vi.clearAllMocks();
});

describe('the seam is the companion kill gate', () => {
  it('LIVE control: a live host is reachable through the seam', () => {
    const killed = { value: false };
    const { host } = installHost(killed);
    expect(__getCompanionHost()).toBe(host);
  });

  it('a killed host reads as no host at all', () => {
    const killed = { value: true };
    installHost(killed);
    expect(__getCompanionHost()).toBeNull();
  });

  it('an isKilled() that THROWS fails closed rather than opening the gate', () => {
    __setCompanionHost({
      config: {} as CompanionHost['config'],
      adapter: {} as CompanionHost['adapter'],
      sdkVersion: '0',
      getUser: () => null,
      isKilled: () => {
        throw new Error('host bug');
      },
    });
    expect(__getCompanionHost()).toBeNull();
  });

  // The route round 3 found with no check whatsoever. `ws-client.ts` dispatches
  // `shot.request` with `__getCompanionHost()`, so the seam gate is what turns
  // it into the existing `capture_unavailable` refusal.
  describe('shot.request', () => {
    it('LIVE control: captures and ships the shot', async () => {
      const killed = { value: false };
      const { screenshotCalls } = installHost(killed);
      const ws = makeWs();

      await handleCompanionShotRequest(__getCompanionHost(), ws.client, {
        correlation_id: 'c-1',
        shot_id: 's-1',
      });

      expect(screenshotCalls).toHaveBeenCalledTimes(1);
      expect(ws.sendBinary).toHaveBeenCalledTimes(1);
      expect(ws.send.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
        'shot.assembled',
      );
    });

    it('captures nothing and answers shot.failed once killed', async () => {
      const killed = { value: true };
      const { screenshotCalls } = installHost(killed);
      const ws = makeWs();

      await handleCompanionShotRequest(__getCompanionHost(), ws.client, {
        correlation_id: 'c-1',
        shot_id: 's-1',
      });

      expect(screenshotCalls).not.toHaveBeenCalled();
      expect(ws.sendBinary).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'shot.failed', reason: 'capture_unavailable' }),
      );
    });
  });
});

describe('kill() landing while the report.request screenshot is pending', () => {
  /** A screenshot that resolves only when the test releases it. */
  function heldScreenshot(): {
    capture: () => Promise<unknown>;
    release: () => void;
    started: ReturnType<typeof vi.fn>;
  } {
    let release!: () => void;
    const started = vi.fn();
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return {
      started,
      release,
      capture: async () => {
        started();
        await gate;
        return shot();
      },
    };
  }

  it('LIVE control: the released capture ships assembled + binary', async () => {
    const killed = { value: false };
    const held = heldScreenshot();
    installHost(killed, held.capture);
    const ws = makeWs();

    const done = handleCompanionReportRequest('c-1', ws.client, __getCompanionHost()!);
    await vi.waitFor(() => expect(held.started).toHaveBeenCalled());
    held.release();
    await done;

    expect(ws.send.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      'report.assembled',
    );
    expect(ws.sendBinary).toHaveBeenCalledTimes(1);
  });

  it('ships no pixels, and answers, when the switch is pulled mid-capture', async () => {
    const killed = { value: false };
    const held = heldScreenshot();
    installHost(killed, held.capture);
    const ws = makeWs();

    const done = handleCompanionReportRequest('c-1', ws.client, __getCompanionHost()!);
    await vi.waitFor(() => expect(held.started).toHaveBeenCalled());
    killed.value = true; // consent withdrawn while the TV is rendering the DOM
    held.release();
    await done;

    expect(ws.sendBinary).not.toHaveBeenCalled();
    const types = ws.send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('report.assembled');
    // Answered rather than dropped — a silent abort strands the phone in
    // "capturing…" until its correlation times out.
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });
});

describe('kill() landing during companion submit preparation', () => {
  /** Drive the full text+binary submit handshake. */
  async function runSubmit(
    killed: { value: boolean },
    onPrep?: () => void,
  ): Promise<ReturnType<typeof makeWs>> {
    const { host } = installHost(killed);
    if (onPrep) {
      (
        host.adapter as unknown as {
          __captureIdentityAtSubmitBoundary: () => Promise<string | null>;
        }
      ).__captureIdentityAtSubmitBoundary = async () => {
        onPrep();
        return null;
      };
    }
    const ws = makeWs();
    const companion = createCompanion();
    handleCompanionSubmitText(SUBMIT_MSG, ws.client, __getCompanionHost(), companion);
    handleCompanionSubmitBinary(baked(), ws.client, __getCompanionHost(), companion);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    return ws;
  }

  it('LIVE control: the handshake reaches ingest and reports completed', async () => {
    const killed = { value: false };
    const ws = await runSubmit(killed);

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.completed' }),
    );
  });

  it('never reaches ingest when the switch is pulled after the entry gate', async () => {
    const killed = { value: false };
    // Flipped from inside the submit-boundary identity capture — i.e. after
    // `runCompanionSubmit`'s entry check has already passed, in the middle of
    // the hashing / replay-completion window.
    const ws = await runSubmit(killed, () => {
      killed.value = true;
    });

    expect(submitMock).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });
});

// Codex round-4 finding 1 (P1) — `destroy()` REOPENED the gate round 3 closed.
//
// The seam's kill predicate answered `false` for a null host, and `destroy()`
// (and a Provider unmount) clears the seam. So the very act of tearing the SDK
// down turned every one of round 3's checks back into a pass: an in-flight
// companion screenshot or submit sailed through the post-await re-checks, and
// the next `report.request` fell back to standalone screenshot capture — the
// phone could still photograph the user's screen after teardown.
//
// A cleared host now fails closed. Not a null one: `handleReportRequest` is the
// path for a host that never published a seam at all (a hand-wired
// `createRelayWSClient`, or a `companion.start()` that runs ahead of `init()`),
// and "no host YET" is legitimately not-started. The latch is what tells the
// two apart, and it is REVIVABLE by a re-publish so React StrictMode's
// unmount/remount does not permanently retire the companion in dev.
describe('a torn-down seam is a closed gate (destroy / unmount)', () => {
  const screenshotMock = vi.mocked(captureScreenshot);

  beforeEach(() => {
    // Back to "nothing was ever published on this page" — `__setCompanionHost(null)`
    // deliberately cannot do this, which is the point of the latch.
    __resetCompanionHostForTests();
    screenshotMock.mockClear();
  });

  afterEach(() => {
    __resetCompanionHostForTests();
  });

  it('LIVE control: a host that never published still gets standalone capture', async () => {
    const ws = makeWs();

    await handleReportRequest('c-1', ws.client, { logs: 0, network: 0, uiTreeNodes: 0 });

    expect(__isCompanionKilled()).toBe(false);
    expect(screenshotMock).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      'report.assembled',
    );
  });

  it('refuses standalone capture once a published host has been torn down', async () => {
    installHost({ value: false }); // init() / Provider mount
    __setCompanionHost(null); // destroy() / unmount
    const ws = makeWs();

    await handleReportRequest('c-1', ws.client, { logs: 0, network: 0, uiTreeNodes: 0 });

    expect(__isCompanionKilled()).toBe(true);
    // The assertion the finding is about: no pixels are read at all.
    expect(screenshotMock).not.toHaveBeenCalled();
    expect(ws.sendBinary).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });

  it('ships no pixels when destroy() lands while the screenshot is pending', async () => {
    // The trigger named in the finding: teardown DURING an in-flight capture.
    // `handleCompanionReportRequest` already holds the host it was dispatched
    // with, so only the seam's own predicate can stop it after the await.
    let release!: () => void;
    const started = vi.fn();
    const gate = new Promise<void>((r) => {
      release = r;
    });
    installHost({ value: false }, async () => {
      started();
      await gate;
      return shot();
    });
    const ws = makeWs();

    const done = handleCompanionReportRequest('c-1', ws.client, __getCompanionHost()!);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    __setCompanionHost(null); // destroy() while the TV is rendering the DOM
    release();
    await done;

    expect(ws.sendBinary).not.toHaveBeenCalled();
    const types = ws.send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('report.assembled');
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });

  it('never reaches ingest when destroy() lands during submit preparation', async () => {
    const { host } = installHost({ value: false });
    (
      host.adapter as unknown as {
        __captureIdentityAtSubmitBoundary: () => Promise<string | null>;
      }
    ).__captureIdentityAtSubmitBoundary = async () => {
      __setCompanionHost(null); // destroy() mid-preparation
      return null;
    };
    const ws = makeWs();
    const companion = createCompanion();

    handleCompanionSubmitText(SUBMIT_MSG, ws.client, host, companion);
    handleCompanionSubmitBinary(baked(), ws.client, host, companion);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

    expect(submitMock).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });

  it('a re-published host reopens the gate (React StrictMode remount)', async () => {
    // StrictMode runs the REAL cleanup — provider.tsx's `__setCompanionHost(null)`
    // — and then remounts and re-publishes. Latching irreversibly here would
    // leave the companion refusing for the life of the page in every React dev
    // environment, which is the mistake rounds 2 and 4 both had to undo.
    installHost({ value: false }); // mount pass 1
    __setCompanionHost(null); // simulated unmount
    expect(__isCompanionKilled()).toBe(true);

    const { host, screenshotCalls } = installHost({ value: false }); // remount
    const ws = makeWs();

    expect(__isCompanionKilled()).toBe(false);
    expect(__getCompanionHost()).toBe(host);

    await handleCompanionReportRequest('c-2', ws.client, __getCompanionHost()!);

    expect(screenshotCalls).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      'report.assembled',
    );
  });

  it('a defensive clear with nothing published does not retire the standalone path', async () => {
    // A host wiring the seam by hand may clear it without ever setting it; that
    // must not be mistaken for a teardown, or the never-started fallback dies
    // on a page that never had a Provider.
    __setCompanionHost(null);
    __setCompanionHost(null);
    const ws = makeWs();

    await handleReportRequest('c-3', ws.client, { logs: 0, network: 0, uiTreeNodes: 0 });

    expect(__isCompanionKilled()).toBe(false);
    expect(screenshotMock).toHaveBeenCalledTimes(1);
  });
});

// Codex round-5 finding 1 (P1) — the successor tenant vouched for its
// predecessor.
//
// Round 4's latch was a page-global boolean, and `__setCompanionHost(host)`
// cleared it. So the post-await re-checks asked "has ANYONE published since?"
// rather than "is the host that BEGAN this operation still the current one?" —
// and the answer was yes for the exact sequence the finding names: tenant A
// starts a slow screenshot or submit, the app calls `destroy()` and
// immediately `init()`s tenant B, and B's publication reopened the gate for
// A's in-flight work. A's pixels reached the phone; A's prepared report
// reached ingest, after A's teardown.
//
// The seam carries identity now. Each case below asserts BOTH halves: the
// operation is refused, AND the page-wide predicate still answers "not killed"
// — which is precisely what the old boolean consulted, so these cases are red
// against it.
describe('an operation never completes under a host that has been replaced', () => {
  beforeEach(() => {
    __resetCompanionHostForTests();
  });

  afterEach(() => {
    __resetCompanionHostForTests();
  });

  /** A screenshot that resolves only when the test releases it. */
  function heldCapture(): {
    capture: () => Promise<unknown>;
    release: () => void;
    started: ReturnType<typeof vi.fn>;
  } {
    let release!: () => void;
    const started = vi.fn();
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return {
      started,
      release,
      capture: async () => {
        started();
        await gate;
        return shot();
      },
    };
  }

  it('LIVE control: the same capture ships while its own host is still current', async () => {
    const held = heldCapture();
    installHost({ value: false }, held.capture);
    const ws = makeWs();

    const done = handleCompanionReportRequest('c-1', ws.client, __getCompanionHost()!);
    await vi.waitFor(() => expect(held.started).toHaveBeenCalled());
    held.release();
    await done;

    expect(ws.sendBinary).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      'report.assembled',
    );
  });

  it("ships no pixels when the next tenant's init() lands mid-capture", async () => {
    const held = heldCapture();
    installHost({ value: false }, held.capture); // tenant A
    const ws = makeWs();

    const done = handleCompanionReportRequest('c-1', ws.client, __getCompanionHost()!);
    await vi.waitFor(() => expect(held.started).toHaveBeenCalled());
    __setCompanionHost(null); // A's destroy()
    installHost({ value: false }); // B's init(), same tick
    held.release();
    await done;

    // The page as a whole is perfectly healthy — B is live and not killed.
    // That is the answer the old page-global boolean gave this capture.
    expect(__isCompanionKilled()).toBe(false);
    // A's pixels stay on the device regardless.
    expect(ws.sendBinary).not.toHaveBeenCalled();
    const types = ws.send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('report.assembled');
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });

  it("never reaches ingest when the next tenant's init() lands mid-submit", async () => {
    const { host } = installHost({ value: false }); // tenant A
    (
      host.adapter as unknown as {
        __captureIdentityAtSubmitBoundary: () => Promise<string | null>;
      }
    ).__captureIdentityAtSubmitBoundary = async () => {
      __setCompanionHost(null); // A's destroy() mid-preparation…
      installHost({ value: false }); // …and B's init() right behind it
      return null;
    };
    const ws = makeWs();
    const companion = createCompanion();

    handleCompanionSubmitText(SUBMIT_MSG, ws.client, host, companion);
    handleCompanionSubmitBinary(baked(), ws.client, host, companion);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

    expect(__isCompanionKilled()).toBe(false); // B says the page is fine…
    expect(submitMock).not.toHaveBeenCalled(); // …and A's report still never ships
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.failed', reason: 'submit_unavailable' }),
    );
  });

  it('ships no shot when the seam is torn down mid shot.request capture', async () => {
    // The third capture route. Its entry gate reads the seam (round 3), but the
    // full-resolution grab it starts takes seconds on TV silicon and nothing
    // re-asked afterwards.
    const held = heldCapture();
    installHost({ value: false }, held.capture);
    const ws = makeWs();

    const done = handleCompanionShotRequest(__getCompanionHost(), ws.client, {
      correlation_id: 'c-1',
      shot_id: 's-1',
    });
    await vi.waitFor(() => expect(held.started).toHaveBeenCalled());
    __setCompanionHost(null); // destroy() while the TV is rendering the DOM
    held.release();
    await done;

    expect(ws.sendBinary).not.toHaveBeenCalled();
    const types = ws.send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('shot.assembled');
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shot.failed', reason: 'capture_unavailable' }),
    );
  });

  it('a host that was never published is governed only by its own isKilled', async () => {
    // The hand-wired path (`createRelayWSClient` + a `CompanionHost` passed
    // straight to these handlers, never published here). Identity cannot judge
    // it — this module never owned its lifetime — so the seam must not start
    // refusing it just because some OTHER host was torn down on this page.
    installHost({ value: false }); // somebody else's mount…
    __setCompanionHost(null); // …and its teardown
    const handWired: CompanionHost = {
      config: { apiKey: 'txx_test_key' } as CompanionHost['config'],
      adapter: {
        captureScreenshot: async () => shot(),
        captureRecentLogs: () => [],
        captureRecentNetwork: () => [],
        captureFocusedNode: () => null,
        getDeviceMetadata: () => null,
        __getBreadcrumbBuffer: () => undefined,
        __replayLifecycle: undefined,
        __breadcrumbTrimOptions: () => ({ byteBudget: 100_000, consoleEntryCap: 50 }),
      } as unknown as CompanionHost['adapter'],
      sdkVersion: '0.0.0-test',
      getUser: () => null,
    };
    const ws = makeWs();

    await handleCompanionReportRequest('c-9', ws.client, handWired);

    expect(ws.send.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      'report.assembled',
    );
  });
});
