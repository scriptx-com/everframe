// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EverframeProvider } from '../src/EverframeProvider.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { __setCurrentContext } from '../src/contextSeam.js';
import { useEverframeInteraction } from '../src/useEverframeInteraction.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(NativeEverframe.getInteractionLease).mockReturnValue('lease-1');
  vi.mocked(NativeEverframe.setInteractionObserver).mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  __setCurrentContext(null);
  vi.restoreAllMocks();
});
function Control({
  name = 'Search',
  onChange = () => {},
  hostKey = 'one',
}: {
  name?: string;
  onChange?: () => void;
  hostKey?: string;
}) {
  const interaction = useEverframeInteraction<HTMLInputElement>({
    target: { name, testId: 'search' },
    helperTypes: ['text_edit'],
  });
  const local = React.useRef<HTMLInputElement | null>(null);
  const composed = React.useCallback(
    (host: HTMLInputElement | null) => {
      local.current = host;
      interaction.ref(host);
    },
    [interaction.ref],
  );
  return (
    <input
      key={hostKey}
      aria-label="Search"
      ref={composed}
      onChange={(e) => {
        onChange();
        interaction.textChanged(e.target.value);
      }}
    />
  );
}
const config = {
  sdkKey: 'txx_test',
  crashReporting: { disabled: true },
  interactions: { valueTestIds: ['search'] },
};
function Provider({ children }: { children: React.ReactNode }) {
  return <EverframeProvider config={config}>{children}</EverframeProvider>;
}
it('absent provider is harmless and preserves app callbacks', () => {
  const changed = vi.fn();
  const tree = render(<Control onChange={changed} />);
  fireEvent.change(tree.getByLabelText('Search'), { target: { value: 'text' } });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(NativeEverframe.setInteractionObserver).not.toHaveBeenCalled();
  expect(NativeEverframe.recordInteraction).not.toHaveBeenCalled();
});
it('registers after provider startup, updates only committed metadata, and clears on unmount', () => {
  const changed = vi.fn();
  const tree = render(
    <Provider>
      <Control onChange={changed} />
    </Provider>,
  );
  const first = vi.mocked(NativeEverframe.setInteractionObserver).mock.calls.at(-1)!;
  expect(first[0]).toBe(12);
  expect(JSON.parse(first[4]).target.name).toBe('Search');
  fireEvent.change(tree.getByLabelText('Search'), { target: { value: '😀' } });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(JSON.parse(first[4]).helperTypes).toEqual([]);
  expect(NativeEverframe.recordInteraction).not.toHaveBeenCalled();
  tree.rerender(
    <Provider>
      <Control name="Updated" />
    </Provider>,
  );
  expect(
    JSON.parse(vi.mocked(NativeEverframe.setInteractionObserver).mock.calls.at(-1)![4]).target.name,
  ).toBe('Updated');
  tree.unmount();
  expect(NativeEverframe.clearInteractionObserver).toHaveBeenCalled();
  expect(NativeEverframe.addBreadcrumb).not.toHaveBeenCalled();
});
it('native revocation does not replay unchanged props but a committed metadata change recovers', () => {
  const tree = render(
    <Provider>
      <Control />
    </Provider>,
  );
  vi.mocked(NativeEverframe.getInteractionLease).mockReturnValue('lease-2');
  fireEvent.change(tree.getByLabelText('Search'), { target: { value: 'old' } });
  expect(NativeEverframe.recordInteraction).not.toHaveBeenCalled();
  vi.mocked(NativeEverframe.setInteractionObserver).mockClear();
  tree.rerender(
    <Provider>
      <Control />
    </Provider>,
  );
  expect(NativeEverframe.setInteractionObserver).not.toHaveBeenCalled();
  tree.rerender(
    <Provider>
      <Control name="Fresh" />
    </Provider>,
  );
  expect(vi.mocked(NativeEverframe.setInteractionObserver).mock.calls.at(-1)![3]).toBe('lease-2');
});
it('abandoned render publishes no new metadata', () => {
  let suspend = false;
  function Child() {
    const i = useEverframeInteraction<HTMLButtonElement>({
      target: { name: suspend ? 'Abandoned' : 'Committed' },
    });
    if (suspend) throw new Promise(() => {});
    return <button ref={i.ref} />;
  }
  const tree = render(
    <Provider>
      <React.Suspense fallback="Loading">
        <Child />
      </React.Suspense>
    </Provider>,
  );
  vi.mocked(NativeEverframe.setInteractionObserver).mockClear();
  suspend = true;
  tree.rerender(
    <Provider>
      <React.Suspense fallback="Loading">
        <Child />
      </React.Suspense>
    </Provider>,
  );
  expect(NativeEverframe.setInteractionObserver).not.toHaveBeenCalled();
});
it('policy is normalized before crossing the bridge', () => {
  render(
    <Provider>
      <Control />
    </Provider>,
  );
  const options = vi.mocked(NativeEverframe.configureSync).mock.calls.at(-1)![0];
  expect(JSON.parse(options.interactionsJson!)).toMatchObject({
    valueTestIds: ['search'],
    urlRules: [],
    launchArgumentKeys: [],
    disabled: false,
  });
});

it('native revocation does not replay metadata and a fresh host attachment can recover', () => {
  const tree = render(
    <EverframeProvider config={config}>
      <Control />
    </EverframeProvider>,
  );
  vi.mocked(NativeEverframe.setInteractionObserver).mockClear();
  vi.mocked(NativeEverframe.getInteractionLease).mockReturnValue('lease-2');
  tree.rerender(
    <EverframeProvider config={config}>
      <Control />
    </EverframeProvider>,
  );
  expect(NativeEverframe.setInteractionObserver).not.toHaveBeenCalled();
  tree.rerender(
    <EverframeProvider config={config}>
      <Control hostKey="two" />
    </EverframeProvider>,
  );
  expect(vi.mocked(NativeEverframe.setInteractionObserver).mock.calls.at(-1)?.[3]).toBe('lease-2');
});

it('StrictMode ref replay preserves one app call and clears every committed owner', () => {
  const changed = vi.fn();
  const tree = render(
    <React.StrictMode>
      <Provider>
        <Control onChange={changed} />
      </Provider>
    </React.StrictMode>,
  );
  fireEvent.change(tree.getByLabelText('Search'), { target: { value: 'one' } });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(NativeEverframe.recordInteraction).not.toHaveBeenCalled();
  tree.unmount();
  const sets = vi.mocked(NativeEverframe.setInteractionObserver).mock.calls;
  const clears = vi.mocked(NativeEverframe.clearInteractionObserver).mock.calls;
  for (const set of sets)
    expect(clears.some((clear) => clear[0] === set[1] && clear[1] > set[2])).toBe(true);
});
it('policy accessors are never evaluated or allowed to enable capture', () => {
  const read = vi.fn(() => {
    throw Error('host getter');
  });
  const hostile = Object.defineProperty({ ...config }, 'interactions', { get: read });
  render(
    <EverframeProvider config={hostile}>
      <Control />
    </EverframeProvider>,
  );
  expect(read).not.toHaveBeenCalled();
  expect(NativeEverframe.setInteractionObserver).not.toHaveBeenCalled();
  expect(
    JSON.parse(vi.mocked(NativeEverframe.configureSync).mock.calls.at(-1)![0].interactionsJson!)
      .disabled,
  ).toBe(true);
});
