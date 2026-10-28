// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// `reportRoute` decides the route an error report carries. It is called at
// capture time with the live path, so an app whose URLs carry credentials can
// send a shape (or nothing) even for an error that lands mid-navigation.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEnvelope } from '@everframe/protocol';
import { init, type Everframe } from '../src/index.js';

let handle: Everframe | undefined;
let sent: ReportEnvelope[];

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, options?: RequestInit) => {
      if (String(url).endsWith('/api/ingest')) {
        const body = options?.body as FormData;
        const envelope = ReportEnvelope.parse(
          JSON.parse(await (body.get('envelope') as Blob).text()),
        );
        if (!sent.some((e) => e.reportId === envelope.reportId)) sent.push(envelope);
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  sent = [];
  history.replaceState(null, '', '/invite/abcdefghijklmnopqrstuvwx');
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  history.replaceState(null, '', '/');
  localStorage.clear();
});

const shape = (path: string) => path.replace(/^\/invite\/[^/]+/, '/invite/:id');

async function capture(error: Error): Promise<ReportEnvelope> {
  handle!.captureException(error);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return sent[0]!;
}

describe('reportRoute', () => {
  it('sends the path as is by default', async () => {
    handle = init({ sdkKey: 'evf_live_reportroute0000000000', reporter: { disabled: true } });
    const report = await capture(new Error('default'));
    expect(report.context.route).toBe('/invite/abcdefghijklmnopqrstuvwx');
  });

  it('sends what reportRoute makes of the path', async () => {
    const reportRoute = vi.fn(shape);
    handle = init({
      sdkKey: 'evf_live_reportroute0000000000',
      reporter: { disabled: true },
      reportRoute,
    });
    const report = await capture(new RangeError('shaped'));
    expect(reportRoute).toHaveBeenCalledWith('/invite/abcdefghijklmnopqrstuvwx');
    expect(report.context.route).toBe('/invite/:id');
    expect(JSON.stringify(report)).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('sends no route when reportRoute returns null', async () => {
    handle = init({
      sdkKey: 'evf_live_reportroute0000000000',
      reporter: { disabled: true },
      reportRoute: () => null,
    });
    const report = await capture(new TypeError('no route'));
    expect(report.context.route).toBeUndefined();
  });

  it('sends no route when reportRoute throws, and still reports', async () => {
    handle = init({
      sdkKey: 'evf_live_reportroute0000000000',
      reporter: { disabled: true },
      reportRoute: () => {
        throw new Error('mapper bug');
      },
    });
    const report = await capture(new SyntaxError('mapper threw'));
    expect(report.context.route).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('reads the live path at capture time (an error mid-navigation)', async () => {
    history.replaceState(null, '', '/apps');
    handle = init({
      sdkKey: 'evf_live_reportroute0000000000',
      reporter: { disabled: true },
      reportRoute: shape,
      // The SDK's own navigation crumb would record the new URL itself; an app
      // with credential URLs turns that kind off (breadcrumbs.kinds).
      breadcrumbs: { kinds: ['error'] },
    });
    history.pushState(null, '', '/invite/zyxwvutsrqponmlkjihgfedc');
    const error = new EvalError('mid-navigation');
    window.onerror?.('mid-navigation', 'app.js', 1, 1, error);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.context.route).toBe('/invite/:id');
    expect(JSON.stringify(sent[0])).not.toContain('zyxwvutsrqponmlkjihgfedc');
  });
});
