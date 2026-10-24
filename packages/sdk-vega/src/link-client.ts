// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// HTTP for device linking: the hello an unlinked device sends when the
// capture gesture fires, the attempt check it polls while a teammate picks
// its number, and the upload of a gesture recorded on a linked device. The
// nonce and the token travel only in bodies and headers, never in a URL.
import { RECORDING_POST_TIMEOUT_MS, type RecordedKey } from './gesture-recording.js';
import { isDeviceToken, parseOwner, type LinkOwner } from './link-token.js';
import { CAPTURE_TOKEN_HEADER } from './remote-config.js';
import { requestJson, type SendDeps } from './transport.js';
import { SDK_VERSION } from './version.js';

export interface HelloDevice {
  model: string;
  os: 'Vega OS';
  osVersion: string;
  appVersion: string;
  sdk: string;
  formFactor: 'tv';
}

export type HelloResult =
  | { kind: 'none' }
  | { kind: 'pending'; attemptId: string; number: number }
  | { kind: 'stop' };

export type CheckResult =
  | { kind: 'pending' }
  | { kind: 'linked'; token: string; owner: LinkOwner }
  | { kind: 'expired' }
  | { kind: 'retry' }
  | { kind: 'stop' };

export interface LinkClient {
  hello(nonce: string, device: HelloDevice): Promise<HelloResult>;
  check(attemptId: string, nonce: string): Promise<CheckResult>;
}

export interface RecordingClient {
  /**
   * `POST /api/device-link/recordings/:id` with the device token. True only
   * on a 204; a redirect, a timeout or any other answer is false.
   */
  postRecording(recordingId: string, token: string, events: RecordedKey[]): Promise<boolean>;
}

const ATTEMPT_ID = /^[0-9A-Za-z-]{1,64}$/;

const field = (value: unknown, max: number, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : fallback;

/** The device facts a hello carries, cut to the server's limits. */
export function helloDevice(input: {
  model?: string | undefined;
  osVersion?: string | undefined;
  appVersion?: string | undefined;
}): HelloDevice {
  return {
    model: field(input.model, 100, 'Vega device'),
    os: 'Vega OS',
    osVersion: field(input.osVersion, 40, 'unknown'),
    appVersion: field(input.appVersion, 64, '0.0.0'),
    sdk: `vega/${SDK_VERSION}`.slice(0, 64),
    formFactor: 'tv',
  };
}

/** A pending attempt from a hello or an ingest `linkPending`; null when malformed. */
export function parsePendingAttempt(raw: unknown): { attemptId: string; number: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { attemptId, number } = raw as { attemptId?: unknown; number?: unknown };
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 99)
    return null;
  return { attemptId, number };
}

export function createLinkClient(
  deps: SendDeps,
  apiBase: string,
  sdkKey: string,
): LinkClient & RecordingClient {
  const headers = {
    Authorization: `Bearer ${sdkKey}`,
    'Content-Type': 'application/json',
  };
  return {
    async hello(nonce, device) {
      const result = await requestJson(deps, {
        url: `${apiBase}/api/device-link/hello`,
        method: 'POST',
        headers,
        body: JSON.stringify({ attemptNonce: nonce, device }),
      });
      if (result.redirected || result.status !== 200) return { kind: 'stop' };
      const body = result.body as { status?: unknown } | undefined;
      if (body?.status === 'none') return { kind: 'none' };
      if (body?.status === 'pending') {
        const attempt = parsePendingAttempt(body);
        if (attempt) return { kind: 'pending', ...attempt };
      }
      return { kind: 'stop' };
    },
    async check(attemptId, nonce) {
      if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) return { kind: 'expired' };
      const result = await requestJson(deps, {
        url: `${apiBase}/api/device-link/attempts/${encodeURIComponent(attemptId)}/check`,
        method: 'POST',
        headers,
        body: JSON.stringify({ attemptNonce: nonce }),
      });
      if (result.redirected || result.status === 429) return { kind: 'stop' };
      if (result.status === 0 || result.status >= 500) return { kind: 'retry' };
      if (result.status !== 200) return { kind: 'expired' };
      const body = result.body as
        | { status?: unknown; token?: unknown; owner?: unknown }
        | undefined;
      if (body?.status === 'pending') return { kind: 'pending' };
      if (body?.status === 'linked') {
        const owner = parseOwner(body.owner);
        if (isDeviceToken(body.token) && owner) return { kind: 'linked', token: body.token, owner };
      }
      return { kind: 'expired' };
    },
    async postRecording(recordingId, token, events) {
      if (typeof recordingId !== 'string' || !ATTEMPT_ID.test(recordingId)) return false;
      if (!isDeviceToken(token)) return false;
      const result = await requestJson(
        { ...deps, timeoutMs: RECORDING_POST_TIMEOUT_MS },
        {
          url: `${apiBase}/api/device-link/recordings/${encodeURIComponent(recordingId)}`,
          method: 'POST',
          headers: { ...headers, [CAPTURE_TOKEN_HEADER]: token },
          body: JSON.stringify({
            events: events.map(({ key, downMs, upMs }) => ({ key, downMs, upMs })),
          }),
        },
      );
      return !result.redirected && result.status === 204;
    },
  };
}
