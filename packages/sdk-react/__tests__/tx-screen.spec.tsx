// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { __setCurrentContext } from '../src/contextSeam.js';
import { TXScreen, useTXScreen } from '../src/TXScreen.js';

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

function Probe({ name, focused }: { name: string; focused?: boolean }) {
  useTXScreen(name, focused === undefined ? undefined : { focused });
  return null;
}

describe('useTXScreen', () => {
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

describe('TXScreen', () => {
  it('renders nothing and marks the screen', () => {
    const { container } = render(<TXScreen name="Home" />);
    expect(container.innerHTML).toBe('');
    expect(seen).toEqual([['Home', undefined]]);
  });
});
