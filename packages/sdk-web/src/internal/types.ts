// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { BreadcrumbInput, EverframeConfig } from '@everframe/sdk-core';
import type { ReporterTheme } from '../branding/theme.js';
import type { HostVisualCapture } from '../capture/host-visual.js';

/** The web config a host passes to `init` or `<EverframeProvider>`. */
export interface WebEverframeConfig extends EverframeConfig {
  /** Page-session health is on for versioned production builds. Opting out keeps error reporting active. */
  releaseHealth?: { enabled?: boolean };
  /** Renderer host attribution; absent keeps ordinary web identity. */
  sdkName?: 'everframe-flutter' | 'everframe-kmp';
  /** Host package version when sdkName names a renderer host. */
  sdkVersion?: string;
  /** Renderer-owned masked PNG and optional image replay. No DOM fallback on capture failure. */
  visualCapture?: HostVisualCapture;
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
  /**
   * Quick capture on Samsung Tizen and LG webOS TVs (device linking and the
   * remote capture gesture). CLIENT VETO only: `disabled: true` turns it off
   * on this app whatever the dashboard says; it can never turn it on. Other
   * browsers never run it.
   */
  quickCapture?: { disabled?: boolean };
  /**
   * Which kinds the SDK records breadcrumbs for on its own (taps, network,
   * console, navigation, lifecycle, uncaught errors). CLIENT VETO only: the
   * effective set is this list intersected with the dashboard's, so it can
   * turn kinds off on this app but never turn one on. Unset keeps the
   * dashboard's set. Breadcrumbs added with `addBreadcrumb` are recorded
   * whatever their kind.
   */
  breadcrumbs?: { kinds?: Array<BreadcrumbInput['kind']> };
}
