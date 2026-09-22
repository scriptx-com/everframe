// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Host-supplied breadcrumb markers on the web SDK. `TraceItXClient
// .addBreadcrumb` has always existed in sdk-core (redaction-passed,
// size-capped, safeWrap'd); these tests pin the two public routes to it —
// `useTraceItX().addBreadcrumb` inside the tree, and the top-level
// `addBreadcrumb` export for non-component call sites.
//
// The motivating case is navigation: web auto-capture patches the History
// API, so a hash-router app (or any router that navigates without changing
// `pathname + search`) emits no `navigation` crumbs and has, until now, had
// no way to supply them. Mirrors @traceitx/react-native's seam.
import { describe, expect, it } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { useContext, type ReactNode } from 'react';
import { __internalClientState } from '@traceitx/sdk-core';
import type { TraceItXClient } from '@traceitx/sdk-core';
import { TraceItXProvider, TraceItXContext } from '../src/provider.js';
import { useTraceItX } from '../src/hook.js';
import { addBreadcrumb } from '../src/contextSeam.js';

const cfg = { apiKey: 'txx_live_test' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <TraceItXProvider config={cfg}>{children}</TraceItXProvider>
);

// This project's vitest setup does not enable `globals`, so testing-library's
// auto-cleanup is not registered. The context seam is single-instance and
// clears on unmount, so a leaked tree makes every later provider be rejected —
// hence the explicit unmount in each test below.
describe('useTraceItX().addBreadcrumb', () => {
  it('is part of the public hook surface', () => {
    const { result, unmount } = renderHook(() => useTraceItX(), { wrapper });
    expect(typeof result.current.addBreadcrumb).toBe('function');
    unmount();
  });

  it('accepts a navigation marker without throwing', () => {
    const { result, unmount } = renderHook(() => useTraceItX(), { wrapper });
    expect(() =>
      result.current.addBreadcrumb({
        kind: 'navigation',
        message: 'Home → Checkout',
        data: { from: 'Home', to: 'Checkout' },
      }),
    ).not.toThrow();
    unmount();
  });
});

describe('top-level addBreadcrumb', () => {
  it('no-ops when no provider is mounted', () => {
    // Matches setExtra/attachReactTree on RN: a marker from a module-scope
    // call site that runs before mount must never throw. Only `open()`
    // rejects, because a caller awaiting a report needs to know it failed.
    expect(() => addBreadcrumb({ message: 'too early' })).not.toThrow();
  });

  it('routes into the mounted provider’s live client', () => {
    // Reads the crumb back off the provider's OWN client, so this fails if the
    // seam is wired to a different client instance or silently swallowed —
    // which a "does not throw" assertion could never catch.
    let client: TraceItXClient | undefined;
    const Probe = () => {
      client = useContext(TraceItXContext)?.client;
      return null;
    };
    const { unmount } = render(
      <TraceItXProvider config={cfg}>
        <Probe />
      </TraceItXProvider>,
    );

    addBreadcrumb({ kind: 'navigation', message: 'A → B', data: { from: 'A', to: 'B' } });

    const buf = __internalClientState.get(client!)!.breadcrumbs;
    buf.freeze();
    expect(buf.takeFrozen() ?? []).toMatchObject([
      { kind: 'navigation', message: 'A → B', data: { from: 'A', to: 'B' } },
    ]);
    unmount();
  });
});
