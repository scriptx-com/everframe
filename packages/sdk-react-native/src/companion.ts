// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. This namespace stays as deprecated
// no-op stubs until the next major so apps that follow the docs keep
// compiling: `start()` logs one warning per app session and reaches no native
// code, every `on*` returns an unsubscribe without ever calling its handler,
// and `useCompanion()` returns the same idle object on every render.

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionState = 'unpaired' | 'paired' | 'report_in_progress' | 'phone_disconnected';

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export interface CompanionAttachChallenge {
  code: string;
  requestedByName: string;
  ttlMs: number;
}

import { warnCompanionRemovedOnce } from './companion-deprecation.js';

const noop = (): void => undefined;

/**
 * Logs the removal warning once. Reaches no native code and never throws.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function start(): void {
  warnCompanionRemovedOnce();
}

/**
 * Does nothing.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function stop(): void {
  /* nothing to stop */
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onRunning(_handler: (running: boolean) => void): () => void {
  return noop;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onState(_handler: (state: CompanionState) => void): () => void {
  return noop;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onPairUrl(_handler: (url: string | null) => void): () => void {
  return noop;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onCode(_handler: (code: string | null) => void): () => void {
  return noop;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onAttachedUserName(_handler: (name: string | null) => void): () => void {
  return noop;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onResolvedName(_handler: (name: string | null) => void): () => void {
  return noop;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export function onAttachChallenge(
  _handler: (challenge: CompanionAttachChallenge | null) => void,
): () => void {
  return noop;
}

const IDLE = Object.freeze({
  state: 'unpaired' as CompanionState,
  pairUrl: null,
  code: null,
  attachedUserName: null,
  resolvedName: null,
  attachChallenge: null,
  running: false,
});

/**
 * Returns the idle Companion snapshot — the same object on every render.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function useCompanion(): {
  state: CompanionState;
  pairUrl: string | null;
  code: string | null;
  attachedUserName: string | null;
  resolvedName: string | null;
  attachChallenge: CompanionAttachChallenge | null;
  running: boolean;
} {
  return IDLE;
}
