// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// PR review, round 5 (Serious) — the load-bearing test for the fifth (and,
// per the review, last) location of this same class of bug. Round 4 added
// `WebPlatformAdapter.__captureIdentityAtSubmitBoundary()` and called it as
// the first statement of provider.tsx's `onComplete` — but `onComplete` is
// only reachable once `ReporterDialog.onSubmit` has ALREADY finished its own
// prep: for any annotated screenshot (blur/arrow/stroke — the most common
// reporter flow), that prep includes `bakeAnnotations` (createImageBitmap +
// a full-resolution canvas draw + PNG re-encode) and `sha256Hex`, an await
// that can cost hundreds of milliseconds to seconds. Round 4's e2e test used
// an UN-annotated screenshot, so `onSubmit` had no await before calling
// `onComplete` and could never have observed this gap.
//
// The fix moved the capture to the literal top of `onSubmit` (before the
// per-shot bake loop) and threads it through `ReporterCompletePayload
// .capturedIdentityToken`, which `onComplete` now prefers over its own
// (later, fallback-only) capture.
//
// This test drives the real `TraceItXProvider` + `ReporterDialog` pipeline,
// adds a real annotation to the captured screenshot (via a mocked
// `AnnotateScreenshot` — real Konva canvas interaction is out of scope for
// this test; the "Annotate screenshot" UI is fully covered elsewhere), and
// mocks `bakeAnnotations` to swap the identity source (Alice → Bob) WHILE
// its promise is in flight — i.e. during the real await window `onSubmit`
// has for an annotated shot. Asserts the ingest request nonetheless carries
// Alice's token, checked in the test body after `waitFor`, never inside the
// fetch mock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { cleanup, render, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-konva', () => ({
  Stage: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div data-testid="konva-stage" {...rest}>
      {children}
    </div>
  ),
  Layer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="konva-layer">{children}</div>
  ),
  Line: () => <div data-testid="konva-line" />,
  Rect: () => <div data-testid="konva-rect" />,
  Image: () => <div data-testid="konva-image" />,
}));

// Swapped in per-test via `bakeAnnotationsImpl.mockImplementation(...)`.
const bakeAnnotationsImpl = vi.fn(async (source: Blob) => source);
vi.mock('../../../sdk-web/src/reporter-ui/BlurBakery.js', () => ({
  bakeAnnotations: (...args: unknown[]) =>
    (bakeAnnotationsImpl as unknown as (...a: unknown[]) => Promise<Blob>)(...args),
}));

// Mocks the interactive canvas UI away — this test is about SUBMIT TIMING,
// not annotation drawing (covered by AnnotateCanvas.spec.tsx). Exposes a
// single button that hands the dialog a real blur annotation, which is all
// `onSubmit` needs to take the `bakeAnnotations` branch for real.
vi.mock('../../../sdk-web/src/reporter-ui/AnnotateScreenshot.js', () => ({
  AnnotateScreenshot: ({ onChange }: { onChange: (a: unknown[]) => void }) => (
    <button
      type="button"
      data-testid="mock-add-blur-annotation"
      onClick={() =>
        onChange([{ id: 'a1', kind: 'blur', x: 0, y: 0, width: 10, height: 10 }])
      }
    >
      add blur
    </button>
  ),
}));

import { TraceItXProvider } from '../../src/provider.js';
import { useTraceItX } from '../../src/hook.js';

function OpenButton() {
  const { open } = useTraceItX();
  return (
    <button type="button" data-testid="host-open" onClick={open}>
      open
    </button>
  );
}

/** Same as end-to-end.spec.tsx's `IdentityController` — surfaces the live
 *  `setIdentityToken` function to the test so it can swap mid-flight. */
function IdentityController({
  initial,
  onReady,
}: {
  initial: string;
  onReady: (set: (token: string) => void) => void;
}) {
  const { setIdentityToken } = useTraceItX();
  useEffect(() => {
    setIdentityToken(initial);
    onReady(setIdentityToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setIdentityToken]);
  return null;
}

function mkJwt(sub: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Date.now() / 1000 + 300 })}.sig`;
}

/** Surfaces the live `setUser` function so a test can switch accounts
 *  mid-flight, exactly as `IdentityController` does for the token. */
function UserController({
  initial,
  onReady,
}: {
  initial: { id: string };
  onReady: (set: (u: { id: string }) => void) => void;
}) {
  const { setUser } = useTraceItX();
  useEffect(() => {
    setUser(initial);
    onReady(setUser);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setUser]);
  return null;
}

/** Same decoder `breadcrumbs-strictmode.spec.tsx` uses: the transport sends
 *  multipart FormData with an `envelope` part, gzipped when CompressionStream
 *  exists. */
async function envelopeFromIngestCall(body: unknown): Promise<Record<string, any>> {
  if (typeof body === 'string') return JSON.parse(body);
  const fd = body as FormData;
  const part = fd.get('envelope');
  if (typeof part === 'string') return JSON.parse(part);
  const blob = part as Blob;
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
    return JSON.parse(text);
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
}

function configBody(identityEnabled: boolean): string {
  return JSON.stringify({
    replayEnabled: false,
    replayDurationSec: 30,
    samplingRate: 1,
    identity: { enabled: identityEnabled },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  bakeAnnotationsImpl.mockReset();
  bakeAnnotationsImpl.mockImplementation(async (source: Blob) => source);
});

describe('ReporterDialog submit boundary (PR review round 5, Serious)', () => {
  it('carries the identity captured before bakeAnnotations, not one that signs in during the bake', async () => {
    const alice = mkJwt('alice-sub');
    const bob = mkJwt('bob-sub');

    let liveSetIdentityToken: ((token: string) => void) | undefined;
    let swapped = false;

    // The bake await is REAL from onSubmit's perspective (it's genuinely
    // awaited); this mock controls its timing/outcome so the swap
    // deterministically happens WHILE it's in flight, then resolves.
    bakeAnnotationsImpl.mockImplementation(async (source: Blob) => {
      // Yield once so this really is "during" an in-flight await, not
      // synchronous with the call that started it.
      await Promise.resolve();
      swapped = true;
      liveSetIdentityToken?.(bob);
      return source;
    });

    let observedHeader: string | null | undefined;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(configBody(true), { status: 200 });
      }
      if (url.includes('/api/ingest')) {
        const headers = init?.headers as Record<string, string> | Headers | undefined;
        observedHeader =
          headers instanceof Headers
            ? headers.get('X-TX-Identity-Token')
            : headers?.['X-TX-Identity-Token'];
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const { findByTestId } = render(
        <TraceItXProvider
          config={{ apiKey: 'txx_live_dialog_boundary', appName: 'test', appVersion: '1.0.0' }}
        >
          <div>app</div>
          <IdentityController initial={alice} onReady={(set) => { liveSetIdentityToken = set; }} />
          <OpenButton />
        </TraceItXProvider>,
      );

      await waitFor(() => {
        expect(fetchSpy.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/config'))).toBe(true);
      });

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });

      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug X' } });
      });

      // Add a real annotation so onSubmit's per-shot loop takes the
      // bakeAnnotations branch.
      const addAnnotation = await findByTestId('mock-add-blur-annotation');
      await act(async () => {
        fireEvent.click(addAnnotation);
      });

      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(
        () => {
          const ingestCall = fetchSpy.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/ingest'));
          expect(ingestCall).toBeTruthy();
        },
        { timeout: 5000 },
      );

      // The swap really happened during the bake — otherwise this test
      // proves nothing.
      expect(swapped).toBe(true);
      expect(bakeAnnotationsImpl).toHaveBeenCalled();
      // The load-bearing assertion, checked AFTER the submit resolved and
      // OUTSIDE any mock.
      expect(observedHeader).toBe(alice);
      expect(observedHeader).not.toBe(bob);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // External review, finding 1 (Serious) — the SELF-DECLARED USER (`setUser`)
  // had the identical gap this suite's first test locks for the identity
  // token: provider.tsx read `__internalClientState.get(client)?.user` at the
  // `submitReportFromDraft` call, i.e. AFTER the dialog's annotation bake,
  // replay hashing and breadcrumb/network-body snapshotting had all already
  // been awaited. Account A files a report, the host switches to account B
  // while the bake runs, and A's report ships attributed to B.
  //
  // Same mechanism as the test above (swap mid-`bakeAnnotations`), but the
  // assertion reads the envelope's `reporter.user` rather than the identity
  // header — and `identity.enabled` is deliberately FALSE here, with no
  // identity token ever set, to lock the second half of the fix: the user's
  // capture must NOT inherit the token capture's fail-closed
  // `identity.enabled` gate. `setUser` is an unverified host-supplied label,
  // not a credential the server has to be configured to verify, so it ships
  // whether or not identity recognition is enabled server-side.
  it('carries the user captured before bakeAnnotations, not one who signs in during the bake', async () => {
    let liveSetUser: ((u: { id: string }) => void) | undefined;
    let swapped = false;

    bakeAnnotationsImpl.mockImplementation(async (source: Blob) => {
      await Promise.resolve();
      swapped = true;
      liveSetUser?.({ id: 'bob' });
      return source;
    });

    let ingestBody: unknown;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(configBody(false), { status: 200 });
      }
      if (url.includes('/api/ingest')) {
        ingestBody = init?.body;
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const { findByTestId } = render(
        <TraceItXProvider
          config={{ apiKey: 'txx_live_dialog_user_boundary', appName: 'test', appVersion: '1.0.0' }}
        >
          <div>app</div>
          <UserController initial={{ id: 'alice' }} onReady={(set) => { liveSetUser = set; }} />
          <OpenButton />
        </TraceItXProvider>,
      );

      await waitFor(() => {
        expect(fetchSpy.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/config'))).toBe(true);
      });

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });

      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug Y' } });
      });

      const addAnnotation = await findByTestId('mock-add-blur-annotation');
      await act(async () => {
        fireEvent.click(addAnnotation);
      });

      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(
        () => {
          expect(ingestBody).toBeTruthy();
        },
        { timeout: 5000 },
      );

      // The swap really happened during the bake — otherwise this test proves
      // nothing.
      expect(swapped).toBe(true);
      expect(bakeAnnotationsImpl).toHaveBeenCalled();
      const envelope = await envelopeFromIngestCall(ingestBody);
      expect(envelope.reporter?.user).toEqual({ id: 'alice' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // The clone half of the same finding: capturing the host's own object by
  // reference would let a mutation during that prep window silently change
  // what ships, even with no `setUser` call at all. `UserMetadata` is flat, so
  // a shallow copy at capture time is enough — this proves one was taken.
  it('ships the user as captured even if the host mutates its own object during the bake', async () => {
    const hostUser = { id: 'alice', email: 'alice@x.com' };
    let mutated = false;

    bakeAnnotationsImpl.mockImplementation(async (source: Blob) => {
      await Promise.resolve();
      hostUser.id = 'bob';
      hostUser.email = 'bob@x.com';
      mutated = true;
      return source;
    });

    let ingestBody: unknown;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) return new Response(configBody(false), { status: 200 });
      if (url.includes('/api/ingest')) {
        ingestBody = init?.body;
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const { findByTestId } = render(
        <TraceItXProvider
          config={{ apiKey: 'txx_live_dialog_user_clone', appName: 'test', appVersion: '1.0.0' }}
        >
          <div>app</div>
          <UserController initial={hostUser} onReady={() => undefined} />
          <OpenButton />
        </TraceItXProvider>,
      );

      await waitFor(() => {
        expect(fetchSpy.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/config'))).toBe(true);
      });

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });
      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug Z' } });
      });
      const addAnnotation = await findByTestId('mock-add-blur-annotation');
      await act(async () => {
        fireEvent.click(addAnnotation);
      });
      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(() => {
        expect(ingestBody).toBeTruthy();
      }, { timeout: 5000 });

      expect(mutated).toBe(true);
      const envelope = await envelopeFromIngestCall(ingestBody);
      expect(envelope.reporter?.user).toEqual({ id: 'alice', email: 'alice@x.com' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // External review, finding 1 (Serious) — the REPORT path's projection half
  // (the crash path's is in crash-reporting.spec.ts). `UserMetadata` is a
  // TypeScript interface with no runtime existence, so `tx.setUser(currentUser)`
  // — handing over the app's OWN user object, the most natural call a developer
  // writes — type-checked and shipped every other property on it into the
  // envelope, and from there into durable outboxes, event storage, admin API
  // responses and outbound webhooks. Asserted end-to-end on the real ingest
  // body rather than on the projection helper alone, because the whole point
  // of the finding is that a helper looked like a projection (`{ ...live }`)
  // and was not one.
  it('ships only id/email/displayName when the host hands setUser its own user object', async () => {
    const hostUser = {
      id: 'alice',
      email: 'alice@x.com',
      displayName: 'Alice',
      accessToken: 'secret-token',
      profile: { address: '1 Main St', dob: '1990-01-01' },
      roles: ['admin', 'billing'],
      loginCount: 7,
    } as unknown as { id: string };

    let ingestBody: unknown;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) return new Response(configBody(false), { status: 200 });
      if (url.includes('/api/ingest')) {
        ingestBody = init?.body;
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const { findByTestId } = render(
        <TraceItXProvider
          config={{ apiKey: 'txx_live_dialog_user_projection', appName: 'test', appVersion: '1.0.0' }}
        >
          <div>app</div>
          <UserController initial={hostUser} onReady={() => undefined} />
          <OpenButton />
        </TraceItXProvider>,
      );

      await waitFor(() => {
        expect(fetchSpy.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/config'))).toBe(true);
      });

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });
      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug W' } });
      });
      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(() => {
        expect(ingestBody).toBeTruthy();
      }, { timeout: 5000 });

      const envelope = await envelopeFromIngestCall(ingestBody);
      expect(envelope.reporter?.user).toEqual({
        id: 'alice',
        email: 'alice@x.com',
        displayName: 'Alice',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
