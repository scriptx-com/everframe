// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion namespace barrel (deprecated). Everframe Companion has been
// removed: every member is a no-op stub kept until the next major so apps
// that follow the docs keep compiling. Surfaced from
// `packages/sdk-react/src/index.ts` as `export * as companion`.
//
// The stubs live in `@everframe/web` (src/companion/); this file re-composes
// that namespace with the one React-coupled member — `useCompanion`. Keep the
// member list in lockstep with packages/sdk-web/src/companion/index.ts.
//
// WHY THE TYPES ARE RE-DECLARED AS LOCAL ALIASES rather than re-exported with
// `export type { … } from '@everframe/web'`: tsup's dts step (rollup-plugin-dts)
// loses the type-ness of a name re-exported from an EXTERNAL module when it
// then has to synthesise a namespace for `export * as companion`. It emits
// `declare const index_CompanionState: typeof CompanionState` — a value — and
// every consumer writing `companion.CompanionState` in a type position gets
// TS2749. A local `export type X = web.X` alias emits `type index_X = X` and
// the namespace stays usable in type positions.
'use client';

import type * as web from '@everframe/web';

export { createCompanion, start, stop } from '@everframe/web';
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionAPI = web.CompanionAPI;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionState = web.CompanionState;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionStateHandler = web.CompanionStateHandler;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionPairUrlHandler = web.CompanionPairUrlHandler;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionCodeHandler = web.CompanionCodeHandler;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionAttachedUserNameHandler = web.CompanionAttachedUserNameHandler;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionResolvedNameHandler = web.CompanionResolvedNameHandler;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionAttachChallenge = web.CompanionAttachChallenge;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionAttachChallengeHandler = web.CompanionAttachChallengeHandler;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionStartOptions = web.CompanionStartOptions;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type AttachPinUiMode = web.AttachPinUiMode;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type CompanionBadgeOptions = web.CompanionBadgeOptions;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture. */
export type BadgePosition = web.BadgePosition;
export { useCompanion } from './use-companion.js';
