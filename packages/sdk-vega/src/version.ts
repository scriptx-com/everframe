// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

// Replaced at build time (tsup.config.ts) and in tests (vitest.config.ts) with
// package.json "version", so a changeset release can never ship a stale value.
declare const __EVERFRAME_VEGA_VERSION__: string | undefined;

export const SDK_VERSION: string =
  typeof __EVERFRAME_VEGA_VERSION__ === 'string' ? __EVERFRAME_VEGA_VERSION__ : '0.0.0-dev';
