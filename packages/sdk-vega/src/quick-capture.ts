// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Quick capture rules: what the capture gesture does in each state (the
// real-device quick capture contract's table), and how an ingest reply is
// read for takeover and revoked links.
import { parsePendingAttempt } from './link-client.js';

export const CAPTURE_COOLDOWN_MS = 2000;
export const LINK_NONCE_HEADER = 'X-Everframe-Link-Nonce';
export { CAPTURE_TOKEN_HEADER } from './remote-config.js';
/** Vega has no reporter inbox: a quick capture never asks for a reply thread. */
export const REPLIES_OPT_OUT_HEADER = 'X-Everframe-Replies-Opt-Out';

export interface GestureInput {
  /**
   * The app's `captureHotkey.enabled`, the local `quickCaptureEnabled`, the
   * root wrapper mounted and the stored link loaded, all together.
   */
  quickCaptureEnabled: boolean;
  /** `deviceLinking.enabled`. */
  linkingEnabled: boolean;
  linked: boolean;
  debugBuild: boolean;
}

/**
 * Linked: capture with the token. Unlinked debug build: capture without one,
 * and say hello. Unlinked release build: only the hello (Vega has no
 * reporter to open).
 */
export function decide(input: GestureInput): { capture: boolean; sendHello: boolean } {
  const enabled = input.quickCaptureEnabled;
  return {
    capture: enabled && (input.linked || input.debugBuild),
    sendHello: enabled && !input.linked && input.linkingEnabled,
  };
}

/** Whether the gesture can do anything at all; remote keys are ignored otherwise. */
export function isArmed(input: GestureInput): boolean {
  return input.quickCaptureEnabled && (input.linked || input.debugBuild || input.linkingEnabled);
}

/** The `linkPending` of a 200 ingest reply, validated like a hello. */
export function parseLinkPending(body: unknown): { attemptId: string; number: number } | null {
  if (!body || typeof body !== 'object') return null;
  return parsePendingAttempt((body as { linkPending?: unknown }).linkPending);
}

/** `403 {"error":"device_unlinked"}`: nothing was stored and the token is dead. */
export function isDeviceUnlinked(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    !!body &&
    typeof body === 'object' &&
    (body as { error?: unknown }).error === 'device_unlinked'
  );
}
