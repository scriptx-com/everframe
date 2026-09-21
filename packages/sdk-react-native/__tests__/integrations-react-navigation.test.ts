// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// reactNavigationIntegration (spec 2026-07-14): thin adapter — every screen
// change funnels into recordScreen; the NATIVE side owns from→to derivation
// and A→A suppression. Duck-typed ref, no @react-navigation dependency.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactNavigationIntegration } from '../src/integrations/react-navigation.js';
import { __setCurrentContext } from '../src/contextSeam.js';

function makeRef(initial?: string) {
  let routeName = initial;
  const listeners: Array<() => void> = [];
  return {
    isReady: () => routeName !== undefined,
    getCurrentRoute: () => (routeName === undefined ? undefined : { name: routeName }),
    addListener: (_type: 'state', cb: () => void) => {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    navigate(name: string) {
      routeName = name;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.length,
  };
}

describe('reactNavigationIntegration', () => {
  const recordScreen = vi.fn();
  let teardown: (() => void) | void;

  beforeEach(() => {
    recordScreen.mockReset();
    __setCurrentContext({ recordScreen } as never);
  });

  afterEach(() => {
    if (teardown) teardown();
    teardown = undefined;
    __setCurrentContext(null);
  });

  it('emits the current route at setup when the container is already ready', () => {
    const ref = makeRef('Home');
    teardown = reactNavigationIntegration({ navigationRef: ref }).setup();
    expect(recordScreen).toHaveBeenCalledWith('Home');
  });

  it('does not throw at setup when the container is not ready yet', () => {
    const ref = makeRef(undefined);
    teardown = reactNavigationIntegration({ navigationRef: ref }).setup();
    expect(recordScreen).not.toHaveBeenCalled();
  });

  it('emits on every state change via the ref listener', () => {
    const ref = makeRef('Home');
    teardown = reactNavigationIntegration({ navigationRef: ref }).setup();
    ref.navigate('Detail');
    ref.navigate('Settings');
    expect(recordScreen.mock.calls.map((c) => c[0])).toEqual(['Home', 'Detail', 'Settings']);
  });

  it('teardown unsubscribes the state listener', () => {
    const ref = makeRef('Home');
    teardown = reactNavigationIntegration({ navigationRef: ref }).setup();
    expect(ref.listenerCount()).toBe(1);
    if (teardown) teardown();
    teardown = undefined;
    expect(ref.listenerCount()).toBe(0);
  });

  it('onReady and onStateChange handlers emit (container-prop wiring path)', () => {
    const ref = makeRef('Splash');
    const integration = reactNavigationIntegration({ navigationRef: ref });
    integration.onReady();
    integration.onStateChange();
    expect(recordScreen).toHaveBeenCalledTimes(2);
    expect(recordScreen).toHaveBeenCalledWith('Splash');
  });

  it('a ref whose addListener throws degrades to handler-only wiring', () => {
    const ref = {
      isReady: () => true,
      getCurrentRoute: () => ({ name: 'Home' }),
      addListener: () => {
        throw new Error('not supported on this version');
      },
    };
    const integration = reactNavigationIntegration({ navigationRef: ref });
    expect(() => (teardown = integration.setup())).not.toThrow();
    expect(recordScreen).toHaveBeenCalledWith('Home'); // initial emit still happened
  });

  it('nameless routes are skipped', () => {
    const ref = makeRef('Home');
    // Deliberately violates the declared `{ name: string }` return type: this
    // case exists to prove a route object arriving WITHOUT `name` is skipped
    // rather than crashing. The cast is the assertion, not a workaround.
    ref.getCurrentRoute = () => ({}) as ReturnType<typeof ref.getCurrentRoute>;
    teardown = reactNavigationIntegration({ navigationRef: ref }).setup();
    expect(recordScreen).not.toHaveBeenCalled();
  });

  it('a getCurrentRoute that throws during a state change is swallowed (fail-soft)', () => {
    const ref = {
      isReady: () => true,
      getCurrentRoute: () => {
        throw new Error('boom mid-navigation');
      },
      addListener: (_type: 'state', cb: () => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
    };
    let listener: (() => void) | undefined;
    const integration = reactNavigationIntegration({ navigationRef: ref });
    expect(() => (teardown = integration.setup())).not.toThrow();
    expect(() => listener?.()).not.toThrow();
    expect(() => integration.onStateChange()).not.toThrow();
    expect(recordScreen).not.toHaveBeenCalled();
  });
});
