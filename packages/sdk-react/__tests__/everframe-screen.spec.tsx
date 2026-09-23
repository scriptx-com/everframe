// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { __setCurrentContext } from '../src/contextSeam.js';
import { EverframeScreen, useEverframeScreen } from '../src/EverframeScreen.js';
import * as reactSdk from '../src/index.js';

const seen: Array<[string, unknown]> = [];

beforeEach(() => {
  seen.length = 0;
  __setCurrentContext({
    open: () => Promise.reject(new Error('unused')),
    addBreadcrumb: () => undefined,
    captureException: () => undefined,
    setUser: () => undefined,
    setExtra: () => undefined,
    recordScreen: (name, data) => seen.push([name, data]),
  });
});

describe('@everframe/react screen surface', () => {
  it('exports only the canonical Everframe screen API', () => {
    const surface = reactSdk as unknown as Record<string, unknown>;
    expect(typeof surface['EverframeScreen']).toBe('function');
    expect(typeof surface['useEverframeScreen']).toBe('function');
    expect('TXScreen' in surface).toBe(false);
    expect('useTXScreen' in surface).toBe(false);
  });
});

function Probe({ name, focused }: { name: string; focused?: boolean }) {
  useEverframeScreen(name, focused === undefined ? undefined : { focused });
  return null;
}

describe('useEverframeScreen', () => {
  it('marks the screen on mount when focused defaults to true', () => {
    render(<Probe name="Home" />);
    expect(seen).toEqual([['Home', undefined]]);
  });

  it('does not mark while unfocused, then marks when focus arrives', () => {
    const { rerender } = render(<Probe name="Home" focused={false} />);
    expect(seen).toEqual([]);
    rerender(<Probe name="Home" focused />);
    expect(seen).toEqual([['Home', undefined]]);
  });

  it('re-marks when the name changes', () => {
    const { rerender } = render(<Probe name="Home" />);
    rerender(<Probe name="Settings" />);
    expect(seen).toEqual([['Home', undefined], ['Settings', undefined]]);
  });
});

describe('EverframeScreen', () => {
  it('renders nothing and marks the screen', () => {
    const { container } = render(<EverframeScreen name="Home" />);
    expect(container.innerHTML).toBe('');
    expect(seen).toEqual([['Home', undefined]]);
  });
});
