// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { EverframeConfig } from '@everframe/sdk-core';
import type { ReporterTheme } from '../branding/theme.js';

export interface WebEverframeConfig extends EverframeConfig {
  /** CSP nonce threaded into screenshot lib + injected styles. Required under strict CSP. */
  cspNonce?: string;
  /** Console patcher overrides — capacity defaults to 250; levels defaults to all 5. */
  console?: { maxEntries?: number; levels?: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> };
  /** Network patcher overrides — capacity defaults to 100. */
  network?: { maxEntries?: number };
  /**
   * Render the reporter inside a Shadow DOM for style isolation. Default true.
   *
   * Opting out renders into a plain `<div>` and injects the stylesheet into the
   * document head instead — the reporter then inherits host page CSS and can be
   * affected by it. Provided for hosts whose tooling cannot pierce shadow roots
   * (some e2e frameworks, some screen-reader automation).
   *
   * SCOPE: honoured by `@everframe/web`'s `init()` only. `WebEverframeConfig` is
   * re-exported as public type surface by `@everframe/react`, where nothing
   * reads this flag — that Provider portals the reporter into `document.body`
   * unconditionally, as it always has, so setting it there has no effect in
   * either direction.
   */
  __everframeShadowDom?: boolean;
  /**
   * Reporter window theme (branding spec 2026-08-25) — 8 semantic color
   * roles, #rrggbb strings only. Applies ONLY once the server confirms a
   * paid plan (the /api/config branding block says watermark: false);
   * per-field precedence is server theme → this inline theme → default.
   */
  theme?: ReporterTheme;
  /**
   * Session Vitals (spec 2026-09-01) local override. `enabled: false` ALWAYS
   * wins over the server's `vitalsEnabled: true` — a host that opts out never
   * starts the collector no matter what the server says. `sampleRate` is
   * combined with the server's own rate via `Math.min`, so a host can only
   * narrow the sampled population, never widen it past what the server
   * allows. Absent means "defer entirely to the server" (enabled: true is the
   * implicit default; sampleRate defaults to 1, i.e. no additional local
   * narrowing). `captureSourceQuery` keeps query strings on `source_change`
   * URLs (default stripped — signed CDN/license URLs carry tokens).
   */
  vitals?: { enabled?: boolean; sampleRate?: number; captureSourceQuery?: boolean };
}
