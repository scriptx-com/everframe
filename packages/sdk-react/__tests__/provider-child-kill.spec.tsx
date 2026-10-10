// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// A host child can withdraw consent from its own mount effect, which React
// runs before the Provider's. That kill must stay terminal: the Provider's
// later mount effects must not revive crash or breadcrumb capture, fetch
// config, or deliver reports queued before the kill. Under StrictMode the
// discarded adapter twin bound the page-global capture slots last during
// render, so the committed adapter still has to take them back, dead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useContext, useEffect, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { __internalClientState } from '@everframe/sdk-core';
import { ReportEnvelope } from '@everframe/protocol';
import { EverframeContext, EverframeProvider, type InternalContext } from '../src/provider.js';
import { captureException, useEverframe } from '../src/index.js';

let ingestStatus: number;
let ingestAttempts: number;
let configFetches: number;
let delivered: ReportEnvelope[];

beforeEach(() => {
  localStorage.clear();
  ingestStatus = 200;
  ingestAttempts = 0;
  configFetches = 0;
  delivered = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, options?: RequestInit) => {
    const href = String(url);
    if (href.includes('/api/config')) configFetches += 1;
    if (href.endsWith('/api/ingest')) {
      ingestAttempts += 1;
      if (ingestStatus === 200) {
        const part = (options!.body as FormData).get('envelope') as Blob;
        delivered.push(ReportEnvelope.parse(JSON.parse(await part.text())));
      }
    }
    return new Response('{}', { status: ingestStatus, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function errorAt(name: string): Error {
  const error = new Error(`${name} failed`);
  error.stack = `Error: ${name} failed\n    at ${name} (app.js:1:250)`;
  return error;
}

/** Withdraws consent from a child mount effect, before the Provider's own effects run. */
function KillOnMount({ onContext }: { onContext: (ctx: InternalContext) => void }) {
  const ctx = useContext(EverframeContext);
  const { kill } = useEverframe();
  useEffect(() => {
    onContext(ctx!);
    kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function mount(children: ReactNode, strict: boolean) {
  const tree = <EverframeProvider config={{ sdkKey: 'pk_test' }}>{children}</EverframeProvider>;
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('a kill() from a child mount effect stays terminal', () => {
  it.each([false, true])('captures no crash or breadcrumb and fetches no config (StrictMode=%s)', async (strict) => {
    let ctx: InternalContext | undefined;
    mount(<KillOnMount onContext={(value) => { ctx = value; }} />, strict);
    expect(__internalClientState.get(ctx!.client)?.killed).toBe(true);

    console.log('crumb after kill');
    const error = errorAt('afterKill');
    window.onerror?.(error.message, 'app.js', 1, 250, error);
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(ingestAttempts).toBe(0);
    expect(__internalClientState.get(ctx!.client)?.breadcrumbs.snapshot()).toEqual([]);
    expect(configFetches).toBe(0);
  });

  it.each([false, true])('does not deliver reports queued before the kill (StrictMode=%s)', async (strict) => {
    ingestStatus = 503;
    const earlier = mount(<span />, false);
    captureException(errorAt('queuedBeforeKill'));
    await vi.waitFor(() => expect(ingestAttempts).toBeGreaterThan(0));
    earlier.unmount();
    await settle();

    ingestStatus = 200;
    const attemptsBeforeKill = ingestAttempts;
    let ctx: InternalContext | undefined;
    mount(<KillOnMount onContext={(value) => { ctx = value; }} />, strict);
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(ingestAttempts).toBe(attemptsBeforeKill);
    expect(delivered).toEqual([]);
    // The queued report is withheld, not lost: the zero above is not vacuous.
    expect(await ctx!.adapter.outbox!.list()).toHaveLength(1);
  });
});
