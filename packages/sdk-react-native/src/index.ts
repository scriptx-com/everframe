// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// @everframe/react-native public barrel.
//
// Architecture (Phase 06, D-05/D-07 flip 2026-05-11):
// - <EverframeProvider config={...}> owns configure-on-mount and the React
//   context plumbing. The native TXReporterPresenter owns the entire report
//   UX (capture, annotate, redact, submit).
// - Android/iOS shake-to-report is owned by the native SDK. Hosts call
//   `useEverframe().open()` for every other trigger; the call resolves when
//   the user submits or cancels the native modal.
// - <EverframeSensitive> + useEverframeSensitiveRef forward to
//   NativeEverframe.registerSensitiveRect so the native modal redacts
//   React-rendered views before capture.
// - No JavaScript trigger code; native mobile shake is the sole SDK-owned
//   trigger. Buttons, hotkeys, overlays, and TV triggers remain host-owned.

// Provider + hook (the canonical surface).
export { EverframeProvider, useEverframe } from './EverframeProvider.js';
export type { EverframeProviderProps } from './EverframeProvider.js';

// Sensitive wrapper + hook.
export { EverframeSensitive, useEverframeSensitiveRef } from './Sensitive.js';

// Top-level imperative open() + companion helpers (re-exported from the
// context seam) for non-component call sites.
export {
  open,
  captureException,
  setExtra,
  setUser,
  addBreadcrumb,
  recordScreen,
  EverframeNotMountedError,
} from './contextSeam.js';
export type { EverframeContextValue } from './contextSeam.js';
export type { EverframeIntegration } from './integrations/types.js';

// Reporter result type.
export type { ReporterResult } from './reporter/types.js';

// Navigation screen markers (spec 2026-07-14) — one line per screen, any
// nav stack. See EverframeScreen.tsx header for per-stack recipes.
export { useEverframeScreen, EverframeScreen } from './EverframeScreen.js';
export type { EverframeScreenProps } from './EverframeScreen.js';

// Session Vitals (spec 2026-09-06) — library-agnostic player bridge + log line.
export { trackPlayer, trackVitals, useTrackPlayer } from './vitals.js';
export type { HostPlayerEventType, PlayerHandle, PlayerStats, TrackPlayerOptions } from './vitals.js';
export type { VitalsPlayerEventType } from '@everframe/protocol';

// Bridge-level types still useful at the JS boundary.
export type { ConfigOpts, Rect, Spec, EverframeUserSpec } from './NativeEverframe.js';

// Phone-companion bridge (Plan 06.2-11). Namespace import mirrors the
// `Everframe.shared.companion` / `Everframe.companion` shape on iOS / Android:
//
//   import { companion, useCompanion } from '@everframe/react-native';
//   useEffect(() => { companion.start(endpoint); return () => companion.stop(); }, []);
//   const { state, pairUrl } = useCompanion();
export * as companion from './companion.js';
export { useCompanion } from './companion.js';
export type { CompanionState } from './companion.js';

// Re-export protocol + sdk-core for ergonomic single-import.
export type {
  ReportEnvelope,
  UITree,
  UINode,
  AttachmentRef,
} from '@everframe/protocol';
export type { CaptureExceptionOptions, ReportDraft, DeviceMetadata } from '@everframe/sdk-core';
/**
 * The `setExtra` payload ceiling (16 KiB), re-exported so a host that wants
 * to trim its own `extra` object can check its size against the real limit
 * and decide what to drop — that decision needs knowledge of what the
 * host's own fields mean, which only the host has. The SDK never evicts
 * keys on your behalf: an over-budget payload is simply omitted, with a
 * warning, from the next report.
 */
export { EXTRA_MAX_CHARS } from '@everframe/sdk-core';
