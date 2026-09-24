// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion TV-side `report.submit` handshake specs. The ingest submit itself
// (multipart + retry) is covered by transport/submit specs — here we mock
// `submitReportFromDraft` and assert the companion handshake: pairing the
// submit text with the baked-screenshot binary, mapping includes→excluded,
// replying report.completed / report.failed, and returning state to `paired`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/transport/submit.js', () => ({
  submitReportFromDraft: vi.fn(),
  drainOutbox: vi.fn(),
}));

import { submitReportFromDraft } from '../../src/transport/submit.js';
import { createCompanion } from '../../src/companion/state.js';
import {
  handleCompanionSubmitText,
  handleCompanionSubmitBinary,
  handleCompanionReportRequest,
  __resetCompanionSubmitFramingForTests,
} from '../../src/companion/capture-bridge.js';
import type { RelayWSClient, ReportSubmit } from '../../src/companion/ws-client.js';
import type { CompanionHost } from '../../src/companion/host-seam.js';
import type { UserMetadata } from '@everframe/sdk-core';

const submitMock = vi.mocked(submitReportFromDraft);

function makeWs(): { send: ReturnType<typeof vi.fn>; client: RelayWSClient } {
  const send = vi.fn();
  const client = { send, sendBinary: vi.fn(), start: vi.fn(), stop: vi.fn() } as unknown as RelayWSClient;
  return { send, client };
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

function makeHost(
  capturedIdentityToken: string | null = null,
  getUser: () => UserMetadata | null = () => null,
): CompanionHost {
  return {
    config: { apiKey: 'txx_test_key' } as CompanionHost['config'],
    adapter: {
      outbox: undefined,
      __getBreadcrumbBuffer: () => fakeBreadcrumbs,
      __replayLifecycle: fakeLifecycle,
      __breadcrumbTrimOptions: () => ({ byteBudget: 100_000, consoleEntryCap: 50 }),
      // PR review, round 4 (Serious) — `runCompanionSubmit` now captures the
      // identity at the submit boundary (before `fakeLifecycle.complete()` /
      // breadcrumb snapshotting below) via this adapter method; every mock
      // adapter in this file needs it or the real function throws before
      // ever reaching `submitReportFromDraft`.
      __captureIdentityAtSubmitBoundary: vi.fn(async () => capturedIdentityToken),
    } as unknown as CompanionHost['adapter'],
    sdkVersion: '0.0.0-test',
    // Task 15 (2026-08-12) — a getter, not a stored value: read at submit
    // time so a sign-in/out between mount and submit is reflected. Defaults
    // to "nobody signed in" so every pre-existing test in this file, which
    // doesn't care about identity, keeps behaving exactly as before.
    getUser,
  };
}

const SUBMIT_MSG: ReportSubmit = {
  type: 'report.submit',
  correlation_id: 'c-1',
  title: 'Broken button',
  description: { text: 'It does nothing', redactions: [] },
  annotations: [],
  // `uiTree: false` is what the phone now echoes back — it mirrors the
  // `toggles.uiTree: false` the device announces, since no producer captures
  // a tree any more. It must NOT be read as "the user turned this off".
  includes: { logs: true, network: false, uiTree: false, metadata: true, screenshot: true },
} as ReportSubmit;

// Minimal PNG-magic bytes so sniffImageMime → image/png.
const BAKED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;

describe('companion/capture-bridge report.submit', () => {
  beforeEach(() => {
    submitMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('text→binary: submits and replies report.completed, returns to paired', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-1', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    companion.__setState('report_in_progress');
    const host = makeHost();

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    expect(send).not.toHaveBeenCalled(); // waits for the binary
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    // Submitted via the standard ingest path with the right config + draft.
    expect(submitMock).toHaveBeenCalledTimes(1);
    const arg = submitMock.mock.calls[0]![0];
    expect(arg.config.apiKey).toBe('txx_test_key');
    expect(arg.sdkVersion).toBe('0.0.0-test');
    expect(arg.draft.title).toBe('Broken button');
    expect(arg.draft.description).toBe('It does nothing');
    // includes.network=false → 'network' excluded; others included.
    expect(arg.draft.excludedArtifacts).toContain('network');
    expect(arg.draft.excludedArtifacts).not.toContain('logs');
    // `includes.uiTree` is false above, yet 'uiTree' must never reach
    // excludedArtifacts: the artifact does not exist, so "excluded" would be
    // a lie that the AI triage prompt and admin both read as a user choice.
    expect(arg.draft.excludedArtifacts).not.toContain('uiTree');
    expect(arg.bundle.screenshotBlob).toBeInstanceOf(Blob);
    expect(typeof arg.bundle.screenshotSha256).toBe('string');

    expect(send).toHaveBeenCalledWith({
      type: 'report.completed',
      correlation_id: 'c-1',
      event_id: 'rid-1',
    });
    expect(companion.getState()).toBe('paired');
  });

  it('binary→text ordering also completes the submit', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-2', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost();

    handleCompanionSubmitBinary(BAKED, client, host, companion);
    expect(send).not.toHaveBeenCalled();
    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'report.completed',
      correlation_id: 'c-1',
      event_id: 'rid-2',
    });
  });

  it('no host → report.failed(submit_unavailable), never submits, returns to paired', async () => {
    const { send, client } = makeWs();
    const companion = createCompanion();
    companion.__setState('report_in_progress');

    handleCompanionSubmitText(SUBMIT_MSG, client, null, companion);
    handleCompanionSubmitBinary(BAKED, client, null, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(submitMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: 'report.failed',
      correlation_id: 'c-1',
      reason: 'submit_unavailable',
    });
    expect(companion.getState()).toBe('paired');
  });

  it('ingest failure → report.failed with retryable reason', async () => {
    submitMock.mockResolvedValue({ ok: false, retryable: true, reportId: 'rid-3', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost();

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith({
      type: 'report.failed',
      correlation_id: 'c-1',
      reason: 'ingest_retryable',
    });
    expect(companion.getState()).toBe('paired');
  });

  it('submit bundle carries frozen breadcrumbs and replay capture', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-4', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost();

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    const bundle = submitMock.mock.calls[0]![0].bundle;
    expect(bundle.breadcrumbs).toEqual([{ kind: 'custom', message: 'before', ts: 1 }]);
    expect(bundle.breadcrumbTrim).toEqual({ byteBudget: 100_000, consoleEntryCap: 50 });
    expect(bundle.replayCapture?.format).toBe('rrweb');
    expect(typeof bundle.replaySha256).toBe('string');
  });

  // PR review, round 4 (Serious) — the companion path is the SECOND entry
  // point into report submission (alongside provider.tsx's `onComplete`),
  // and needs the identical submit-boundary capture: BEFORE the
  // screenshot-hash / replay-lifecycle-complete / breadcrumb-snapshot prep
  // this function does, not resolved fresh (deep inside
  // `submitReportFromDraft`) once that prep has finished. Proves two things:
  // (1) `__captureIdentityAtSubmitBoundary()` is called before
  // `__replayLifecycle.complete()` — the ordering the fix depends on — and
  // (2) its result is threaded straight through as `capturedIdentityToken`
  // in the `submitReportFromDraft` call, not discarded.
  it("carries the host's extra into the draft (payload.extra parity with the in-app path)", async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-x', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = { ...makeHost(), getExtra: () => '{"appId":"scriptx"}' };

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(submitMock.mock.calls[0]![0].draft.extra).toBe('{"appId":"scriptx"}');
  });

  it('omits extra when the host supplies none, and a throwing getExtra never fails the submit', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-y', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();

    handleCompanionSubmitText(SUBMIT_MSG, client, makeHost(), companion);
    handleCompanionSubmitBinary(BAKED, client, makeHost(), companion);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(submitMock.mock.calls[0]![0].draft.extra).toBeUndefined();

    send.mockClear();
    submitMock.mockClear();
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-z', threadId: null });
    const throwing = {
      ...makeHost(),
      getExtra: () => {
        throw new Error('boom');
      },
    };
    handleCompanionSubmitText({ ...SUBMIT_MSG, correlation_id: 'c-2' }, client, throwing, companion);
    handleCompanionSubmitBinary(BAKED, client, throwing, companion);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(submitMock.mock.calls[0]![0].draft.extra).toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'report.completed', correlation_id: 'c-2' }),
    );
  });

  it('captures identity at the submit boundary — before prep — and threads it through as capturedIdentityToken', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-5', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost('CAPTURED_TOKEN');

    const callOrder: string[] = [];
    vi.mocked(host.adapter.__captureIdentityAtSubmitBoundary).mockImplementation(async () => {
      callOrder.push('capture');
      return 'CAPTURED_TOKEN';
    });
    vi.mocked(host.adapter.__replayLifecycle!.complete).mockImplementation(async () => {
      callOrder.push('prep');
      return {
        format: 'rrweb',
        bytes: new Uint8Array([1, 2, 3]),
        durationMs: 10,
        contentType: 'application/octet-stream',
      };
    });

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    // Load-bearing assertions, checked AFTER the submit resolved: capture
    // happened strictly before prep, and its value reached
    // submitReportFromDraft untouched.
    expect(callOrder).toEqual(['capture', 'prep']);
    expect(submitMock.mock.calls[0]![0].capturedIdentityToken).toBe('CAPTURED_TOKEN');
  });

  // Task 15 (2026-08-12 self-declared-identity spec) — the web phone-companion
  // path was the one submit path Task 7's `setUser` plumbing missed: a
  // reporter who scans the QR and files from their phone has no access to
  // the host's `setUser` value unless `CompanionHost` carries it across the
  // seam. `submitReportFromDraft` itself is mocked in this file (its own
  // `user`→`envelope.reporter.user` threading is covered by
  // transport/submit-user.spec.ts), so what's load-bearing here is only that
  // `runCompanionSubmit` reads `host.getUser()` AT SUBMIT TIME and forwards
  // it, untouched, as `submitReportFromDraft`'s `user` option.
  it('carries the active user into the submitReportFromDraft call', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-6', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const user: UserMetadata = { id: 'u_1', email: 'a@b.com' };
    const host = makeHost(null, () => user);

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(submitMock.mock.calls[0]![0].user).toEqual({ id: 'u_1', email: 'a@b.com' });
  });

  // External review, finding 1 (Serious) — the companion path's half of the
  // same fix the identity token got in round 4: `host.getUser()` used to be
  // read down at the `submitReportFromDraft` call, i.e. AFTER the baked-
  // screenshot hashing, `__replayLifecycle.complete()` and breadcrumb
  // snapshotting this function awaits. A host that switches accounts during
  // that window shipped account A's report attributed to account B.
  //
  // Drives the switch from inside `__replayLifecycle.complete()` — a real
  // await in the real prep sequence — and asserts the submit still carries the
  // user who was live when the phone's `report.submit` arrived.
  it('captures the user at the submit boundary — before prep — so a mid-prep account switch does not win', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-8', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    let liveUser: UserMetadata | null = { id: 'alice', email: 'alice@x.com' };
    const host = makeHost(null, () => liveUser);

    let switchedDuringPrep = false;
    vi.mocked(host.adapter.__replayLifecycle!.complete).mockImplementation(async () => {
      liveUser = { id: 'bob', email: 'bob@x.com' };
      switchedDuringPrep = true;
      return {
        format: 'rrweb',
        bytes: new Uint8Array([1, 2, 3]),
        durationMs: 10,
        contentType: 'application/octet-stream',
      };
    });

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    // The switch really happened inside the prep window — otherwise this test
    // proves nothing.
    expect(switchedDuringPrep).toBe(true);
    expect(submitMock.mock.calls[0]![0].user).toEqual({ id: 'alice', email: 'alice@x.com' });
  });

  // The clone half: the captured value must survive the host mutating its own
  // user object during that same prep window.
  it('ships the user as captured even if the host mutates its own object during prep', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-9', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const hostUser: UserMetadata = { id: 'alice', email: 'alice@x.com' };
    const host = makeHost(null, () => hostUser);

    vi.mocked(host.adapter.__replayLifecycle!.complete).mockImplementation(async () => {
      hostUser.id = 'bob';
      hostUser.email = 'bob@x.com';
      return {
        format: 'rrweb',
        bytes: new Uint8Array([1, 2, 3]),
        durationMs: 10,
        contentType: 'application/octet-stream',
      };
    });

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(submitMock.mock.calls[0]![0].user).toEqual({ id: 'alice', email: 'alice@x.com' });
  });

  // External review, finding 1 (Serious) — the companion path is the SECOND
  // entrance the projection has to cover, not merely another reader:
  // `CompanionHost.getUser()` is a host-implemented seam, so a hand-wired host
  // can supply a fat object here without `client.setUser` (which projects on
  // the way in) ever being involved. `captureUserSnapshot` therefore projects
  // too, and this locks it on the path where it is load-bearing.
  it('ships only id/email/displayName when the host getUser returns its own user object', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-11', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const fat = {
      id: 'alice',
      email: 'alice@x.com',
      displayName: 'Alice',
      accessToken: 'secret-token',
      profile: { address: '1 Main St', dob: '1990-01-01' },
      roles: ['admin'],
      loginCount: 7,
    } as unknown as UserMetadata;
    const host = makeHost(null, () => fat);

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(submitMock.mock.calls[0]![0].user).toEqual({
      id: 'alice',
      email: 'alice@x.com',
      displayName: 'Alice',
    });
  });

  // Recognition must never fail a report: a host-supplied `getUser` that
  // throws degrades to anonymous at the capture boundary rather than falling
  // through to `runCompanionSubmit`'s outer try/catch, whose fallback is
  // `report.failed('ingest_error')` — i.e. losing the whole report.
  it('degrades to anonymous when the host getUser throws, and still submits', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-10', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost(null, () => {
      throw new Error('host getUser exploded');
    });

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]![0].user).toBeNull();
    expect(send).toHaveBeenCalledWith({
      type: 'report.completed',
      correlation_id: 'c-1',
      event_id: 'rid-10',
    });
  });

  it('passes null when nobody is signed in on the host', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'rid-7', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost(null, () => null);

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(submitMock.mock.calls[0]![0].user).toBeNull();
  });
});

// Codex round-2 finding 1, the companion half. `client.kill()` reaches the
// ADAPTER, but the companion host seam holds a live adapter + config until
// `destroy()` clears it — and consent withdrawal is precisely the case where a
// host calls `kill()` and leaves the SDK mounted. So the phone-driven route
// kept photographing the user's screen and shipping envelopes after the switch
// was pulled: a second submit surface, wholly outside the in-app gate.
//
// `isKilled` is an OPTIONAL seam member, absent on `@everframe/react` (whose
// Provider does not set it), so these gates are inert for that SDK.
describe('the kill switch closes the companion route too', () => {
  // Its own hooks: this describe is a SIBLING of the one above, so that
  // block's beforeEach does not reach here, and a leaked mock call or a
  // half-assembled submit frame would make these assertions lie.
  beforeEach(() => {
    submitMock.mockReset();
    __resetCompanionSubmitFramingForTests();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const killedHost = (): CompanionHost => ({ ...makeHost(), isKilled: () => true });

  it('LIVE control: a host that is not killed submits as before', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();
    const host = makeHost();

    handleCompanionSubmitText(SUBMIT_MSG, client, host, companion);
    handleCompanionSubmitBinary(BAKED, client, host, companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('submits nothing, and fails the frame rather than going silent', async () => {
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r', threadId: null });
    const { send, client } = makeWs();
    const companion = createCompanion();

    handleCompanionSubmitText(SUBMIT_MSG, client, killedHost(), companion);
    handleCompanionSubmitBinary(BAKED, client, killedHost(), companion);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(submitMock).not.toHaveBeenCalled();
    // Same wire reason as "no Provider mounted": from the phone's side the two
    // are one fact, and a dropped frame would strand its "sending…" state.
    expect(send).toHaveBeenCalledWith({
      type: 'report.failed',
      correlation_id: 'c-1',
      reason: 'submit_unavailable',
    });
  });

  // The earlier of the two doors: `report.request` is the companion's
  // reporter-open. It photographs the screen and ships the pixels to the
  // paired phone BEFORE any submit exists to gate.
  it('captures nothing on report.request either', async () => {
    const { send, client } = makeWs();
    const captureScreenshot = vi.fn(async () => ({ blob: new Blob(), width: 1, height: 1 }));
    const host = {
      ...killedHost(),
      adapter: {
        ...makeHost().adapter,
        captureScreenshot,
      } as unknown as CompanionHost['adapter'],
    };

    await handleCompanionReportRequest('c-1', client, host);

    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: 'report.failed',
      correlation_id: 'c-1',
      reason: 'submit_unavailable',
    });
  });

  it('LIVE control: an unkilled host DOES capture on report.request', async () => {
    const { client } = makeWs();
    const captureScreenshot = vi.fn(async () => null);
    const host = {
      ...makeHost(),
      adapter: {
        ...makeHost().adapter,
        captureScreenshot,
      } as unknown as CompanionHost['adapter'],
    };

    await handleCompanionReportRequest('c-2', client, host);

    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });
});
