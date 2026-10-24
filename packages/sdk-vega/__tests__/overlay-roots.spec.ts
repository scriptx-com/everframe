// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// The root wrapper mounted for real (effects run), with more than one
// AppRegistry root: React Native for Vega can run several surfaces at once.
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOverlayStore,
  installRootWrapper,
  type AppRegistryLike,
  type OverlayStore,
} from '../src/overlay.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Wrapper = (props: { children?: ReactNode }) => ReactNode;

const roots: Root[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = '';
});

function setup(): {
  store: OverlayStore;
  provider: (params: unknown) => unknown;
  registry: AppRegistryLike;
} {
  const providers: Array<(params: unknown) => unknown> = [];
  const registry: AppRegistryLike = {
    setWrapperComponentProvider(provider) {
      providers.push(provider);
    },
  };
  const store = createOverlayStore({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  installRootWrapper(registry, { store, onKey: () => undefined });
  return { store, provider: providers[0]!, registry };
}

function mount(Wrapper: Wrapper, child: string): { root: Root; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(Wrapper, null, createElement('p', { id: child }, child))));
  return { root, container };
}

describe('root wrapper with several roots', () => {
  it('staysMountedWhileAnyRootIsMounted', () => {
    const { store, provider } = setup();
    expect(store.mounted()).toBe(false);
    const first = mount(provider({ rootTag: 1 }) as Wrapper, 'one');
    const second = mount(provider({ rootTag: 11 }) as Wrapper, 'two');
    expect(store.mounted()).toBe(true);
    act(() => first.root.unmount());
    expect(store.mounted()).toBe(true);
    act(() => second.root.unmount());
    expect(store.mounted()).toBe(false);
  });

  it('keepsEachRootsHostWrapper', () => {
    const { store, provider, registry } = setup();
    let mounts = 0;
    const hostFor = (name: string) =>
      function HostWrapper(props: { children?: ReactNode }) {
        // Counts mounts: a swapped host type would remount the app subtree.
        useEffect(() => {
          mounts++;
        }, []);
        return createElement('section', { 'data-host': name }, props.children);
      };
    const hosts = new Map<number, Wrapper>([
      [1, hostFor('first')],
      [11, hostFor('second')],
    ]);
    registry.setWrapperComponentProvider((params) =>
      hosts.get((params as { rootTag: number }).rootTag),
    );
    const first = mount(provider({ rootTag: 1 }) as Wrapper, 'one');
    const second = mount(provider({ rootTag: 11 }) as Wrapper, 'two');
    expect(mounts).toBe(2);
    // A banner rerenders both roots.
    act(() => store.showBanner({}, 47));
    expect(first.container.querySelector('[data-host="first"] #one')).not.toBeNull();
    expect(second.container.querySelector('[data-host="second"] #two')).not.toBeNull();
    expect(first.container.textContent).toContain('Linking to Everframe · 47');
    expect(mounts).toBe(2);
  });

  it('aSurfaceUpdateForTheSameRootKeepsTheAppMounted', () => {
    const { provider, registry } = setup();
    let appMounts = 0;
    function App() {
      useEffect(() => {
        appMounts++;
      }, []);
      return createElement('p', { id: 'app' }, 'app');
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const renderSurface = () => {
      // AppRegistry.setSurfaceProps calls the provider again for the same root.
      const Wrapper = provider({ rootTag: 1 }) as Wrapper;
      act(() => root.render(createElement(Wrapper, null, createElement(App))));
    };
    renderSurface();
    renderSurface();
    expect(appMounts).toBe(1);

    // The same holds with a host wrapper chained inside ours.
    function HostWrapper(props: { children?: ReactNode }) {
      return createElement('section', { 'data-host': 'host' }, props.children);
    }
    registry.setWrapperComponentProvider(() => HostWrapper);
    renderSurface();
    renderSurface();
    renderSurface();
    expect(container.querySelector('[data-host="host"] #app')).not.toBeNull();
    // Adding the host wrapper remounts the app once; later updates do not.
    expect(appMounts).toBe(2);
  });

  it('aHostProviderAnsweringDifferentlyForTheSameRootIsFollowed', () => {
    const { provider, registry } = setup();
    let current = 'first';
    const hosts: Record<string, Wrapper> = {
      first: (props) => createElement('section', { 'data-host': 'first' }, props.children),
      second: (props) => createElement('section', { 'data-host': 'second' }, props.children),
    };
    registry.setWrapperComponentProvider(() => hosts[current]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const W1 = provider({ rootTag: 1 }) as Wrapper;
    act(() => root.render(createElement(W1, null, 'app')));
    expect(container.querySelector('[data-host="first"]')).not.toBeNull();
    current = 'second';
    const W2 = provider({ rootTag: 1 }) as Wrapper;
    expect(W2).toBe(W1);
    act(() => root.render(createElement(W2, null, 'app')));
    expect(container.querySelector('[data-host="second"]')).not.toBeNull();
    // Another root still gets its own wrapper.
    expect(provider({ rootTag: 11 })).not.toBe(W1);
  });
});
