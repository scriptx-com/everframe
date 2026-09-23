// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

import type { CaptureExceptionOptions as WebCaptureExceptionOptions } from '@everframe/web';

export { getNativeTagFromHostFiber } from './capture/host-tag-rn.js';
export { EverframeProvider } from './provider.js';
export type { EverframeProviderProps } from './provider.js';
export type { IdentityProp } from './identity-prop.js';
export { useEverframe } from './hook.js';
export type { UseEverframeReturn } from './hook.js';
export { useTrackPlayer } from './useTrackPlayer.js';
export { trackPlayer, trackVitals, hlsIntegration, shakaIntegration } from '@everframe/web';
export type { PlayerHandle, TrackPlayerOptions, PlayerIntegration } from '@everframe/web';
export { Sensitive } from './sensitive/Sensitive.js';
export type { SensitiveProps } from './sensitive/Sensitive.js';
export type { WebEverframeConfig, ReporterTheme } from '@everframe/web';

// Top-level imperative `open()` for non-component call sites (global error
// handlers, route handlers, etc.). Mirrors the RN SDK surface; throws if no
// <EverframeProvider> is mounted.
export { open, addBreadcrumb, captureException, recordScreen, setUser, setExtra, EverframeNotMountedError } from './contextSeam.js';
export type { ReporterResult } from '@everframe/web';
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
  EverframeConfig,
  EverframeClient,
  UserMetadata,
  Rect,
  ReportDraft,
  IdentityTokenSource,
} from '@everframe/sdk-core';
/**
 * The `setExtra` payload ceiling (16 KiB), re-exported so a host that wants
 * to trim its own `extra` object can check its size against the real limit
 * and decide what to drop — that decision needs knowledge of what the
 * host's own fields mean, which only the host has. The SDK never evicts
 * keys on your behalf: an over-budget payload is simply omitted, with a
 * warning, from the next report.
 */
export { EXTRA_MAX_CHARS } from '@everframe/sdk-core';
export type ErrorSeverity = NonNullable<WebCaptureExceptionOptions['severity']>;
