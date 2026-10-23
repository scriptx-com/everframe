// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion namespace barrel (deprecated). Everframe Companion has been
// removed: every member is a no-op stub kept until the next major. Surfaced
// from `packages/sdk-web/src/index.ts` as `export * as companion`, and
// re-composed (plus `useCompanion`) by `packages/sdk-react/src/companion/index.ts`.
'use client';

export { createCompanion, start, stop } from './singleton.js';
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
} from './singleton.js';
