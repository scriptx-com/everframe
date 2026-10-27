// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// `breadcrumbs.kinds` is a client veto over the SDK's own breadcrumbs: the
// effective set is the host's list intersected with the dashboard's. Hosts
// that render credentials (tokens on buttons, tokens in API paths) use it to
// keep tap and network crumbs off whatever the dashboard says.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEnvelope } from '@everframe/protocol';
import { init, type Everframe } from '../src/index.js';

let handle: Everframe | undefined;
let sent: ReportEnvelope[];
let serverConfig: Record<string, unknown>;

// One fetch stub for the whole file: the SDK patches fetch once per page, so a
// stub swapped per test would drop the patched wrapper (and its crumbs).
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, options?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/config')) {
        return new Response(JSON.stringify(serverConfig), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/api/ingest')) {
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
  serverConfig = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

async function activity(): Promise<void> {
  await fetch('/api/v1/invites/abcdefghijklmnopqrstuvwx');
  document.body.innerHTML = '<button id="b">tok_secret</button>';
  document.getElementById('b')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  history.pushState(null, '', '/somewhere?token=abc');
  history.pushState(null, '', '/elsewhere');
  window.dispatchEvent(new PopStateEvent('popstate'));
  document.dispatchEvent(new Event('visibilitychange'));
}

async function reportKinds(): Promise<string[]> {
  handle!.captureException(new Error('boom'));
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return (sent[0]!.payload.breadcrumbs ?? []).map((b) => b.kind);
}

describe('breadcrumbs.kinds client veto', () => {
  it('records only the listed kinds on its own; addBreadcrumb is unaffected', async () => {
    handle = init({
      sdkKey: 'evf_live_kindsveto000000000000',
      reporter: { disabled: true },
      breadcrumbs: { kinds: ['lifecycle', 'error'] },
    });
    await settle();
    await activity();
    handle.addBreadcrumb({ kind: 'navigation', message: '/apps/:id' });
    handle.addBreadcrumb({ message: 'custom note' });

    const kinds = await reportKinds();
    expect(kinds).toContain('lifecycle');
    expect(kinds).toContain('navigation');
    expect(kinds).toContain('custom');
    expect(kinds).not.toContain('tap');
    expect(kinds).not.toContain('network');
    const text = JSON.stringify(sent[0]!.payload.breadcrumbs);
    expect(text).not.toContain('tok_secret');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(text).not.toContain('token=abc');
  });

  it('cannot turn on a kind the dashboard has off', async () => {
    serverConfig = {
      ...serverConfig,
      breadcrumbs: {
        enabled: true,
        kinds: ['error'],
        maxCount: 100,
        byteBudget: 32768,
        consoleEntryCap: 250,
      },
    };
    handle = init({
      sdkKey: 'evf_live_kindsveto000000000000',
      reporter: { disabled: true },
      breadcrumbs: { kinds: ['lifecycle', 'tap', 'error'] },
    });
    await settle();
    await activity();

    const kinds = await reportKinds();
    expect(kinds).not.toContain('lifecycle');
    expect(kinds).not.toContain('tap');
  });

  it('keeps the dashboard set when unset', async () => {
    handle = init({ sdkKey: 'evf_live_kindsveto000000000000', reporter: { disabled: true } });
    await settle();
    await activity();

    const kinds = await reportKinds();
    expect(kinds).toContain('tap');
    expect(kinds).toContain('network');
  });
});
