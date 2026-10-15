// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { findNodeHandle } from 'react-native';
import NativeEverframe from '../NativeEverframe.js';
import { nextInteractionTargetId } from '../interaction-target-registration.js';

interface Fiber {
  tag?: number;
  type?: unknown;
  elementType?: unknown;
  stateNode?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
}
interface Hook {
  renderers: Map<number, unknown>;
  getFiberRoots(renderer: number): Set<{ current: Fiber }>;
  onCommitFiberRoot: (...args: unknown[]) => unknown;
}
interface Binding {
  id: string;
  tag: number;
}
let generation = 0;
const noop = () => {};
const maxFibers = 50_000;

function currentHook(): unknown {
  return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__;
}

/**
 * Recognize RN's development UI by its actual exports, never application names,
 * warning content or accessibility labels. Native descendants inherit origin
 * from the first host views within these exact framework component subtrees.
 * An unavailable hook or unrecognized export leaves attribution unavailable.
 * These private RN module paths must still be resolvable by Metro at build time.
 */
export function installDevtoolsOrigins(options: { getOwner(): object | undefined }): () => void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return noop;
  let hook: Hook;
  let owner: object;
  try {
    const candidate = currentHook() as Partial<Hook> | null;
    const mount = options.getOwner();
    if (
      !mount ||
      !candidate ||
      typeof candidate.onCommitFiberRoot !== 'function' ||
      typeof candidate.getFiberRoots !== 'function' ||
      !(candidate.renderers instanceof Map) ||
      typeof NativeEverframe.setInteractionTarget !== 'function' ||
      typeof NativeEverframe.clearInteractionTarget !== 'function' ||
      typeof findNodeHandle !== 'function'
    )
      return noop;
    owner = mount;
    hook = candidate as Hook;
  } catch {
    return noop;
  }

  const bindings = new Map<unknown, Binding>();
  let disposed = false;
  let refreshing = false;
  let restore = noop;
  function owned(): boolean {
    return !disposed && options.getOwner() === owner && currentHook() === hook;
  }
  function clear(binding: Binding) {
    try {
      NativeEverframe.clearInteractionTarget(binding.id, ++generation);
    } catch {
      // Optional development metadata must not affect rendering or cleanup.
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    const previous = [...bindings.values()];
    bindings.clear();
    try {
      restore();
    } catch {
      /* Another hook may have become read-only. */
    }
    previous.forEach(clear);
  }

  // Dynamic imports stay behind the host bundle's development flag, including
  // when that bundle is running in a release-built native SDK. Metro resolves
  // these literal specifiers; no additional fiber instrumentation is installed.
  void Promise.allSettled([
    import('react-native/Libraries/LogBox/LogBoxNotificationContainer'),
    import('react-native/Libraries/LogBox/LogBoxInspectorContainer'),
  ]).then(([notification, inspector]) => {
    try {
      if (!owned() || typeof hook.onCommitFiberRoot !== 'function') {
        dispose();
        return;
      }
      const identities = new Set<unknown>();
      function remember(value: unknown) {
        if (typeof value === 'function' || (typeof value === 'object' && value !== null))
          identities.add(value);
      }
      if (notification.status === 'fulfilled') {
        remember(notification.value.default);
        remember(notification.value._LogBoxNotificationContainer);
      }
      if (inspector.status === 'fulfilled') {
        remember(inspector.value.default);
        remember(inspector.value._LogBoxInspectorContainer);
      }
      if (!identities.size) {
        dispose();
        return;
      }

      function refresh() {
        if (disposed || refreshing) return;
        refreshing = true;
        try {
          if (!owned()) {
            dispose();
            return;
          }
          const candidates = new Map<unknown, number>();
          const visited = new Set<Fiber>();
          const stack: [Fiber, boolean][] = [];
          for (const renderer of hook.renderers.keys()) {
            for (const root of hook.getFiberRoots(renderer)) {
              if (root?.current) stack.push([root.current, false]);
            }
          }
          while (stack.length) {
            const [node, parentMatched] = stack.pop()!;
            if (visited.has(node)) continue;
            visited.add(node);
            if (visited.size > maxFibers) throw Error('Development tree budget exceeded');
            if (node.sibling) stack.push([node.sibling, parentMatched]);
            const matched =
              parentMatched || identities.has(node.type) || identities.has(node.elementType);
            if (matched && node.tag === 5 && node.stateNode != null) {
              // Fabric's stateNode contains canonical.nativeTag. Legacy hosts
              // carry _nativeTag. RN's resolver handles both without props.
              const tag = findNodeHandle(node.stateNode as Parameters<typeof findNodeHandle>[0]);
              if (
                typeof tag === 'number' &&
                Number.isInteger(tag) &&
                tag > 0 &&
                tag <= 2147483647
              ) {
                candidates.set(node.stateNode, tag);
                continue;
              }
            }
            if (node.child) stack.push([node.child, matched]);
          }
          if (!owned()) {
            dispose();
            return;
          }
          for (const [ref, binding] of bindings) {
            if (candidates.get(ref) !== binding.tag) {
              bindings.delete(ref);
              clear(binding);
            }
          }
          for (const [ref, tag] of candidates) {
            if (!owned()) {
              dispose();
              return;
            }
            if (bindings.has(ref)) continue;
            const binding = { id: `devtools:${nextInteractionTargetId()}`, tag };
            bindings.set(ref, binding);
            try {
              if (
                !NativeEverframe.setInteractionTarget(tag, binding.id, ++generation, {
                  devtoolsOrigin: true,
                })
              ) {
                bindings.delete(ref);
                clear(binding);
              }
            } catch {
              bindings.delete(ref);
              clear(binding);
            }
          }
          if (!owned()) dispose();
        } catch {
          // A changed renderer shape cannot leave an old view marked forever.
          const previous = [...bindings.values()];
          bindings.clear();
          previous.forEach(clear);
        } finally {
          refreshing = false;
        }
      }
      const original = hook.onCommitFiberRoot;
      function committed(this: unknown, ...args: unknown[]) {
        try {
          return Reflect.apply(original, this, args);
        } finally {
          // refresh contains its own errors; the framework's return value and
          // thrown exception remain exactly those of the original hook.
          refresh();
        }
      }
      hook.onCommitFiberRoot = committed;
      restore = () => {
        if (hook.onCommitFiberRoot === committed) hook.onCommitFiberRoot = original;
      };
      refresh();
    } catch {
      dispose();
    }
  });
  return dispose;
}
