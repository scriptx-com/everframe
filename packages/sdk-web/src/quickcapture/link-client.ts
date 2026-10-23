// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the device-link hello and attempt-check
// calls (contract: `POST /api/device-link/hello`,
// `POST /api/device-link/attempts/:attemptId/check`). Lazy chunk only.
//
// Every request carries a nonce, and a check's reply can carry the device
// token, so each one goes through the unpatched `fetch` (never into captured
// network evidence) with `redirect: 'error'` and `credentials: 'omit'`, and
// every wait is bounded with `boundWait`. Nothing here logs.
import { boundWait, timeoutSignal } from '@everframe/sdk-core';
import { unpatchedFetch } from '../capture/network.js';
import { isDeviceToken, parseOwner, UUID_RE, type DeviceLinkOwner } from '../devicelink/token.js';
import type { HelloDevice } from '../devicelink/tv-platform.js';

export { UUID_RE };

export type HelloResult =
  | { kind: 'none' }
  | { kind: 'pending'; attemptId: string; number: number }
  | { kind: 'stop'; rateLimited: boolean };

export type CheckResult =
  | { kind: 'pending' }
  | { kind: 'linked'; token: string; owner: DeviceLinkOwner }
  | { kind: 'expired' }
  | { kind: 'retry' }
  | { kind: 'stop' };

export interface DeviceLinkClient {
  hello(nonce: string, device: HelloDevice): Promise<HelloResult>;
  check(attemptId: string, nonce: string): Promise<CheckResult>;
}

export const LINK_CALL_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 4_096;

interface Reply {
  status: number;
  /** The parsed JSON body, or undefined when it is too long or not JSON. */
  body: unknown;
}

/** Parse at most 4 096 characters of JSON; anything else is undefined. */
function parseBody(text: string): unknown {
  if (text.length > MAX_BODY_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPendingNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 99;
}

export function createDeviceLinkClient(opts: {
  ingestUrl: string;
  sdkKey: string;
  fetch?: typeof fetch | null;
  timeoutMs?: number;
}): DeviceLinkClient {
  const base = opts.ingestUrl.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? LINK_CALL_TIMEOUT_MS;

  function resolveFetch(): typeof fetch | null {
    if (opts.fetch !== undefined) return opts.fetch;
    return unpatchedFetch();
  }

  /** Null when there is no fetch, the request failed, or it timed out. */
  async function post(path: string, payload: unknown): Promise<Reply | null> {
    const f = resolveFetch();
    if (!f) return null;
    try {
      const work = (async (): Promise<Reply> => {
        const res = await f(`${base}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.sdkKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: timeoutSignal(timeoutMs),
        });
        let text = '';
        try {
          text = await res.text();
        } catch {
          text = '';
        }
        return { status: res.status, body: parseBody(text) };
      })();
      return await boundWait(work, timeoutMs);
    } catch {
      return null;
    }
  }

  return {
    async hello(nonce: string, device: HelloDevice): Promise<HelloResult> {
      const stop: HelloResult = { kind: 'stop', rateLimited: false };
      try {
        if (!resolveFetch()) return stop;
        const reply = await post('/api/device-link/hello', { attemptNonce: nonce, device });
        if (!reply) return stop;
        if (reply.status === 429) return { kind: 'stop', rateLimited: true };
        if (reply.status !== 200) return stop;
        const b = reply.body as { status?: unknown; attemptId?: unknown; number?: unknown } | null;
        if (!b || typeof b !== 'object') return stop;
        if (b.status === 'none') return { kind: 'none' };
        if (
          b.status === 'pending' &&
          typeof b.attemptId === 'string' &&
          UUID_RE.test(b.attemptId) &&
          isPendingNumber(b.number)
        ) {
          return { kind: 'pending', attemptId: b.attemptId, number: b.number };
        }
        return stop;
      } catch {
        return stop;
      }
    },

    async check(attemptId: string, nonce: string): Promise<CheckResult> {
      try {
        if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) return { kind: 'expired' };
        if (!resolveFetch()) return { kind: 'stop' };
        const reply = await post(
          `/api/device-link/attempts/${encodeURIComponent(attemptId)}/check`,
          { attemptNonce: nonce },
        );
        if (!reply) return { kind: 'retry' };
        if (reply.status === 429) return { kind: 'stop' };
        if (reply.status >= 500) return { kind: 'retry' };
        if (reply.status >= 400) return { kind: 'expired' };
        if (reply.status !== 200) return { kind: 'retry' };
        const b = reply.body as { status?: unknown; token?: unknown; owner?: unknown } | null;
        // A captive portal or a truncated body: try again on the next tick.
        if (!b || typeof b !== 'object') return { kind: 'retry' };
        if (b.status === 'pending') return { kind: 'pending' };
        if (b.status === 'linked') {
          const owner = parseOwner(b.owner);
          if (!isDeviceToken(b.token) || !owner) return { kind: 'expired' };
          return { kind: 'linked', token: b.token, owner };
        }
        return { kind: 'expired' };
      } catch {
        return { kind: 'retry' };
      }
    },
  };
}
