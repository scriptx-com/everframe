// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EverframeProvider } from '../src/provider.js';
import { useEverframe } from '../src/hook.js';

const cfg = { apiKey: 'txx_live_test' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <EverframeProvider config={cfg}>{children}</EverframeProvider>
);

describe('EverframeProvider', () => {
  it('renders children without throwing', () => {
    const { getByText } = render(
      <EverframeProvider config={cfg}>
        <div>hello world</div>
      </EverframeProvider>,
    );
    expect(getByText('hello world')).toBeInTheDocument();
  });

  it('useEverframe returns the public surface inside the Provider', () => {
    const { result } = renderHook(() => useEverframe(), { wrapper });
    expect(typeof result.current.open).toBe('function');
    expect(typeof result.current.setUser).toBe('function');
    expect(typeof result.current.setExtra).toBe('function');
    expect(typeof result.current.markSensitive).toBe('function');
    expect(typeof result.current.kill).toBe('function');
    // Flat surface — no .report.* nesting (matches sdk-react-native v0.3+).
    expect((result.current as unknown as { report?: unknown }).report).toBeUndefined();
  });

  it('useEverframe outside Provider throws', () => {
    expect(() => renderHook(() => useEverframe())).toThrow(/outside <EverframeProvider>/);
  });
});
