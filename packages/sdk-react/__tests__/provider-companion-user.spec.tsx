// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 15 PR review, Important finding 2 (2026-08-12) — provider.tsx's
// `__setCompanionHost` effect (~line 166) writes the companion host seam
// ONCE per Provider context value: `ctxValue` is a single-init `useMemo`
// (empty dep array, "config swap requires Provider remount" per its own
// comment), so the effect that publishes `getUser` never re-runs after
// mount. The getter is then read across MANY LATER companion submits, as
// the host signs in and out with no remount in between.
//
// Every other Task 15 spec (companion/capture-bridge-submit.spec.ts) hand-
// constructs its own `CompanionHost` fixture and submits synchronously —
// none of them exercise that write-once-read-many lifecycle, so a refactor
// that captured `__internalClientState.get(ctxValue.client)?.user ?? null`
// into a plain variable AT EFFECT-RUN TIME (pinning whoever was active at
// mount, forever) would type-check and pass every one of those specs.
//
// This spec mounts the REAL TraceItXProvider, reads the REAL seam object it
// publishes via `__getCompanionHost()`, and drives two companion submits
// around a `setUser` call in between — no remount — asserting the SECOND
// submit carries the SECOND user. That is the one shape of test that fails
// against a captured snapshot and passes against a getter.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

// The submit module now lives in @traceitx/web. It has to be mocked at its
// own path, not at the `@traceitx/web` barrel: the call under test reaches it
// through `handleCompanionSubmitText` — an INTERNAL sdk-web module that
// imports it directly — so mocking the barrel would leave that path calling
// the real thing. sdk-react's vitest config aliases `@traceitx/web` to the
// same source tree, so this is the identical module instance.
vi.mock('../../sdk-web/src/transport/submit.js', () => ({
  submitReportFromDraft: vi.fn(),
  drainOutbox: vi.fn(async () => ({ submitted: 0, failed: 0, provisionedThreadIds: [] })),
}));

import { submitReportFromDraft } from '../../sdk-web/src/transport/submit.js';
import { TraceItXProvider } from '../src/provider.js';
import { useTraceItX } from '../src/hook.js';
import {
  __getCompanionHost,
  createCompanion,
  handleCompanionSubmitText,
  handleCompanionSubmitBinary,
  type RelayWSClient,
  type ReportSubmit,
} from '@traceitx/web';

const submitMock = vi.mocked(submitReportFromDraft);

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input as Request).url;
}

/** Stubs `/api/config` + `/api/reporter/threads` so the real Provider's mount
 *  effects (config provider refresh, thread poller) settle immediately
 *  instead of hitting the network — same pattern as
 *  provider-outbox-drain-identity-gate.spec.tsx. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/reporter/threads')) {
        return new Response(JSON.stringify({ threads: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

function makeWs(): { send: ReturnType<typeof vi.fn>; client: RelayWSClient } {
  const send = vi.fn();
  const client = {
    send,
    sendBinary: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as RelayWSClient;
  return { send, client };
}

function submitMsg(correlationId: string): ReportSubmit {
  return {
    type: 'report.submit',
    correlation_id: correlationId,
    title: 'Broken button',
    description: { text: 'It does nothing', redactions: [] },
    annotations: [],
    includes: { logs: false, network: false, uiTree: false, metadata: false, screenshot: true },
  } as ReportSubmit;
}

// Minimal PNG-magic bytes so sniffImageMime → image/png.
const BAKED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;

const cfg = { apiKey: 'txx_live_companion_user_test' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <TraceItXProvider config={cfg}>{children}</TraceItXProvider>
);

describe('provider.tsx companion host seam — getUser is a live getter, not a mount-time snapshot', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    submitMock.mockReset();
  });

  it('a companion submit reflects setUser called AFTER mount, and a later setUser with no remount', async () => {
    stubFetch();
    submitMock.mockResolvedValue({ ok: true, retryable: false, reportId: 'r1', threadId: null });

    const { result } = renderHook(() => useTraceItX(), { wrapper });

    // Nobody signed in yet — the seam was published at mount, before this.
    act(() => {
      result.current.setUser({ id: 'alice', email: 'alice@x.com' });
    });

    // The seam object itself is read ONCE here (mirroring how the companion
    // singleton reads it per-message) and reused for BOTH submits below —
    // proving the SAME host object's `getUser()` tracks live state rather
    // than a value fixed when the object was constructed.
    const host = __getCompanionHost();
    expect(host).not.toBeNull();
    const companion = createCompanion();

    const first = makeWs();
    handleCompanionSubmitText(submitMsg('c-1'), first.client, host, companion);
    handleCompanionSubmitBinary(BAKED, first.client, host, companion);
    await vi.waitFor(() => expect(first.send).toHaveBeenCalled());

    expect(submitMock.mock.calls[0]![0].user).toEqual({ id: 'alice', email: 'alice@x.com' });

    // Sign out Alice, sign in Bob on the SAME Provider instance — no
    // remount, so provider.tsx's `__setCompanionHost` effect does NOT
    // re-run (its dependency, `ctxValue`, is a single-init useMemo).
    act(() => {
      result.current.setUser({ id: 'bob', email: 'bob@x.com' });
    });

    const second = makeWs();
    handleCompanionSubmitText(submitMsg('c-2'), second.client, host, companion);
    handleCompanionSubmitBinary(BAKED, second.client, host, companion);
    await vi.waitFor(() => expect(second.send).toHaveBeenCalled());

    // Load-bearing: if `getUser` were ever refactored into a captured
    // snapshot (`const u = ...; getUser: () => u`), this call would still
    // report Alice (or `null`, if the snapshot ran before the first
    // `setUser`) — never Bob. Only a live re-read of the WeakMap passes.
    expect(submitMock.mock.calls[1]![0].user).toEqual({ id: 'bob', email: 'bob@x.com' });
  });
});
