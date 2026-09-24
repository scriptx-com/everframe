// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06-05 Task 2 — <EverframeSensitive> wrapper + useEverframeSensitiveRef hook.
//
// Both surfaces write into the provider's sensitive-rect registry rather than
// calling the TurboModule directly (RESEARCH §5.1 substitution). The pure
// `handleSensitiveLayout` helper reads the multi-shape native tag (Paper:
// `_nativeTag`; legacy Fabric: `canonical._nativeTag`; RN ≥ 0.80 Fabric:
// `canonical.nativeTag`; Fabric public instance: `__nativeTag`) — this is
// the load-bearing logic and the only thing unit-tested in this file.
import * as React from 'react';
import { View, Platform, requireNativeComponent, type ViewProps, type LayoutChangeEvent } from 'react-native';
import { useEverframe } from './EverframeProvider.js';

// A single Yoga node whose Android constructor marks sensitivity before native insertion.
const SensitiveHost = Platform.OS === 'android'
  ? requireNativeComponent<ViewProps>('EverframeSensitiveView') : View;

type Rect = { x: number; y: number; width: number; height: number };
type Register = (tag: number, rect: Rect) => void;

/** Probe shape mirrored from capture/host-tag-rn.ts so this file stays
 *  decoupled from the fiber walker but never drifts on supported shapes. */
type NativeTagHost = {
  _nativeTag?: number;
  __nativeTag?: number;
  canonical?: { nativeTag?: number; _nativeTag?: number };
};

function readNativeTag(node: NativeTagHost): number | undefined {
  return (
    node.canonical?.nativeTag ??
    node.canonical?._nativeTag ??
    node.__nativeTag ??
    node._nativeTag
  );
}

/**
 * Pure layout-event handler. Reads the dual-shape native tag from the RN host
 * instance and forwards (tag, rect) to the supplied register fn. Exported for
 * direct unit testing — the component below just wires `ref.current` +
 * `e.nativeEvent.layout` into this helper.
 *
 * Stability note (RESEARCH §5.2): `_nativeTag` is stable for the lifetime of a
 * mounted host instance. Remounts trigger fresh onLayout → re-registration
 * under the new tag. FlatList recycling is mitigated by the native registry's
 * tag-eviction policy on screenshot capture.
 */
export function handleSensitiveLayout(
  node: unknown,
  register: Register,
  event: { nativeEvent: { layout: Rect } }
): void {
  if (node == null) return;
  const tag = readNativeTag(node as NativeTagHost);
  if (tag == null) return;
  const { x, y, width, height } = event.nativeEvent.layout;
  register(tag, { x, y, width, height });
}

/**
 * Wrap any subtree to mark its bounding box as sensitive. The native screenshot
 * pipeline blurs / blackboxes the rect before the image leaves the device
 * (PRIV-02 / PRIV-03).
 */
export function EverframeSensitive(props: ViewProps): React.ReactElement {
  const { sensitive } = useEverframe();
  const viewRef = React.useRef<React.ComponentRef<typeof View>>(null);

  const userOnLayout = props.onLayout;
  const onLayout = React.useCallback(
    (e: LayoutChangeEvent) => {
      handleSensitiveLayout(
        viewRef.current as unknown,
        sensitive.register,
        e as { nativeEvent: { layout: Rect } }
      );
      userOnLayout?.(e);
    },
    [sensitive.register, userOnLayout]
  );

  return React.createElement(SensitiveHost, { ...props, ref: viewRef, onLayout,
    ...(Platform.OS === 'android' ? { collapsable: false } : {}) });
}

/**
 * Imperatively mark an already-instantiated host (e.g., a third-party
 * <TextInput> wrapper). Pass a ref and a rect; the hook registers on each
 * rect change (RESEARCH §5.3). This effect runs after mounting and cannot protect
 * first paint. Use EverframeSensitive for mount-time Android video privacy.
 */
export function useEverframeSensitiveRef<T>(
  ref: React.RefObject<T | null>,
  rect: Rect | null
): void {
  const { sensitive } = useEverframe();
  React.useEffect(() => {
    if (!rect) return;
    const node = ref.current as unknown as NativeTagHost | null;
    if (!node) return;
    const tag = readNativeTag(node);
    if (tag != null) {
      sensitive.register(tag, rect);
    }
  }, [ref, rect, sensitive]);
}
