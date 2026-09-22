// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Navigation screen markers for web. The native SDKs derive `from → to` in
// their platform singleton (see BreadcrumbTapNavAdapters.kt:322); web has no
// native side, so the same five rules live here instead. The OUTPUT SHAPE IS
// THE POINT: a web timeline and a native timeline sit side by side in one
// dashboard, so `kind`, `message` and `data` must match exactly.
//
// Before this existed, `contextSeam.ts` told hosts to hand-roll the crumb.
// They did, each slightly differently.
import type { AddBreadcrumbInput } from '@traceitx/sdk-core';
import { forwardingCrumbGate, type KindGate } from '../capture/breadcrumbs.js';

export type ScreenRecorder = (name: string, data?: Record<string, unknown>) => void;

/**
 * Build a recorder over a crumb sink. The `from` half of each transition is
 * the previous accepted screen, held per recorder rather than globally so
 * tests (and any host running two clients) cannot bleed into each other.
 *
 * `gate` defaults to `forwardingCrumbGate` — the SAME live kind-gate
 * `capture/breadcrumbs.ts`'s auto-capture `installNavigationCrumbs` reads —
 * so a project that disables the `navigation` breadcrumb kind stops getting
 * BOTH History-API crumbs and manual `useTXScreen`/`<TXScreen>` crumbs, not
 * just the former. Matches the native SDKs' `isKindEnabled(Navigation)` gate
 * (`BreadcrumbTapNavAdapters.kt:324`).
 */
export function createScreenRecorder(
  sink: (input: AddBreadcrumbInput) => void,
  gate: KindGate = forwardingCrumbGate,
): ScreenRecorder {
  let previous: string | null = null;

  return (name: string, data?: Record<string, unknown>): void => {
    // A blank name is not a screen. Leave the chain untouched so the NEXT
    // real screen still reports a transition from the last real one.
    const to = typeof name === 'string' ? name.trim() : '';
    if (!to) return;

    const from = previous;
    // Track even when gated — same doctrine as installNavigationCrumbs's
    // `lastUrl`: an un-gating mid-session must see the true previous screen,
    // not a stale one frozen from before the kind was disabled.
    previous = to;

    if (!gate('navigation')) return;
    // Nothing to report a transition FROM — this is the first screen.
    if (from === null) return;
    // Background→foreground, refocus, remount. Not a navigation.
    if (from === to) return;

    sink({
      kind: 'navigation',
      message: `${from} → ${to}`,
      // from/to are authoritative: a host key of the same name must not be
      // able to forge the transition it is attached to.
      data: { ...data, from, to },
    });
  };
}
