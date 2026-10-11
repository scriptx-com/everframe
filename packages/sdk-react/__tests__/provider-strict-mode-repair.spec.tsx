// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// StrictMode runs the Provider's cleanup once right after mounting, which kills
// its client, and the Provider then builds a fresh context. It may rebuild only
// a context that its own cleanup stopped. A kill() from a child's mount effect
// is the host withdrawing consent and stays terminal through later renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useContext, useEffect, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { __internalClientState } from '@everframe/sdk-core';
import { EverframeContext, EverframeProvider, type InternalContext } from '../src/provider.js';
import { useEverframe } from '../src/index.js';

let configFetches: number;

beforeEach(() => {
  localStorage.clear();
  configFetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).includes('/api/config')) configFetches += 1;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const killed = (ctx: InternalContext): boolean => __internalClientState.get(ctx.client)?.killed === true;

/** Records every context the Provider hands to its children. */
function Probe({ seen }: { seen: Set<InternalContext> }) {
  const ctx = useContext(EverframeContext);
  if (ctx) seen.add(ctx);
  return null;
}

/** Withdraws consent from a child mount effect, before the Provider's own effects run. */
function KillOnMount() {
  const { kill } = useEverframe();
  useEffect(() => {
    kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const strict = (children: ReactNode) => (
  <StrictMode>
    <EverframeProvider config={{ sdkKey: 'pk_test' }}>{children}</EverframeProvider>
  </StrictMode>
);

describe('StrictMode repair', () => {
  it('rebuilds the context its own cleanup stopped, once', async () => {
    const seen = new Set<InternalContext>();
    render(strict(<Probe seen={seen} />));
    await settle();

    const contexts = [...seen];
    const live = contexts.filter((ctx) => !killed(ctx));
    expect(live).toHaveLength(1);
    expect(live[0]!.stoppedNormally).toBe(false);
    const stopped = contexts.filter(killed);
    expect(stopped.length).toBeGreaterThan(0);
    for (const ctx of stopped) expect(ctx.stoppedNormally).toBe(true);
  });

  it("keeps a child's kill() terminal through a re-render", async () => {
    const seen = new Set<InternalContext>();
    const tree = () => strict(<><KillOnMount /><Probe seen={seen} /></>);
    const view = render(tree());
    await settle();
    view.rerender(tree());
    await settle();

    const contexts = [...seen];
    expect(contexts).toHaveLength(1);
    expect(killed(contexts[0]!)).toBe(true);
    expect(contexts[0]!.stoppedNormally).toBe(false);
    expect(configFetches).toBe(0);
  });
});
