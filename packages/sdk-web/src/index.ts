// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `@everframe/web` — the framework-free half of the Everframe web SDK: capture,
// transport, outbox, branding, triggers, the deprecated Companion stubs and
// the reporter stylesheet. `@everframe/react` composes its React
// surface on top of this; a Vue/Svelte/Angular/vanilla host consumes it
// directly.
//
// ALWAYS-LOADED ENTRY. Nothing reachable from this file may statically import
// `react` or `react-dom` — the size-limit budget (Task 10) fails the build if
// React reaches this graph, and `pnpm build && grep -c
// "react-dom\|__SECRET_INTERNALS" dist/index.js` must print 0.
//
// This barrel is also the ONLY supported way into the package: `files` ships
// `dist/` alone, so a deep import into `dist/…` or `src/…` breaks the moment
// this is published. Internal module-level seams (`__set*` / `__get*` /
// `__subscribe*`) are therefore exported here too, even though they are not
// product API — `@everframe/react` reads them across the package boundary.

import type { CaptureExceptionOptions as CoreCaptureExceptionOptions } from '@everframe/sdk-core';

// ── Platform adapter ────────────────────────────────────────────────────
export { createWebPlatformAdapter } from './adapter.js';
export type { WebPlatformAdapter } from './adapter.js';

// ── Configuration + result shapes ───────────────────────────────────────
export type { WebEverframeConfig } from './internal/types.js';
export { EverframeNotMountedError, EverframeReporterDisabledError } from './reporter-types.js';
export type { ReporterResult } from './reporter-types.js';

// ── Version + SDK identity ──────────────────────────────────────────────
// `PKG_VERSION` is THIS package's version. A host package that reports its
// own name/version in `envelope.sdk` (e.g. `@everframe/react`) passes them to
// `createWebPlatformAdapter` — see internal/sdk-identity.ts for why the
// adapter cannot read either from this package's own constants.
export { PKG_VERSION } from './internal/version.js';
export type { HostSdkIdentity, HostSdkName } from './internal/sdk-identity.js';

// ── Imperative lifecycle (framework-agnostic hosts) ─────────────────────
export { init } from './init.js';
export type { Everframe } from './init.js';
export type { CaptureExceptionOptions } from '@everframe/sdk-core';
export type ErrorSeverity = NonNullable<CoreCaptureExceptionOptions['severity']>;

// ── Ingest base URL ──────────────────────────────────────────────────────
// Consumed by `@everframe/react`'s Provider, which needs the same endpoint
// `init.ts` passes to `setupVitals()` below (there is no other public seam
// for it — see constants.ts's own header on why this is a build-time literal).
export { INGEST_URL } from './constants.js';

// ── Session Vitals (spec 2026-09-01) ─────────────────────────────────────
// Exported from THIS barrel, not `./ui.js`: that one also exports
// `ReporterDialog` and a value import of it would drag React into the
// always-loaded graph (see this file's header). `setupVitals` and everything
// it composes (vitals/index.ts, resource-sampler.ts, player-adapter.ts,
// transport.ts, server-config.ts) import nothing from `react`/`react-dom`,
// so re-exporting it here costs the size-limit budget nothing.
export { setupVitals } from './vitals/index.js';
export type { SetupVitalsDeps, VitalsHandle } from './vitals/index.js';
export { trackPlayer, trackVitals } from './vitals/index.js';
export type { PlayerHandle, TrackPlayerOptions } from './vitals/index.js';
export { hlsIntegration } from './vitals/integrations/hls.js';
export { shakaIntegration } from './vitals/integrations/shaka.js';
export type {
  PlayerIntegration,
  PlayerIntegrationContext,
  PlayerSnapshot,
  PlayerStartupTimings,
  PlayerEmit,
} from '@everframe/sdk-core';

// ── Reporter styles ─────────────────────────────────────────────────────
export { injectReporterStyles } from './reporter-ui/style-injector.js';
export { REPORTER_CSS } from './reporter-ui/reporter.css.js';

// ── Branding / theming ──────────────────────────────────────────────────
export { resolveThemeVars, mixHex, hexToRgba } from './branding/theme.js';
export type { ReporterTheme } from './branding/theme.js';
export {
  __setBrandingServerConfig,
  __getBrandingServerConfig,
  __subscribeBrandingServerConfig,
} from './branding/server-config.js';
export {
  __setInlineReporterTheme,
  __getInlineReporterTheme,
  __subscribeInlineReporterTheme,
} from './branding/inline-theme.js';

// Internal bridge consumed by @everframe/react. The generic hotkey helper is
// deliberately not public: the dashboard binding is authoritative.
export { __registerDashboardHotkey } from './triggers/hotkey.js';

// ── Sensitive-region registry ───────────────────────────────────────────
export { sensitiveRegistry, SENSITIVE_ATTR } from './sensitive/registry.js';

// ── Capture ─────────────────────────────────────────────────────────────
export { sha256Hex } from './capture/sha256.js';
export type { HostVisualCapture } from './capture/host-visual.js';
export { createCanvasVisualCapture } from './capture/canvas-visual.js';
export type { CanvasVisualOptions, CanvasSensitiveRect } from './capture/canvas-visual.js';

// ── Outbox ──────────────────────────────────────────────────────────────
export { createOutbox } from './outbox/index.js';
export { createLocalStorageOutbox } from './outbox/localStorage.js';

// ── Transport ───────────────────────────────────────────────────────────
export { submitReportFromDraft, drainOutbox } from './transport/submit.js';
export type { CaptureBundle, BundleScreenshot } from './transport/draft-to-envelope.js';

// ── Reporter credentials ────────────────────────────────────────────────
export { scopedReporterTokenStorageKey } from './reporter/credential-store.js';

// ── Navigation screen markers ────────────────────────────────────────────
export { createScreenRecorder } from './breadcrumbs/record-screen.js';
export type { ScreenRecorder } from './breadcrumbs/record-screen.js';

// ── Companion (removed; deprecated no-op stubs) ─────────────────────────
// Everframe Companion has been removed. The documented members stay until the
// next major so apps that follow the docs keep compiling: `start()` logs one
// warning and opens nothing, every getter is idle, and no handler is called.
// The namespace mirrors `@everframe/react`'s `companion.*`, minus
// `useCompanion` — the one React-coupled member, which lives there.
export * as companion from './companion/index.js';
// The same members, flat, so `@everframe/react` can re-export them by name.
export { createCompanion, start, stop, __getCompanionApi } from './companion/singleton.js';
export type {
  CompanionAPI,
  CompanionState,
  CompanionStateHandler,
  CompanionPairUrlHandler,
  CompanionCodeHandler,
  CompanionAttachedUserNameHandler,
  CompanionResolvedNameHandler,
  CompanionAttachChallenge,
  CompanionAttachChallengeHandler,
  CompanionStartOptions,
  AttachPinUiMode,
  CompanionBadgeOptions,
  BadgePosition,
} from './companion/singleton.js';

// ── Test seams ──────────────────────────────────────────────────────────
// Not product API. Exported only because `@everframe/react`'s specs — which
// cover React surfaces built on these modules — can no longer reach them by
// relative path now that the modules live here.
//
// These, plus `createLocalStorageOutbox` and `scopedReporterTokenStorageKey`
// above, are the members that survived the
// pre-publish surface audit: each has a real consumer in a `@everframe/react`
// spec that imports it as `from '@everframe/web'`, so removing it here would
// mean editing those specs. Every barrel member with NO consumer was dropped
// in that same audit (`INGEST_URL`, the badge-config getter/subscriber, and
// `src/ui.ts`'s portal-target / theme-host seams). Retargeting the remaining
// spec imports at sdk-web's source by relative path is what would take these
// off the published surface too.
export { __filterNodeForTests } from './capture/screenshot.js';
