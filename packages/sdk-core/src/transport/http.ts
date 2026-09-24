// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// HTTP submission with retry decision matrix (RESEARCH.md §HTTP retry table).
//
// Decision matrix:
//   2xx                                  → success
//   3xx                                  → no retry, surfaced (treated as payload err)
//   401 / 403                            → no retry, reason=auth
//   426                                  → no retry, reason=protocol-mismatch
//   other 4xx (not 408/429)              → no retry, reason=payload
//   408 / 429 / 5xx / network / parse err→ retry on schedule (default 1/2/4/8/16s, ±20% jitter)
//   exhausted                             → reason=transient-exhausted
import { IDENTITY_TOKEN_HEADER, type IdentityTokenReader } from '../reporter/identity-token.js';
import { DEVICE_TOKEN_HEADER } from '../reporter/device-token.js';

export const DEFAULT_RETRY_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000] as const;
export { DEVICE_TOKEN_HEADER } from '../reporter/device-token.js';
export const REPLIES_OPT_OUT_HEADER = 'X-Everframe-Replies-Opt-Out';

export interface SubmitOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  retryScheduleMs?: readonly number[];
  jitter?: boolean;
  envelopeContentEncoding?: 'gzip';
  /** Presented on every submit so all of a device's reports share one thread identity; server adopts the hash on first sight. */
  deviceToken?: string;
  /**
   * Set when the local `replies: { disabled: true }` veto is active — no
   * device token is being sent (see `deviceToken` above), so the server must
   * not fall back to minting one and provisioning a thread anyway. Sends
   * `X-Everframe-Replies-Opt-Out: 1`; see ingest-service's route.ts
   * REPLIES_OPT_OUT_HEADER doc-comment for the server side of this contract.
   */
  repliesOptOut?: boolean;
  /**
   * Reporter identity recognition (spec 2026-08-06). When supplied, the token
   * to present (if any) is resolved via `reader.get(Date.now())` and sent as
   * `X-Everframe-Identity-Token`. Omitted entirely when the reader resolves `null`
   * (no source set, undecodable, near-expiry, project has no signing secret,
   * or the host's provider threw/timed out) — identity is strictly
   * best-effort and never blocks or fails the submit. Pass the web adapter's
   * `__identityTokenReader` (or any `IdentityTokenReader`); it already gates
   * on the config response's `identity.enabled`, so a project with no
   * signing secret never invokes the host's provider in the first place.
   *
   * DECISION: resolved ONCE, before the retry loop below, not per attempt.
   * The full retry schedule is ~31s (DEFAULT_RETRY_SCHEDULE_MS) — short
   * enough that re-resolving on every attempt would mean calling the host's
   * provider up to 6× for one submit, for a token whose 10-minute lifetime
   * makes that churn pointless. A token that goes stale mid-retry is simply
   * rejected server-side (same fail-open-to-anonymous posture as every other
   * failure path here) — never a reason to fail the submit or resolve again.
   */
  identityToken?: IdentityTokenReader;
}

export interface SubmitResult {
  ok: boolean;
  status: number;
  attempts: number;
  retried: boolean;
  reason?: 'auth' | 'protocol-mismatch' | 'payload' | 'transient-exhausted' | 'success';
  /** Reply thread provisioned for this report (replies-enabled apps only). */
  thread?: { id: string };
  /** Server-minted device token — present ONLY when the client sent none; must be persisted. */
  device?: { token: string };
}

function applyJitter(ms: number, on: boolean): number {
  if (!on) return ms;
  const delta = ms * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(ms + delta));
}

export async function submitReport(
  url: string,
  sdkKey: string,
  body: FormData,
  opts: SubmitOptions = {}
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const schedule = opts.retryScheduleMs ?? DEFAULT_RETRY_SCHEDULE_MS;
  const useJitter = opts.jitter ?? true;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sdkKey}`,
  };
  if (opts.deviceToken) headers[DEVICE_TOKEN_HEADER] = opts.deviceToken;
  if (opts.repliesOptOut) headers[REPLIES_OPT_OUT_HEADER] = '1';
  if (opts.identityToken) {
    // Never let identity work fail or delay a submit — the holder itself
    // already never throws, but this belt-and-braces catch keeps that
    // contract even if a future change to the holder slips.
    try {
      const token = await opts.identityToken.get(Date.now());
      if (token) headers[IDENTITY_TOKEN_HEADER] = token;
    } catch {
      /* swallow — identity is best-effort, never blocks a submit */
    }
  }
  // Set Origin from globalThis.location when available (web). On RN/Node hosts the
  // global has no `location` and this branch is a no-op.
  const loc = (globalThis as { location?: { origin?: string } }).location;
  if (loc?.origin) {
    headers['Origin'] = loc.origin;
  }

  let attempts = 0;
  let retried = false;
  for (let attempt = 0; attempt <= schedule.length; attempt++) {
    attempts += 1;
    let response: Response | undefined;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch {
      // network/timeout/unparseable → fall through to retry branch
    }

    if (response && response.ok) {
      let thread: { id: string } | undefined;
      let device: { token: string } | undefined;
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object') {
          const t = (parsed as { thread?: unknown }).thread;
          if (t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string') {
            thread = { id: (t as { id: string }).id };
          }
          const d = (parsed as { device?: unknown }).device;
          if (d && typeof d === 'object' && typeof (d as { token?: unknown }).token === 'string') {
            device = { token: (d as { token: string }).token };
          }
        }
      } catch {
        // Response body is best-effort metadata; a submit is never failed over it.
      }
      return { ok: true, status: response.status, attempts, retried, reason: 'success', ...(thread ? { thread } : {}), ...(device ? { device } : {}) };
    }

    const status = response?.status ?? 0;
    if (status === 401 || status === 403) {
      return { ok: false, status, attempts, retried, reason: 'auth' };
    }
    if (status === 426) {
      return { ok: false, status, attempts, retried, reason: 'protocol-mismatch' };
    }
    // Non-retryable 4xx (everything that's not 408/429)
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { ok: false, status, attempts, retried, reason: 'payload' };
    }
    // 3xx — treat as non-retryable surface (server didn't accept the report).
    if (status >= 300 && status < 400) {
      return { ok: false, status, attempts, retried, reason: 'payload' };
    }
    // Retryable: 408, 429, 5xx, network/timeout/parse-error (status === 0)
    if (attempt < schedule.length) {
      retried = true;
      const delayMs = applyJitter(schedule[attempt]!, useJitter);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    return { ok: false, status, attempts, retried, reason: 'transient-exhausted' };
  }
  // Unreachable — kept for type completeness.
  return { ok: false, status: 0, attempts, retried, reason: 'transient-exhausted' };
}
