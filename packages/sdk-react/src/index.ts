// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

import type { CaptureExceptionOptions as WebCaptureExceptionOptions } from '@traceitx/web';

export { getNativeTagFromHostFiber } from './capture/host-tag-rn.js';
export { TraceItXProvider } from './provider.js';
export type { TraceItXProviderProps } from './provider.js';
export type { IdentityProp } from './identity-prop.js';
export { useTraceItX } from './hook.js';
export type { UseTraceItXReturn } from './hook.js';
export { useTrackPlayer } from './useTrackPlayer.js';
export { trackPlayer, trackVitals, hlsIntegration, shakaIntegration } from '@traceitx/web';
export type { PlayerHandle, TrackPlayerOptions, PlayerIntegration } from '@traceitx/web';
export { Sensitive } from './sensitive/Sensitive.js';
export type { SensitiveProps } from './sensitive/Sensitive.js';
export type { WebTraceItXConfig, ReporterTheme } from '@traceitx/web';

// Top-level imperative `open()` for non-component call sites (global error
// handlers, route handlers, etc.). Mirrors the RN SDK surface; throws if no
// <TraceItXProvider> is mounted.
export { open, addBreadcrumb, captureException, recordScreen, setUser, setExtra, TraceItXNotMountedError } from './contextSeam.js';
export type { ReporterResult } from '@traceitx/web';
export { useTXScreen, TXScreen } from './TXScreen.js';
export type { TXScreenProps } from './TXScreen.js';

// Phase 06.2-09 — React-TV companion namespace (Tizen / WebOS browser runtime).
// Mirrors the RN SDK surface — `companion` namespace plus top-level
// `useCompanion` + `CompanionState` ergonomic re-exports.
export * as companion from './companion/index.js';
export { useCompanion } from './companion/index.js';
export type { CompanionState } from './companion/index.js';

// Re-exports from sdk-core for ergonomic single-import for consumers.
export type {
  AddBreadcrumbInput,
  CaptureExceptionOptions,
  TraceItXConfig,
  TraceItXClient,
  UserMetadata,
  Rect,
  ReportDraft,
  IdentityTokenSource,
} from '@traceitx/sdk-core';
/**
 * The `setExtra` payload ceiling (16 KiB), re-exported so a host that wants
 * to trim its own `extra` object can check its size against the real limit
 * and decide what to drop — that decision needs knowledge of what the
 * host's own fields mean, which only the host has. The SDK never evicts
 * keys on your behalf: an over-budget payload is simply omitted, with a
 * warning, from the next report.
 */
export { EXTRA_MAX_CHARS } from '@traceitx/sdk-core';
export type ErrorSeverity = NonNullable<WebCaptureExceptionOptions['severity']>;
