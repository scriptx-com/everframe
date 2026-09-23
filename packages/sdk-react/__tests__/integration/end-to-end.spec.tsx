// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
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

import { EverframeProvider } from '../../src/provider.js';
import { useEverframe } from '../../src/hook.js';
import { scopedReporterTokenStorageKey } from '@everframe/web';

function OpenButton() {
  const { open } = useEverframe();
  return (
    <button type="button" data-testid="host-open" onClick={open}>
      open
    </button>
  );
}

/**
 * Reporter identity recognition (spec 2026-08-06) — the ONLY publicly
 * reachable way a host can supply a token is `useEverframe().setIdentityToken`
 * (Critical 2 of the task-14 review: hook.ts didn't expose it at all, so no
 * host on `@everframe/react` could reach the sdk-core client
 * method by any route). Calling it in a mount effect, same shape as
 * `OpenButton` above, mirrors how a real host would call it near app init.
 */
function IdentitySetter({ token }: { token: string }) {
  const { setIdentityToken } = useEverframe();
  useEffect(() => {
    setIdentityToken(token);
  }, [setIdentityToken, token]);
  return null;
}

/**
 * PR review, round 4 (Serious) — like `IdentitySetter`, but surfaces the
 * live `setIdentityToken` function to the TEST via `onReady`, so the test
 * can swap the identity itself mid-flight (simulating an account switch
 * DURING report preparation) rather than only setting it once at mount.
 */
function IdentityController({
  initial,
  onReady,
}: {
  initial: string;
  onReady: (set: (token: string) => void) => void;
}) {
  const { setIdentityToken } = useEverframe();
  useEffect(() => {
    setIdentityToken(initial);
    onReady(setIdentityToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setIdentityToken]);
  return null;
}

const mkJwt = (expSec: number): string => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: expSec })}.sig`;
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
}

/** `GET /api/config` response body — `identity` block present only when `identityEnabled` is passed. */
function configBody(identityEnabled?: boolean): string {
  return JSON.stringify({
    replayEnabled: false,
    replayDurationSec: 30,
    samplingRate: 1,
    ...(identityEnabled !== undefined ? { identity: { enabled: identityEnabled } } : {}),
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Provider end-to-end (jsdom)', () => {
  it('host-triggered open → modal opens → submit calls fetch with /api/ingest', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      // Allow any URL for screenshot lib internals; we only assert ingest call.
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes('/api/ingest')) {
        return new Response('{}', { status: 200 });
      }
      // Default fallthrough — call original (jsdom returns ECONNREFUSED on real network).
      return new Response('', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const { findByTestId } = render(
        <EverframeProvider
          config={{
            apiKey: 'txx_live_test',
            appName: 'test',
            appVersion: '1.0.0',
          }}
        >
          <div>app</div>
          <OpenButton />
        </EverframeProvider>,
      );

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });

      // Wait for capture-pending to clear and inputs to land
      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug X' } });
      });

      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(
        () => {
          const ingestCall = fetchSpy.mock.calls.find((c) => {
            const arg = c[0];
            const url =
              typeof arg === 'string'
                ? arg
                : arg instanceof URL
                  ? arg.href
                  : (arg as Request).url;
            return url.includes('/api/ingest');
          });
          expect(ingestCall).toBeTruthy();
        },
        { timeout: 5000 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * Task 12 — the success toast copy depends on whether the submit outcome
   * carried a thread id. `ingestResponseBody` stands in for the server's
   * ingest response; the two cases below only differ in whether it includes
   * a `thread` block.
   */
  async function renderOpenAndSubmit(ingestResponseBody: string): Promise<ReturnType<typeof render>> {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes('/api/ingest')) {
        return new Response(ingestResponseBody, { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const rendered = render(
      <EverframeProvider
        config={{
          apiKey: 'txx_live_test',
          appName: 'test',
          appVersion: '1.0.0',
        }}
      >
        <div>app</div>
        <OpenButton />
      </EverframeProvider>,
    );

    const opener = await rendered.findByTestId('host-open');
    await act(async () => {
      fireEvent.click(opener);
    });

    const titleInput = (await rendered.findByTestId('report-title')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: 'Bug X' } });
    });

    const submit = await rendered.findByTestId('submit-report');
    await act(async () => {
      fireEvent.click(submit);
    });

    return rendered;
  }

  it('shows the reply-aware success toast when the submit provisions a thread', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const { findByTestId } = await renderOpenAndSubmit('{"thread":{"id":"t1"}}');
      const toast = await findByTestId('everframe-toast', {}, { timeout: 5000 });
      expect(toast.textContent).toBe('Report sent — the team can reply here.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shows the plain success toast when the submit outcome has no thread', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const { findByTestId } = await renderOpenAndSubmit('{}');
      const toast = await findByTestId('everframe-toast', {}, { timeout: 5000 });
      expect(toast.textContent).toBe('Report sent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * PR review Finding 2 — `config.replies.disabled` is documented as a hard
   * local veto: "no polling, no UI, no token presented on submit." Pre-fix,
   * only the thread client honored it; the credential store was still gated
   * solely on the SDK-wide `disabled` flag, so a locally-vetoed client kept
   * presenting/minting a device token on submit — creating server threads it
   * could never display. This exercises the REAL submit pipeline (no mocking
   * of submitReportFromDraft) end to end through the fetch call.
   */
  it('replies.disabled: submit presents no device-token header and localStorage stays untouched', async () => {
    const originalFetch = globalThis.fetch;
    const apiKey = 'txx_live_veto_test';
    const scopedKey = scopedReporterTokenStorageKey(apiKey);
    localStorage.removeItem(scopedKey);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes('/api/ingest')) {
        // Assert the header at the point of the real network call, not on a mock.
        const headers = init?.headers as Record<string, string> | Headers | undefined;
        const tokenHeader =
          headers instanceof Headers ? headers.get('X-Everframe-Device-Token') : headers?.['X-Everframe-Device-Token'];
        expect(tokenHeader).toBeFalsy();
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const { findByTestId } = render(
        <EverframeProvider
          config={{
            apiKey,
            appName: 'test',
            appVersion: '1.0.0',
            replies: { disabled: true },
          }}
        >
          <div>app</div>
          <OpenButton />
        </EverframeProvider>,
      );

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });

      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug X' } });
      });

      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(
        () => {
          const ingestCall = fetchSpy.mock.calls.find((c) => {
            const arg = c[0];
            const url =
              typeof arg === 'string'
                ? arg
                : arg instanceof URL
                  ? arg.href
                  : (arg as Request).url;
            return url.includes('/api/ingest');
          });
          expect(ingestCall).toBeTruthy();
        },
        { timeout: 5000 },
      );

      // No token was ever minted/persisted through the vetoed seam.
      expect(localStorage.getItem(scopedKey)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem(scopedKey);
    }
  });

  /**
   * Finding 1-CLIENT (PR review round 2) — the veto omits the device token
   * on submit, but the server's no-token fallback still provisions a thread
   * and echoes `{ thread, device }` back — it has no way to know the client
   * is locally vetoed. Pre-fix, the Provider's toast branch keyed on
   * `outcome.threadId` alone, so a vetoed client still showed "Report sent —
   * the team can reply here" — a promise it cannot fulfill, since no thread
   * client exists under the veto (`tx.threads` is inert) to ever display
   * that thread. This exercises the REAL submit pipeline end to end: the
   * fix must ignore the server's reply metadata entirely once the veto is
   * active, not just skip sending the token.
   */
  it('replies.disabled: a server-provisioned thread/device block is ignored — plain success toast, no persisted token', async () => {
    const originalFetch = globalThis.fetch;
    const apiKey = 'txx_live_veto_thread_test';
    const scopedKey = scopedReporterTokenStorageKey(apiKey);
    localStorage.removeItem(scopedKey);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes('/api/ingest')) {
        // Server behaves per its documented no-token fallback: mints a
        // thread + device token even though the client sent no header.
        return new Response(
          JSON.stringify({ thread: { id: 't9' }, device: { token: 'evr_' + 'd'.repeat(43) } }),
          { status: 200 },
        );
      }
      return new Response('', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const { findByTestId } = render(
        <EverframeProvider
          config={{
            apiKey,
            appName: 'test',
            appVersion: '1.0.0',
            replies: { disabled: true },
          }}
        >
          <div>app</div>
          <OpenButton />
        </EverframeProvider>,
      );

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });

      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug X' } });
      });

      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      const toast = await findByTestId('everframe-toast', {}, { timeout: 5000 });
      // The plain copy, NOT "Report sent — the team can reply here." — a
      // vetoed client can never display that thread.
      expect(toast.textContent).toBe('Report sent');
      // The server-minted token was never persisted through the vetoed seam.
      expect(localStorage.getItem(scopedKey)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem(scopedKey);
    }
  });

  /**
   * Task 14 review, CRITICAL 1 + 2 — the load-bearing end-to-end assertion.
   * Unit tests on `IdentityTokenHolder` alone (task-14's original submission)
   * proved the holder's expiry/timeout logic but NOT that a real submit
   * through the shipped path (Provider → useEverframe().setIdentityToken →
   * adapter → submit.ts → sdk-core's submitReport → fetch) ever attaches the
   * header — nothing wired the holder into any live call site. This exercises
   * the REAL pipeline end to end, mocking only `fetch`, exactly like the
   * `replies.disabled` tests above.
   *
   * Re-review Finding A — the FIRST version of these tests put the header
   * `expect(...)` INSIDE the fetch mock. A failing assertion there throws
   * inside the mocked `fetch`, which rejects the promise submit.ts/http.ts
   * await — and production swallows exactly that (http.ts's retry catch,
   * thread-client's poll catch). The test body only ever checked "was some
   * /api/ingest call recorded", which stays true even with the header
   * missing entirely — the test could not fail on the thing it claimed to
   * prove. Fixed by capturing the observed header into a plain variable
   * INSIDE the mock (no assertion there) and asserting on that variable in
   * the test body, AFTER the `waitFor` confirms the call happened.
   */
  describe('reporter identity recognition (spec 2026-08-06)', () => {
    it('a real ingest submit carries X-Everframe-Identity-Token when a token is set and recognition is enabled', async () => {
      const originalFetch = globalThis.fetch;
      const jwt = mkJwt(Date.now() / 1000 + 300);
      let observedHeader: string | null | undefined;
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes('/api/config')) {
          return new Response(configBody(/* identityEnabled */ true), { status: 200 });
        }
        if (url.includes('/api/ingest')) {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          observedHeader =
            headers instanceof Headers
              ? headers.get('X-Everframe-Identity-Token')
              : headers?.['X-Everframe-Identity-Token'];
          return new Response('{}', { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
      try {
        const { findByTestId } = render(
          <EverframeProvider
            config={{ apiKey: 'txx_live_identity_on', appName: 'test', appVersion: '1.0.0' }}
          >
            <div>app</div>
            <IdentitySetter token={jwt} />
            <OpenButton />
          </EverframeProvider>,
        );

        // Let the mount-time /api/config fetch (which carries identity.enabled)
        // resolve before submitting, so the gate reads the live value.
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

        // Asserted here, OUTSIDE the mock — see the Finding A comment above.
        expect(observedHeader).toBe(jwt);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('omits the header when no token was ever set, even though recognition is enabled', async () => {
      const originalFetch = globalThis.fetch;
      let observedHeader: string | null | undefined;
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes('/api/config')) {
          return new Response(configBody(/* identityEnabled */ true), { status: 200 });
        }
        if (url.includes('/api/ingest')) {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          observedHeader =
            headers instanceof Headers
              ? headers.get('X-Everframe-Identity-Token')
              : headers?.['X-Everframe-Identity-Token'];
          return new Response('{}', { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
      try {
        const { findByTestId } = render(
          <EverframeProvider
            config={{ apiKey: 'txx_live_identity_no_token', appName: 'test', appVersion: '1.0.0' }}
          >
            <div>app</div>
            <OpenButton />
          </EverframeProvider>,
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

        expect(observedHeader).toBeFalsy();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('omits the header when recognition is disabled (no signing secret), even though a token was set', async () => {
      const originalFetch = globalThis.fetch;
      const jwt = mkJwt(Date.now() / 1000 + 300);
      let observedHeader: string | null | undefined;
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes('/api/config')) {
          // No `identity` block at all — same wire shape as a project with no
          // signing secret configured (config-provider.ts's IdentityConfig is
          // .optional(); absence means OFF).
          return new Response(configBody(/* identityEnabled */ undefined), { status: 200 });
        }
        if (url.includes('/api/ingest')) {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          observedHeader =
            headers instanceof Headers
              ? headers.get('X-Everframe-Identity-Token')
              : headers?.['X-Everframe-Identity-Token'];
          return new Response('{}', { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
      try {
        const { findByTestId } = render(
          <EverframeProvider
            config={{ apiKey: 'txx_live_identity_disabled', appName: 'test', appVersion: '1.0.0' }}
          >
            <div>app</div>
            <IdentitySetter token={jwt} />
            <OpenButton />
          </EverframeProvider>,
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

        expect(observedHeader).toBeFalsy();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * PR review, round 4 (Serious) — the fourth and (per the review) last
     * location of this same class of bug: rounds 2/3 pinned the token used
     * for the drain, then the enqueue, then the live request — but all of
     * that pinning happened INSIDE `submitReportFromDraft`, which itself is
     * only called after `onComplete` (provider.tsx) has already done replay
     * hashing, breadcrumb/network-body snapshotting, and — inside
     * `submitReportFromDraft` itself — the attachment-to-bytes conversion
     * loop (`att.blob.arrayBuffer()`) that feeds `buildMultipart`. Those
     * awaits can span hundreds of milliseconds to seconds for a report
     * carrying a screenshot or replay buffer. An account switch during THAT
     * window pinned the NEW identity to a report the OLD identity created.
     *
     * This drives the REAL end-to-end pipeline (Provider → modal → submit →
     * fetch) and swaps the identity via a spy on `Blob.prototype.arrayBuffer`
     * — the exact call `submitReportFromDraft` makes while converting the
     * screenshot attachment to bytes, i.e. squarely inside the "asynchronous
     * preparation" window the finding describes, and well after
     * `onComplete`'s own submit-boundary capture has already run.
     */
    it('carries the identity captured at the submit boundary, not one that signs in during report preparation', async () => {
      const originalFetch = globalThis.fetch;
      const alice = mkJwt(Date.now() / 1000 + 300);
      // A distinct token (different `sub`) — mkJwt's payload always uses
      // `sub: 'u1'`, so build Bob's by hand to keep the two visibly distinct.
      const bobToken = (() => {
        const b64 = (o: unknown) =>
          btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `${b64({ alg: 'HS256' })}.${b64({ sub: 'bob', exp: Date.now() / 1000 + 300 })}.sig`;
      })();

      let observedHeader: string | null | undefined;
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes('/api/config')) {
          return new Response(configBody(/* identityEnabled */ true), { status: 200 });
        }
        if (url.includes('/api/ingest')) {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          observedHeader =
            headers instanceof Headers
              ? headers.get('X-Everframe-Identity-Token')
              : headers?.['X-Everframe-Identity-Token'];
          return new Response('{}', { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      // Swap the identity on the FIRST Blob.arrayBuffer() call that happens
      // once `armed` — set right before clicking Submit, so the screenshot
      // capture that runs while the modal is merely OPEN can't trip this
      // early. `submitReportFromDraft`'s attachment loop calls this for the
      // screenshot attachment while building the multipart body — squarely
      // inside the preparation window, and after `onComplete`'s boundary
      // capture already ran.
      let armed = false;
      let swapped = false;
      let liveSetIdentityToken: ((token: string) => void) | undefined;
      const originalArrayBuffer = Blob.prototype.arrayBuffer;
      const arrayBufferSpy = vi
        .spyOn(Blob.prototype, 'arrayBuffer')
        .mockImplementation(async function (this: Blob): Promise<ArrayBuffer> {
          if (armed && !swapped && liveSetIdentityToken) {
            swapped = true;
            liveSetIdentityToken(bobToken); // the account switch, mid-preparation
          }
          return originalArrayBuffer.call(this);
        });

      try {
        const { findByTestId } = render(
          <EverframeProvider
            config={{ apiKey: 'txx_live_identity_boundary', appName: 'test', appVersion: '1.0.0' }}
          >
            <div>app</div>
            <IdentityController
              initial={alice}
              onReady={(set) => { liveSetIdentityToken = set; }}
            />
            <OpenButton />
          </EverframeProvider>,
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

        // NOW arm the swap — everything before this point (screenshot capture
        // while the modal opened) must not trigger it.
        armed = true;
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

        // The swap really happened during preparation — otherwise this test
        // proves nothing.
        expect(swapped).toBe(true);
        // The load-bearing assertion, checked AFTER the submit resolved and
        // OUTSIDE any mock: pre-fix, this was Bob's token (re-resolved deep
        // inside submitReportFromDraft, after the swap). Fixed, it's Alice's
        // — captured at the true submit boundary, before preparation began.
        expect(observedHeader).toBe(alice);
        expect(observedHeader).not.toBe(bobToken);
      } finally {
        globalThis.fetch = originalFetch;
        arrayBufferSpy.mockRestore();
      }
    });
  });
});
