// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: what the capture gesture does on a web TV, from
// the contract's device behavior table. Eager and pure.
//
//   linked (user or team)        → capture with the token, swallow the gesture's keys
//   unlinked, debug build        → capture shared; also a hello if linking is on
//   unlinked, release build      → nothing visible; a hello if linking is on
//   quick capture off            → nothing, and the gesture is not armed
import type { ReplayConfig } from '@everframe/sdk-core';
import type { WebEverframeConfig } from '../internal/types.js';
import type { DeviceLinkOwner } from './token.js';

export interface GestureInput {
  quickCaptureEnabled: boolean;
  linkingEnabled: boolean;
  owner: DeviceLinkOwner | null;
  debugBuild: boolean;
}

export interface GestureDecision {
  capture: boolean;
  sendHello: boolean;
  swallowKeys: boolean;
}

export function decideGesture(i: GestureInput): GestureDecision {
  const qc = i.quickCaptureEnabled;
  return {
    capture: qc && (i.owner !== null || i.debugBuild),
    sendHello: qc && i.owner === null && i.linkingEnabled,
    swallowKeys: qc && i.owner !== null,
  };
}

/** Whether the gesture does anything at all on this device. */
export function isGestureArmed(i: GestureInput): boolean {
  return i.quickCaptureEnabled && (i.owner !== null || i.debugBuild || i.linkingEnabled);
}

/**
 * Linked devices and debug builds keep a replay buffer while quick capture is
 * armed and `captureHotkey.replay` is on. End users' TVs are unaffected.
 */
export function forcesReplay(i: GestureInput & { replay: boolean }): boolean {
  return i.quickCaptureEnabled && i.replay && (i.owner !== null || i.debugBuild);
}

/**
 * Quick capture is on when the server's `captureHotkey.enabled` is true and
 * nothing local vetoes it: the SDK kill switch, `disabled`,
 * `quickCapture.disabled` or `reporter.disabled`.
 */
export function quickCaptureEnabled(
  config: WebEverframeConfig,
  server: ReplayConfig,
  killed: boolean,
): boolean {
  return (
    !killed &&
    config.disabled !== true &&
    config.quickCapture?.disabled !== true &&
    config.reporter?.disabled !== true &&
    server.captureHotkey?.enabled === true
  );
}
