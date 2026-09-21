// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React Native host-fiber native-tag probe — Fabric/Paper dual-shape.
//
// NOTE: deliberately NO `'use client'` directive — that pragma is a web-bundler
// signal (Next.js/RSC) and RN bundlers (Metro/Re.Pack) do not recognize it.
// Phase 06 PATTERNS §3 row 3.
//
// NOTE: deliberately NO `bippy` import — bippy's host helpers are DOM-coupled
// (`Element.tagName`, `getFiberFromHostInstance(rootEl: Element)`); calling them
// from RN throws. Phase 06 RESEARCH Pitfall P14.

/**
 * Probe the native view tag from a host fiber's `stateNode`.
 *
 * RN's reconciler stores the native tag under different shapes depending on
 * renderer + RN version:
 *   - Fabric (RN ≥ 0.80, including 0.85+):  `stateNode.canonical.nativeTag`
 *       Confirmed against react-native-tvos@0.85.3 in
 *       Libraries/Renderer/implementations/ReactFabric-dev.js:15913-15918 —
 *       `getPublicInstance(instance)` reads `instance.canonical.nativeTag`
 *       (no leading underscore). The `_nativeTag` form was the pre-0.80 name
 *       which we keep around below as a fallback.
 *   - Fabric (RN 0.70–0.79):                `stateNode.canonical._nativeTag`
 *   - Fabric public instance:               `stateNode.__nativeTag`
 *       When a ref resolves to the public instance (ReactNativeElement) the
 *       stateNode is that instance itself; the tag is exposed via the
 *       double-underscore `__nativeTag` accessor (ReactFabricPublicInstance
 *       Utils.js:23).
 *   - Paper (legacy architecture):          `stateNode._nativeTag`
 *
 * Returns `null` if no shape is present (e.g. the fiber's stateNode is the
 * function-component placeholder `null` or an unrelated host shape). On the
 * FIRST null encounter the function emits a single `console.warn` so a
 * developer can notice the gap without log spam.
 *
 * Phase 06 RESEARCH §4.2; RN 0.85 shape added 2026-05-25 when the cross-tree
 * join silently fell back to "uiTree only" on react-native-tvos@0.85.3.
 */
let warnedMissingTag = false;

/** test-only — re-arm the warn-once gate so specs are isolatable. */
export function __resetHostTagWarn(): void {
  warnedMissingTag = false;
}

export function getNativeTagFromHostFiber(fiber: { stateNode?: unknown }): number | null {
  const sn = fiber.stateNode;
  if (!sn || typeof sn !== 'object') return warnAndNull();

  // Fabric (RN ≥ 0.80): stateNode.canonical.nativeTag
  // Fabric (RN  < 0.80): stateNode.canonical._nativeTag
  const canonical = (sn as { canonical?: unknown }).canonical;
  if (canonical && typeof canonical === 'object') {
    const newTag = (canonical as { nativeTag?: unknown }).nativeTag;
    if (typeof newTag === 'number') return newTag;
    const legacyTag = (canonical as { _nativeTag?: unknown })._nativeTag;
    if (typeof legacyTag === 'number') return legacyTag;
  }

  // Fabric public instance (ReactNativeElement): stateNode.__nativeTag
  const publicTag = (sn as { __nativeTag?: unknown }).__nativeTag;
  if (typeof publicTag === 'number') return publicTag;

  // Paper: stateNode._nativeTag
  const paperTag = (sn as { _nativeTag?: unknown })._nativeTag;
  if (typeof paperTag === 'number') return paperTag;

  return warnAndNull();
}

function warnAndNull(): null {
  if (!warnedMissingTag) {
    warnedMissingTag = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[traceitx] RN host fiber stateNode missing _nativeTag (neither Fabric nor Paper shape).'
    );
  }
  return null;
}
