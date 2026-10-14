// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EverframeProvider } from '../src/EverframeProvider.js';
import { useEverframeTarget } from '../src/useEverframeTarget.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { __setCurrentContext } from '../src/contextSeam.js';

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  __setCurrentContext(null);
  vi.restoreAllMocks();
});
function Control({
  name = 'Original',
  onPress = () => {},
}: {
  name?: string;
  onPress?: () => void;
}) {
  const ref = useEverframeTarget<HTMLButtonElement>(name ? { name } : undefined);
  return (
    <button ref={ref} onClick={onPress}>
      Press
    </button>
  );
}
function Provider({ children }: { children: React.ReactNode }) {
  return (
    <EverframeProvider config={{ sdkKey: 'txx_test', crashReporting: { disabled: true } }}>
      {children}
    </EverframeProvider>
  );
}
it('does nothing without a provider', () => {
  render(<Control />);
  expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
});
it('registers after provider startup, updates without layout, and leaves press semantics alone', () => {
  const press = vi.fn();
  const tree = render(
    <Provider>
      <Control onPress={press} />
    </Provider>,
  );
  expect(NativeEverframe.setInteractionTarget).toHaveBeenLastCalledWith(
    12,
    expect.any(String),
    expect.any(Number),
    { name: 'Original' },
  );
  const set = vi.mocked(NativeEverframe.setInteractionTarget),
    first = set.mock.calls.at(-1)!;
  tree.rerender(
    <Provider>
      <Control name="Continue" onPress={press} />
    </Provider>,
  );
  expect(set.mock.calls.at(-1)![2]).toBeGreaterThan(first[2]);
  expect(set.mock.calls.at(-1)![3]).toEqual({ name: 'Continue' });
  fireEvent.click(tree.getByText('Press'));
  expect(press).toHaveBeenCalledTimes(1);
  expect(NativeEverframe.addBreadcrumb).not.toHaveBeenCalled();
  tree.rerender(
    <Provider>
      <Control name="" />
    </Provider>,
  );
  expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalled();
});
it('StrictMode replay and unmount clear every live registration', () => {
  const tree = render(
    <React.StrictMode>
      <Provider>
        <Control />
      </Provider>
    </React.StrictMode>,
  );
  tree.unmount();
  const sets = vi.mocked(NativeEverframe.setInteractionTarget).mock.calls;
  const clears = vi.mocked(NativeEverframe.clearInteractionTarget).mock.calls;
  for (const set of sets) expect(clears.some((c) => c[0] === set[1] && c[1] > set[2])).toBe(true);
});
it('an abandoned Suspense render does not publish new metadata', () => {
  let suspend = false;
  function Child() {
    const ref = useEverframeTarget<HTMLButtonElement>({
      name: suspend ? 'Uncommitted' : 'Committed',
    });
    if (suspend) throw new Promise(() => {});
    return <button ref={ref} />;
  }
  const tree = render(
    <Provider>
      <React.Suspense fallback="Loading">
        <Child />
      </React.Suspense>
    </Provider>,
  );
  vi.mocked(NativeEverframe.setInteractionTarget).mockClear();
  suspend = true;
  tree.rerender(
    <Provider>
      <React.Suspense fallback="Loading">
        <Child />
      </React.Suspense>
    </Provider>,
  );
  expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
});
