// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findNodeHandle } from 'react-native';
import NativeEverframe from '../src/NativeEverframe.js';
import { installDevtoolsOrigins } from '../src/interactions/devtools.js';
import NotificationSubscription, {
  _LogBoxNotificationContainer,
} from './devtools-notification.fixture.js';
import InspectorSubscription, { _LogBoxInspectorContainer } from './devtools-inspector.fixture.js';

interface Fiber {
  tag: number;
  type: unknown;
  elementType: unknown;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
}
function fiber(type: unknown, children: Fiber[] = [], tag = 0, stateNode: unknown = null): Fiber {
  children.forEach((child, i) => {
    child.sibling = children[i + 1] ?? null;
  });
  const result = {
    tag,
    type,
    elementType: type,
    stateNode,
    child: children[0] ?? null,
    sibling: null,
  };
  // Reading content would expose warning messages or application data. The
  // committed-tree integration only needs identity, topology and host refs.
  for (const field of ['memoizedProps', 'pendingProps', 'memoizedState']) {
    Object.defineProperty(result, field, {
      get() {
        throw Error(`Read content: ${field}`);
      },
    });
  }
  return result;
}
function host(tag: number, children: Fiber[] = []): Fiber {
  // Fabric HostComponent stateNodes are wrappers around canonical native refs.
  return fiber('RCTView', children, 5, { canonical: { nativeTag: tag, publicInstance: {} } });
}
function notification(tag = 101): Fiber {
  // Source: RN Libraries/LogBox/LogBoxNotificationContainer.js (0.85.3-0).
  // SafeAreaView -> ordinary host -> toast View -> LogBoxNotification. The
  // matched component's app sibling must never inherit the origin.
  return fiber(NotificationSubscription, [
    fiber(_LogBoxNotificationContainer, [fiber(() => null, [host(tag, [host(tag + 1)])])]),
  ]);
}
type Root = { current: Fiber };
function makeHook(root: Root) {
  const roots = new Set([root]);
  return {
    renderers: new Map([[1, {}]]),
    getFiberRoots: vi.fn(() => roots),
    onCommitFiberRoot: vi.fn(function (this: unknown, ..._args: unknown[]) {
      return 'original-result';
    }),
    roots,
  };
}
const cleanups: (() => void)[] = [];
let owner: object | undefined;
function install() {
  const cleanup = installDevtoolsOrigins({ getOwner: () => owner });
  cleanups.push(cleanup);
  return cleanup;
}
async function loaded() {
  await vi.dynamicImportSettled();
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__DEV__', true);
  owner = {};
  vi.mocked(findNodeHandle).mockImplementation(
    (ref) => (ref as unknown as { canonical?: { nativeTag?: number } })?.canonical?.nativeTag,
  );
  vi.mocked(NativeEverframe.setInteractionTarget).mockReturnValue(true);
  vi.mocked(NativeEverframe.clearInteractionTarget).mockReturnValue(true);
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe('framework-owned LogBox attribution', () => {
  it('marks the first native host under the exact exported notification component', async () => {
    const root = { current: fiber(null, [host(10), notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledExactlyOnceWith(
      101,
      expect.any(String),
      expect.any(Number),
      { devtoolsOrigin: true },
    );
    expect(findNodeHandle).toHaveBeenCalledExactlyOnceWith(
      root.current.child!.sibling!.child!.child!.child!.stateNode,
    );
  });

  it.each([
    _LogBoxNotificationContainer,
    NotificationSubscription,
    _LogBoxInspectorContainer,
    InspectorSubscription,
  ])('accepts the framework export identity %s', async (component) => {
    const hook = makeHook({ current: fiber(null, [fiber(component, [host(200)])]) });
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledExactlyOnceWith(
      200,
      expect.any(String),
      expect.any(Number),
      { devtoolsOrigin: true },
    );
  });

  it('ignores app components with the same name and displayName, and raw native views', async () => {
    const decoy = function _LogBoxNotificationContainer() {};
    Object.assign(decoy, { displayName: '_LogBoxNotificationContainer' });
    const hook = makeHook({ current: fiber(null, [fiber(decoy, [host(10)]), host(20)]) });
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
    expect(findNodeHandle).not.toHaveBeenCalled();
  });

  it('finds every first host in a fragment without marking their descendants', async () => {
    const component = fiber(_LogBoxNotificationContainer, [host(101, [host(102)]), host(201)]);
    vi.stubGlobal(
      '__REACT_DEVTOOLS_GLOBAL_HOOK__',
      makeHook({ current: fiber(null, [component]) }),
    );
    install();
    await loaded();
    expect(vi.mocked(NativeEverframe.setInteractionTarget).mock.calls.map(([tag]) => tag)).toEqual([
      101, 201,
    ]);
  });

  it('preserves the hook receiver, arguments, result and original exception', async () => {
    const root = { current: fiber(null) };
    const hook = makeHook(root);
    const original = hook.onCommitFiberRoot;
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    const receiver = {};
    expect(hook.onCommitFiberRoot.call(receiver, 1, root, 42, false)).toBe('original-result');
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0][0]).toBe(1);
    expect(original.mock.calls[0][1]).toBe(root);
    expect(original.mock.calls[0].slice(2)).toEqual([42, false]);
    expect(original.mock.contexts[0]).toBe(receiver);
    const thrown = Error('framework failure');
    original.mockImplementationOnce(() => {
      throw thrown;
    });
    expect(() => hook.onCommitFiberRoot(1, root)).toThrow(thrown);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('registers a later commit once and clears a removed or renamed framework subtree', async () => {
    const root = { current: fiber(null) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    const toast = notification();
    root.current = fiber(null, [toast]);
    hook.onCommitFiberRoot(1, root);
    const [tag, id, setGeneration] = vi.mocked(NativeEverframe.setInteractionTarget).mock.calls[0];
    expect(tag).toBe(101);
    hook.onCommitFiberRoot(1, root);
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledTimes(1);
    toast.type = toast.elementType = () => null;
    toast.child!.type = toast.child!.elementType = () => null;
    hook.onCommitFiberRoot(1, root);
    const [clearedId, clearGeneration] = vi.mocked(NativeEverframe.clearInteractionTarget).mock
      .calls[0];
    expect(clearedId).toBe(id);
    expect(clearGeneration).toBeGreaterThan(setGeneration);
  });

  it('clears a replaced ref before binding its reused native tag to a new identity', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    const first = vi.mocked(NativeEverframe.setInteractionTarget).mock.calls[0];
    root.current = fiber(null, [notification()]);
    hook.onCommitFiberRoot(1, root);
    const second = vi.mocked(NativeEverframe.setInteractionTarget).mock.calls[1];
    const clear = vi.mocked(NativeEverframe.clearInteractionTarget).mock.calls[0];
    expect(second[0]).toBe(101);
    expect(second[1]).not.toBe(first[1]);
    expect(clear[0]).toBe(first[1]);
    expect(clear[1]).toBeGreaterThan(first[2]);
    expect(second[2]).toBeGreaterThan(clear[1]);
    expect(
      vi.mocked(NativeEverframe.clearInteractionTarget).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(NativeEverframe.setInteractionTarget).mock.invocationCallOrder[1]);
  });

  it('clears invalid refs and roots removed by the original framework hook', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    vi.mocked(findNodeHandle).mockReturnValue(undefined);
    hook.onCommitFiberRoot(1, root);
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(1);
    vi.mocked(findNodeHandle).mockReturnValue(101);
    hook.onCommitFiberRoot(1, root);
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledTimes(2);
    hook.roots.clear();
    hook.onCommitFiberRoot(1, root);
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(2);
  });

  it('teardown clears every registration once and restores only its own wrapper', async () => {
    const root = {
      current: fiber(null, [notification(), fiber(_LogBoxInspectorContainer, [host(200)])]),
    };
    const hook = makeHook(root);
    const original = hook.onCommitFiberRoot;
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    const cleanup = install();
    await loaded();
    const wrapper = hook.onCommitFiberRoot;
    const laterWrapper = vi.fn((...args: unknown[]) => wrapper(...args));
    hook.onCommitFiberRoot = laterWrapper;
    cleanup();
    cleanup();
    expect(hook.onCommitFiberRoot).toBe(laterWrapper);
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(2);
    hook.onCommitFiberRoot(1, root);
    expect(original).toHaveBeenCalledTimes(1);
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledTimes(2);
  });

  it('restores the original hook when it still owns the hook slot', async () => {
    const hook = makeHook({ current: fiber(null, [notification()]) });
    const original = hook.onCommitFiberRoot;
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    const cleanup = install();
    await loaded();
    expect(hook.onCommitFiberRoot).not.toBe(original);
    cleanup();
    expect(hook.onCommitFiberRoot).toBe(original);
  });

  it('a disposed loader cannot attach after another mount takes ownership', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install()();
    owner = {};
    const cleanup = install();
    await loaded();
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledTimes(1);
    cleanup();
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(1);
  });

  it('does not install over a hook removed while framework modules load', async () => {
    const hook = makeHook({ current: fiber(null, [notification()]) });
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    hook.onCommitFiberRoot = undefined as never;
    await loaded();
    expect(hook.onCommitFiberRoot).toBeUndefined();
    expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
  });

  it('revokes the old mount if owner changes during the original commit callback', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    const original = hook.onCommitFiberRoot;
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    original.mockImplementationOnce(() => {
      owner = {};
      return 'new-owner';
    });
    expect(hook.onCommitFiberRoot(1, root)).toBe('new-owner');
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(1);
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledTimes(1);
    expect(hook.onCommitFiberRoot).toBe(original);
  });

  it('does not publish a stale binding when native ref lookup changes the owner', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    vi.mocked(findNodeHandle).mockImplementationOnce(() => {
      owner = {};
      return 101;
    });
    install();
    await loaded();
    expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
  });

  it('clears registered ownership if the global hook is replaced during reload', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', makeHook(root));
    hook.onCommitFiberRoot(1, root);
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(1);
    expect(NativeEverframe.setInteractionTarget).toHaveBeenCalledTimes(1);
  });

  it('clears accepted metadata when a ref or native registration throws', async () => {
    const root = { current: fiber(null, [notification()]) };
    const hook = makeHook(root);
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    vi.mocked(findNodeHandle).mockImplementationOnce(() => {
      throw Error('detached ref');
    });
    expect(() => hook.onCommitFiberRoot(1, root)).not.toThrow();
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(1);
    vi.mocked(NativeEverframe.setInteractionTarget).mockImplementationOnce(() => {
      throw Error('old binary');
    });
    expect(() => hook.onCommitFiberRoot(1, root)).not.toThrow();
    expect(NativeEverframe.clearInteractionTarget).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    {},
    { onCommitFiberRoot() {} },
    {
      renderers: new Map(),
      onCommitFiberRoot() {},
      getFiberRoots: 'unknown',
    },
  ])('leaves unsupported hooks untouched', async (hook) => {
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    install();
    await loaded();
    expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
    expect(
      (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__,
    ).toBe(hook);
  });

  it('does no development work for a release host bundle', async () => {
    const hook = makeHook({ current: fiber(null, [notification()]) });
    const original = hook.onCommitFiberRoot;
    vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
    vi.stubGlobal('__DEV__', false);
    const getOwner = vi.fn(() => ({}));
    cleanups.push(installDevtoolsOrigins({ getOwner }));
    await loaded();
    expect(getOwner).not.toHaveBeenCalled();
    expect(hook.getFiberRoots).not.toHaveBeenCalled();
    expect(hook.onCommitFiberRoot).toBe(original);
    expect(NativeEverframe.setInteractionTarget).not.toHaveBeenCalled();
  });
});
