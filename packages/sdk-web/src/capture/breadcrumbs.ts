// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
//
// Web breadcrumb capture installers (spec §5, web). Each installer converts
// one class of platform event into a typed BreadcrumbInput and pushes it to
// the shared sink — the sdk-core client's breadcrumb ring buffer, which owns
// redaction (mask-before-bytes) and the freeze lifecycle. Installers hold NO
// buffer state of their own.
//
// The KindGate is a LIVE predicate (reads the latest server config on every
// event) so a kind disabled by config stops being captured the moment config
// resolves — "disabled kinds are not captured at all" (spec §6).
import type { BreadcrumbInput, BreadcrumbBuffer } from '@everframe/sdk-core';

export type CrumbSink = (input: BreadcrumbInput) => void;
export type BreadcrumbKindName = BreadcrumbInput['kind'];
export type KindGate = (kind: BreadcrumbKindName) => boolean;
/** Crash/error reporting hook (spec 2026-07-18) — see logs.ts crashSink option. */
export type CrashSink = (error: unknown, mechanism: 'onerror' | 'unhandledrejection') => void;

/**
 * Module-level crumb-hook slot (same single-instance doctrine as buffers.ts):
 * the install-once patchers capture THESE stable forwarding functions, and
 * each createWebPlatformAdapter() call REBINDS the slot to its own sink/gate.
 * A Provider remount (StrictMode double-invoke, Fast Refresh) therefore
 * re-points the already-installed patchers at the live adapter instead of
 * leaving them wired to a dead one.
 */
let boundSink: CrumbSink | null = null;
let boundGate: KindGate | null = null;

export function __bindCrumbHooks(sink: CrumbSink, gate: KindGate): void {
  boundSink = sink;
  boundGate = gate;
}

export const forwardingCrumbSink: CrumbSink = (input) => {
  try {
    boundSink?.(input);
  } catch {
    /* swallow — DEFE-02 */
  }
};

export const forwardingCrumbGate: KindGate = (kind) => {
  try {
    return boundGate ? boundGate(kind) : true;
  } catch {
    return true;
  }
};

/**
 * Crash-sink slot — same module-level rebind doctrine as boundSink/boundGate
 * above. installConsolePatcher is install-once (global Symbol marker), so the
 * patcher must capture THIS stable forwarder, never an adapter's crashSink
 * directly: a Provider remount (StrictMode double-invoke, Fast Refresh) rebinds
 * the slot to the live adapter's sink — or to null when the new config vetoes
 * crash reporting (crashReporting.disabled / disabled), which makes the
 * forwarder a no-op even though an earlier mount had an active sink.
 */
let boundCrashSink: CrashSink | null = null;

export function __bindCrashSink(sink: CrashSink | null): void {
  boundCrashSink = sink;
}

export const forwardingCrashSink: CrashSink = (error, mechanism) => {
  try {
    boundCrashSink?.(error, mechanism);
  } catch {
    /* swallow — DEFE-02 */
  }
};

/**
 * Apply a resolved server config to the live buffer: cap the capacity, and —
 * when the server has disabled breadcrumbs outright — zeroize the chain so a
 * kill-switch actually empties what would ship (spec §6 doctrine; matches
 * replay's fail-closed spirit even though breadcrumbs default ON).
 */
export function applyBreadcrumbsConfigToBuffer(
  buffer: BreadcrumbBuffer | undefined,
  config: { enabled: boolean; maxCount: number },
): void {
  if (!buffer) return;
  if (!config.enabled) {
    buffer.clear();
    return;
  }
  buffer.setMaxCount(config.maxCount);
}

const HISTORY_MARKER = Symbol.for('__everframe_patched_history__');

/**
 * installNavigationCrumbs — patches history.pushState/replaceState and listens
 * for popstate; emits `navigation` crumbs as `from → to` (pathname + search).
 * Same-URL transitions are no-ops. Idempotent via the history marker symbol.
 */
export function installNavigationCrumbs(sink: CrumbSink, gate: KindGate): () => void {
  if (typeof window === 'undefined' || typeof history === 'undefined') {
    return () => undefined; // SSR / non-browser
  }
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (slot[HISTORY_MARKER]) return () => undefined;
  slot[HISTORY_MARKER] = true;

  let lastUrl = window.location.pathname + window.location.search;
  const emit = (): void => {
    try {
      const to = window.location.pathname + window.location.search;
      if (to === lastUrl) return;
      const from = lastUrl;
      lastUrl = to; // track even when gated so a later-enabled kind gets true `from`
      if (!gate('navigation')) return;
      sink({ kind: 'navigation', message: `${from} → ${to}`, data: { from, to } });
    } catch {
      /* swallow — DEFE-02 */
    }
  };

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History['pushState']>): void => {
    origPush(...args);
    emit();
  };
  history.replaceState = (...args: Parameters<History['replaceState']>): void => {
    origReplace(...args);
    emit();
  };
  window.addEventListener('popstate', emit);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener('popstate', emit);
    delete slot[HISTORY_MARKER];
  };
}

/**
 * installLifecycleCrumbs — `visibilitychange` → `lifecycle` crumb
 * (`visibility: hidden` / `visibility: visible`). Tab switches and app
 * backgrounding are the web's lifecycle signal (spec §5).
 */
const LIFECYCLE_MARKER = Symbol.for('__everframe_patched_lifecycle__');

export function installLifecycleCrumbs(sink: CrumbSink, gate: KindGate): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (slot[LIFECYCLE_MARKER]) return () => undefined;
  slot[LIFECYCLE_MARKER] = true;

  const onVisibility = (): void => {
    try {
      if (!gate('lifecycle')) return;
      const state = document.visibilityState;
      sink({ kind: 'lifecycle', message: `visibility: ${state}`, data: { state } });
    } catch {
      /* swallow — DEFE-02 */
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    delete slot[LIFECYCLE_MARKER];
  };
}

/** Elements we treat as the tap target when found within 5 ancestor hops. */
const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'select', 'textarea', 'summary', 'label',
]);
const MAX_LABEL_CHARS = 48;

/**
 * describeEventTarget — climb ≤5 hops to the nearest interactive ancestor
 * (button/a/input/…/role=button|link), then derive a redaction-safe label:
 * aria-label → visible text (≤48 chars, whitespace-collapsed) → tag#id → tag.
 * If the resolved element intersects the sensitive-registry mask set, the
 * label is '[masked]' and NO text is read out of the subtree.
 */
export function describeEventTarget(
  target: Element,
  masked: readonly Element[],
): { label: string; masked: boolean; meta: { tag: string; id?: string; role?: string } } {
  let el: Element = target;
  let found: Element = target;
  for (let hops = 0; hops < 5; hops++) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (INTERACTIVE_TAGS.has(tag) || role === 'button' || role === 'link') {
      found = el;
      break;
    }
    if (!el.parentElement) break;
    el = el.parentElement;
  }
  const tag = found.tagName.toLowerCase();

  const isMasked = masked.some((m) => m === found || m.contains(found) || found.contains(m));
  if (isMasked) return { label: '[masked]', masked: true, meta: { tag } };

  const meta: { tag: string; id?: string; role?: string } = { tag };
  const id = found.getAttribute('id');
  if (id) meta.id = id;
  const role = found.getAttribute('role');
  if (role) meta.role = role;

  const aria = found.getAttribute('aria-label');
  const text = (found.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
  const label = aria || text || (id ? `${tag}#${id}` : tag);
  return { label, masked: false, meta };
}

/**
 * installTapCrumbs — global capture-phase `pointerdown` listener → `tap`
 * crumbs. Capture phase so stopPropagation() in app handlers can't hide taps.
 * Reporter-UI taps DO reach the live buffer — that's fine: the chain is
 * frozen before the modal opens, so the shipped snapshot never contains them
 * (same doctrine as replay).
 */
const TAP_MARKER = Symbol.for('__everframe_patched_tap__');

export function installTapCrumbs(
  sink: CrumbSink,
  gate: KindGate,
  getMaskedElements: () => readonly Element[],
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (slot[TAP_MARKER]) return () => undefined;
  slot[TAP_MARKER] = true;

  const onPointerDown = (ev: Event): void => {
    try {
      if (!gate('tap')) return;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const d = describeEventTarget(target, getMaskedElements());
      sink({
        kind: 'tap',
        message: `tap ${d.label}`,
        data: { ...d.meta, ...(d.masked ? { masked: true } : {}) },
      });
    } catch {
      /* swallow — DEFE-02 */
    }
  };
  window.addEventListener('pointerdown', onPointerDown, { capture: true });
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    delete slot[TAP_MARKER];
  };
}
