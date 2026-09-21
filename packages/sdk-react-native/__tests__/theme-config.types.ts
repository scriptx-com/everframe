// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Compile-time guard, not a runtime test — the same NN4 idiom as
// `companion-badge-config.types.ts`.
//
// `ConfigOpts` declares 8 flat, wire-shaped theme fields (`themeBackground`,
// `themeAccent`, …) purely for RN codegen, which cannot express the nested
// `theme: { … }` object. `RuntimeConfig` must Omit ALL of them so the nested
// `theme` is the ONLY public surface — without the Omit, a host passing the
// (also-valid-looking) flat form would type-check and silently no-op, since
// `extractBridgeConfig` only ever reads the nested object.
//
// NOT picked up by vitest — `.types.ts` doesn't match the test glob; it runs
// under `tsc` via `tsconfig.test.json` (part of `pnpm typecheck`). A
// `@ts-expect-error` line FAILS the compile if the expected error stops
// occurring — i.e. exactly if the Omit ever regresses.
import type { RuntimeConfig } from '../src/runtime.js';

// The flat, wire-shaped keys must be REJECTED on the host-facing type.
const flatAccentRejected: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  // @ts-expect-error — themeAccent is not a RuntimeConfig key; host code must use the nested `theme: { accent }` instead.
  themeAccent: '#336699',
};

const flatBackgroundRejected: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  // @ts-expect-error — themeBackground is not a RuntimeConfig key; host code must use the nested `theme: { background }` instead.
  themeBackground: '#101314',
};

const flatTextMutedRejected: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  // @ts-expect-error — themeTextMuted is not a RuntimeConfig key; host code must use the nested `theme: { textMuted }` instead.
  themeTextMuted: '#8fa0a6',
};

const flatAccentForegroundRejected: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  // @ts-expect-error — themeAccentForeground is not a RuntimeConfig key; host code must use the nested `theme: { accentForeground }` instead.
  themeAccentForeground: '#0b0d0e',
};

// The nested shape must still compile cleanly — proves the Omit didn't
// remove the real, intended surface along with the flat one.
const nestedShapeAccepted: RuntimeConfig = {
  apiKey: 'txx_live_test1234567890',
  theme: {
    background: '#101314',
    surface: '#181c1e',
    border: '#2a3134',
    text: '#e8ecee',
    textMuted: '#8fa0a6',
    accent: '#336699',
    accentForeground: '#0b0d0e',
    destructive: '#e5484d',
  },
};
