// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 — Companion namespace barrel. Surfaced from
// `packages/sdk-web/src/index.ts` as `export * as companion`, and re-composed
// (plus `useCompanion`) by `packages/sdk-react/src/companion/index.ts`.
'use client';

export { createCompanion } from './state.js';
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
} from './state.js';

export { announce } from './announce.js';
export type { AnnounceResult, AnnounceDeviceBlock } from './announce.js';

export { createRelayWSClient } from './ws-client.js';
export type {
  RelayWSClient,
  RelayWSClientOpts,
  RelayMessage,
  ReportSubmit,
} from './ws-client.js';

export { handleReportRequest, handleReportSubmit } from './capture-bridge.js';
export type { ReportCounts } from './capture-bridge.js';

// Singleton surface — mirrors the RN SDK (companion.start / stop). Hosts
// that need multiple companion instances or custom capture wiring keep using
// the factory exports above.
//
// `useCompanion` is deliberately ABSENT here: it is the one React-coupled
// member of this namespace, and this barrel is reachable from
// `@everframe/web`'s always-loaded entry, which must never pull react into
// its module graph. `@everframe/react` re-composes the namespace — these
// exports plus its own `useCompanion` — in its own src/companion/index.ts.
export { start, stop, __setCompanionDefaults } from './singleton.js';
export type {
  CompanionStartOptions,
  AttachPinUiMode,
  CompanionBadgeOptions,
  BadgePosition,
} from './singleton.js';
