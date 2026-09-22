// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding NN4 — compile-time guard, not a runtime test.
//
// `RuntimeConfig` used to structurally inherit `companionBadgeEnabled` /
// `companionBadgePosition` from `ConfigOpts` (the wire type) IN ADDITION TO
// declaring its own nested `companionBadge?: { enabled?; position? }` below
// it — so `{ companionBadgeEnabled: false }` type-checked as a perfectly
// valid host config and silently no-opped: `extractBridgeConfig` only ever
// reads the nested `companionBadge` object, never the flat keys. `runtime.ts`
// now Omits both flat keys from the inherited `ConfigOpts` half, making the
// nested `companionBadge` the ONLY public surface for this option — this
// file locks that in at compile time.
//
// NOT picked up by vitest — `__tests__/**/*.{test,spec}.{ts,tsx}` (see
// vitest.config.ts) doesn't match a `.types.ts` suffix. It exists purely for
// `tsc`'s benefit via `tsconfig.test.json`'s `__tests__/**/*` include, run
// by `pnpm typecheck` (part of `pnpm check`). A `@ts-expect-error` line
// FAILS the compile if the expected error stops occurring — i.e. exactly
// if this fix ever regresses.
import type { RuntimeConfig } from '../src/runtime.js';

// The flat, wire-shaped keys must be REJECTED on the host-facing type.
const flatEnabledRejected: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  // @ts-expect-error — companionBadgeEnabled is not a RuntimeConfig key; host code must use the nested `companionBadge: { enabled }` instead.
  companionBadgeEnabled: false,
};

const flatPositionRejected: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  // @ts-expect-error — companionBadgePosition is not a RuntimeConfig key; host code must use the nested `companionBadge: { position }` instead.
  companionBadgePosition: 'top-left',
};

// The nested shape must still compile cleanly — proves the Omit above
// didn't remove the real, intended surface along with the flat one.
const nestedShapeAccepted: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  companionBadge: { enabled: false, position: 'top-left' },
};
