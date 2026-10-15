// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findNodeHandle } from 'react-native';

const notificationPath = 'react-native/Libraries/LogBox/LogBoxNotificationContainer';
const inspectorPath = 'react-native/Libraries/LogBox/LogBoxInspectorContainer';
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('__DEV__', true);
  vi.mocked(findNodeHandle).mockReturnValue(21);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.doUnmock(notificationPath);
  vi.doUnmock(inspectorPath);
  vi.unstubAllGlobals();
});

async function install(
  notification: () => Record<string, unknown>,
  inspector: () => Record<string, unknown>,
  dev = true,
) {
  const component = () => null;
  const root = {
    current: {
      type: component,
      tag: 0,
      child: { tag: 5, stateNode: {}, type: 'RCTView' },
    },
  };
  const hook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([root]),
    onCommitFiberRoot: vi.fn(),
  };
  const original = hook.onCommitFiberRoot;
  const notificationLoader = vi.fn(notification);
  const inspectorLoader = vi.fn(inspector);
  vi.doMock(notificationPath, notificationLoader);
  vi.doMock(inspectorPath, inspectorLoader);
  vi.stubGlobal('__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
  vi.stubGlobal('__DEV__', dev);
  const { installDevtoolsOrigins } = await import('../src/interactions/devtools.js');
  const native = (await import('../src/NativeEverframe.js')).default;
  const owner = {};
  cleanup = installDevtoolsOrigins({ getOwner: () => owner });
  return { hook, original, native, root, component, notificationLoader, inspectorLoader };
}

it('keeps the framework hook untouched when both optional LogBox modules are unavailable', async () => {
  const unavailable = () => {
    throw Error('Unsupported RN module');
  };
  const { hook, original, native } = await install(unavailable, unavailable);
  await vi.dynamicImportSettled();
  expect(hook.onCommitFiberRoot).toBe(original);
  expect(native.setInteractionTarget).not.toHaveBeenCalled();
});

it('accepts one supported module when the other import rejects', async () => {
  const inspector = () => null;
  const { native, root } = await install(
    () => {
      throw Error('No notification module');
    },
    () => ({ default: inspector, _LogBoxInspectorContainer: inspector }),
  );
  root.current.type = inspector;
  await vi.dynamicImportSettled();
  expect(native.setInteractionTarget).toHaveBeenCalledExactlyOnceWith(
    21,
    expect.any(String),
    expect.any(Number),
    { devtoolsOrigin: true },
  );
});

it('ignores unrecognized module exports instead of matching component names', async () => {
  const { hook, original, native } = await install(
    () => ({ default: undefined, _LogBoxNotificationContainer: undefined }),
    () => ({ default: null, _LogBoxInspectorContainer: 42 }),
  );
  await vi.dynamicImportSettled();
  expect(hook.onCommitFiberRoot).toBe(original);
  expect(native.setInteractionTarget).not.toHaveBeenCalled();
});

it('does not evaluate framework development modules in release hosts', async () => {
  const unavailable = () => {
    throw Error('Must not import');
  };
  const { hook, original, notificationLoader, inspectorLoader, native } = await install(
    unavailable,
    unavailable,
    false,
  );
  await vi.dynamicImportSettled();
  expect(notificationLoader).not.toHaveBeenCalled();
  expect(inspectorLoader).not.toHaveBeenCalled();
  expect(hook.onCommitFiberRoot).toBe(original);
  expect(native.setInteractionTarget).not.toHaveBeenCalled();
});
