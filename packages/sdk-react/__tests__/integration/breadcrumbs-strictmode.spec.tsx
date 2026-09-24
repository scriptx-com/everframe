// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Repro for the field bug (2026-07-10): reports submitted from the Next.js
// example (React StrictMode ON, the dev default) ship WITHOUT
// payload.breadcrumbs while the same flow outside StrictMode ships them.
// StrictMode double-invokes the Provider's useMemo factory, so TWO
// adapter+client pairs exist; the module-level forwarding crumb sink keeps
// whichever was bound LAST, while React keeps ONE ctxValue — if they
// disagree, capture writes into a buffer submit never reads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
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

function OpenButton() {
  const { open } = useEverframe();
  return (
    <button type="button" data-testid="host-open" onClick={open}>
      open
    </button>
  );
}

async function envelopeFromIngestCall(body: unknown): Promise<Record<string, any>> {
  // Transport sends multipart FormData with an 'envelope' part (gzipped when
  // CompressionStream exists) or a raw JSON string body.
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

async function submitReportAndCaptureEnvelope(wrapInStrictMode: boolean) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes('/api/config')) {
      return new Response(
        JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

  const app = (
    <EverframeProvider config={{ apiKey: 'txx_live_test', appName: 't', appVersion: '1' }}>
      <div data-testid="surface">app</div>
      <OpenButton />
    </EverframeProvider>
  );
  const { findByTestId } = render(wrapInStrictMode ? <StrictMode>{app}</StrictMode> : app);

  // Generate crumb activity BEFORE the reporter opens: one tap, one console log.
  const surface = await findByTestId('surface');
  await act(async () => {
    fireEvent.pointerDown(surface);
    console.log('crumb: smoke log');
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

  let envelope: Record<string, any> | null = null;
  await waitFor(async () => {
    const call = fetchSpy.mock.calls.find((c) => {
      const arg = c[0];
      const url =
        typeof arg === 'string' ? arg : arg instanceof URL ? arg.href : (arg as Request).url;
      return url.includes('/api/ingest');
    });
    expect(call).toBeTruthy();
    envelope = await envelopeFromIngestCall(call![1]?.body);
  });
  return envelope!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('breadcrumbs survive to the shipped envelope', () => {
  it('without StrictMode (control)', async () => {
    const envelope = await submitReportAndCaptureEnvelope(false);
    expect(envelope.payload.breadcrumbs?.length ?? 0).toBeGreaterThan(0);
  });

  it('with StrictMode (Next.js dev default)', async () => {
    const envelope = await submitReportAndCaptureEnvelope(true);
    expect(envelope.payload.breadcrumbs?.length ?? 0).toBeGreaterThan(0);
  });
});
