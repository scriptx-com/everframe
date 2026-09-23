// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 — Companion namespace barrel. Surfaced from
// `packages/sdk-react/src/index.ts` as `export * as companion`.
//
// The machinery itself lives in `@everframe/web` (src/companion/), which is
// framework-free by construction. This file re-composes that namespace with
// the one React-coupled member — `useCompanion` — so `@everframe/react`'s
// `companion.*` surface is exactly what it has always been. Keep the member
// list in lockstep with packages/sdk-web/src/companion/index.ts: anything
// added there and forgotten here silently disappears from the React SDK's
// public API.
//
// WHY THE TYPES ARE RE-DECLARED AS LOCAL ALIASES rather than re-exported with
// `export type { … } from '@everframe/web'`: tsup's dts step (rollup-plugin-dts)
// loses the type-ness of a name re-exported from an EXTERNAL module when it
// then has to synthesise a namespace for `export * as companion`. It emits
// `declare const index_CompanionState: typeof CompanionState` — a value — and
// every consumer writing `companion.CompanionState` in a type position gets
// TS2749 ("refers to a value, but is being used as a type here"). That is not
// hypothetical: examples/react-tv-sample does exactly that, and it is the
// documented public shape. A local `export type X = web.X` alias emits
// `type index_X = X` and the namespace stays usable in type positions.
'use client';

import type * as web from '@everframe/web';

export { createCompanion } from '@everframe/web';
export type CompanionAPI = web.CompanionAPI;
export type CompanionState = web.CompanionState;
export type CompanionStateHandler = web.CompanionStateHandler;
export type CompanionPairUrlHandler = web.CompanionPairUrlHandler;
export type CompanionCodeHandler = web.CompanionCodeHandler;
export type CompanionAttachedUserNameHandler = web.CompanionAttachedUserNameHandler;
export type CompanionResolvedNameHandler = web.CompanionResolvedNameHandler;
export type CompanionAttachChallenge = web.CompanionAttachChallenge;
export type CompanionAttachChallengeHandler = web.CompanionAttachChallengeHandler;

export { announce } from '@everframe/web';
export type AnnounceResult = web.AnnounceResult;
export type AnnounceDeviceBlock = web.AnnounceDeviceBlock;

export { createRelayWSClient } from '@everframe/web';
export type RelayWSClient = web.RelayWSClient;
export type RelayWSClientOpts = web.RelayWSClientOpts;
export type RelayMessage = web.RelayMessage;
export type ReportSubmit = web.ReportSubmit;

export { handleReportRequest, handleReportSubmit } from '@everframe/web';
export type ReportCounts = web.ReportCounts;

// Singleton surface — mirrors the RN SDK (companion.start / stop /
// useCompanion). Hosts that need multiple companion instances or custom
// capture wiring keep using the factory exports above.
export { start, stop } from '@everframe/web';
export type CompanionStartOptions = web.CompanionStartOptions;
export type AttachPinUiMode = web.AttachPinUiMode;
export type CompanionBadgeOptions = web.CompanionBadgeOptions;
export type BadgePosition = web.BadgePosition;
export { useCompanion } from './use-companion.js';
