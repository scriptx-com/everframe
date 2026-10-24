// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the ingest side of a device link. A linked TV's
// quick capture carries the device token (`X-Everframe-Capture-Token`) and a
// fresh link nonce (`X-Everframe-Link-Nonce`); the reply may carry a takeover
// (`linkPending`) or `403 { error: "device_unlinked" }`.
//
// The token and nonce exist only in request headers. A queued capture stores
// only the token's fingerprint (`deviceLinkFingerprint`), and a drain sends it
// again only while that same token is stored. Nothing here logs.
import { boundWait, CAPTURE_TOKEN_HEADER } from '@everframe/sdk-core';
import { UUID_RE } from '../devicelink/token.js';

export const LINK_NONCE_HEADER = 'X-Everframe-Link-Nonce';
export const FINGERPRINT_METADATA_KEY = 'deviceLinkFingerprint';
export const DEVICE_UNLINKED_ERROR = 'device_unlinked';

const MAX_BODY_CHARS = 4_096;
const BODY_READ_TIMEOUT_MS = 10_000;

/** The device link a live quick-capture upload carries. */
export interface QuickCaptureUploadLink {
  token: string;
  fingerprint: string;
  /** Fresh per upload; null when there is no secure random source. */
  nonce: string | null;
}

/** What a drain needs to resend fingerprinted captures. */
export interface DrainDeviceLinks {
  current(): { token: string; fingerprint: string } | null;
  forget(onlyIfToken: string): void;
}

/**
 * Wraps `base` so every request carries the token (and the nonce, when
 * non-null), follows no redirect and sends no cookies. After each response
 * it reads at most 4 096 characters of JSON from a clone into `onBody`
 * (undefined when longer, not JSON or unreadable). Never throws over that
 * read.
 */
export function withDeviceLinkHeaders(
  base: typeof fetch,
  link: { token: string; nonce: string | null },
  onBody: (status: number, body: unknown) => void,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set(CAPTURE_TOKEN_HEADER, link.token);
    if (link.nonce !== null) headers.set(LINK_NONCE_HEADER, link.nonce);
    const res = await base(input, {
      ...init,
      headers,
      redirect: 'error',
      credentials: 'omit',
    });
    let body: unknown = undefined;
    try {
      const text = await boundWait(res.clone().text(), BODY_READ_TIMEOUT_MS);
      if (text.length <= MAX_BODY_CHARS) body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    try {
      onBody(res.status, body);
    } catch {
      /* DEFE-02 */
    }
    return res;
  };
  return wrapped as typeof fetch;
}

/** A takeover from an ingest reply: `{ linkPending: { attemptId, number } }`. */
export function parseLinkPending(body: unknown): { attemptId: string; number: number } | null {
  if (!body || typeof body !== 'object') return null;
  const lp = (body as { linkPending?: unknown }).linkPending;
  if (!lp || typeof lp !== 'object') return null;
  const { attemptId, number } = lp as { attemptId?: unknown; number?: unknown };
  if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 99) {
    return null;
  }
  return { attemptId, number };
}

/** `403 { "error": "device_unlinked" }`. */
export function isDeviceUnlinked(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    !!body &&
    typeof body === 'object' &&
    (body as { error?: unknown }).error === DEVICE_UNLINKED_ERROR
  );
}
