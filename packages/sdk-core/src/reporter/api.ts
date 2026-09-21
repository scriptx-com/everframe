// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure wire client for /api/reporter/* (server: the ingest service/src/reporter/routes.ts).
// Everything is injected; no globals, no retries (the poll cadence IS the retry),
// fail-typed: every non-2xx/304 becomes a ReporterApiError with a stable code.
//
// Parsing is deliberately TOLERANT of additive fields (unlike ReplayConfigResponse's
// .strict()): SDKs ship inside customer bundles and cannot be redeployed when the
// server grows a field, and an inbox that fail-closes on a new field goes silently
// stale forever. Required fields are still validated; junk still errors.
import { z } from 'zod';
import { IDENTITY_TOKEN_HEADER, type IdentityTokenReader } from './identity-token.js';
import { boundWait, timeoutSignal } from '../transport/timeout-signal.js';

export const MESSAGE_BODY_MAX = 2000;

const ThreadSummarySchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'closed']),
  reportTitle: z.string().nullable(),
  createdAt: z.string(),
  lastMessageAt: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
}).passthrough();

const ThreadListSchema = z.object({ threads: z.array(ThreadSummarySchema) }).passthrough();

const ThreadMessageSchema = z.object({
  id: z.string(),
  authorKind: z.enum(['team', 'reporter', 'system']),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
}).passthrough();

const MessagePageSchema = z.object({
  status: z.enum(['open', 'closed']),
  messages: z.array(ThreadMessageSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
}).passthrough();

export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
export type MessagePage = z.infer<typeof MessagePageSchema>;

export type ReporterApiErrorCode =
  | 'invalid_sdk_key' | 'invalid_device_token' | 'replies_disabled'
  | 'thread_not_found' | 'thread_closed' | 'rate_limit_exceeded'
  | 'invalid_input' | 'network_error' | 'malformed_response';

const KNOWN_WIRE_CODES: ReadonlySet<string> = new Set([
  'invalid_sdk_key', 'invalid_device_token', 'replies_disabled',
  'thread_not_found', 'thread_closed', 'rate_limit_exceeded', 'invalid_input',
]);

export class ReporterApiError extends Error {
  readonly code: ReporterApiErrorCode;
  readonly status: number | null;
  readonly retryAfter: number | null;

  constructor(code: ReporterApiErrorCode, status: number | null, retryAfter: number | null = null) {
    super(`reporter api: ${code}`);
    this.name = 'ReporterApiError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type ListThreadsResult =
  | { kind: 'ok'; threads: ThreadSummary[]; etag: string | null }
  | { kind: 'not-modified' };

export interface ReporterApi {
  listThreads(deviceToken: string, etag: string | null): Promise<ListThreadsResult>;
  listMessages(deviceToken: string, threadId: string, cursor: string | null): Promise<MessagePage>;
  postMessage(deviceToken: string, threadId: string, body: string): Promise<{ id: string }>;
  markRead(deviceToken: string, threadId: string): Promise<void>;
  deleteThread(deviceToken: string, threadId: string): Promise<void>;
}

export interface ReporterApiDeps {
  fetchImpl: typeof fetch;
  baseUrl: string;   // no trailing slash required; normalized below
  apiKey: string;
  timeoutMs?: number; // default 10s; bounds every request
  /**
   * Reporter identity recognition (spec 2026-08-06). When supplied, every
   * call resolves the token to present (if any) via `reader.get(Date.now())`
   * and sends it as `X-TX-Identity-Token` alongside the device token.
   * Best-effort — never blocks or fails a reporter call. Pass the web
   * adapter's `__identityTokenReader` (or any `IdentityTokenReader`); it
   * already gates on the config response's `identity.enabled`. Resolved on
   * EVERY call (unlike `submitReport`'s once-per-submit choice) — reporter
   * calls are individually infrequent (thread polling, not a retry burst),
   * so there's no meaningful churn to trade off here.
   */
  identityToken?: IdentityTokenReader;
}

async function throwWireError(res: Response): Promise<never> {
  let wireCode = '';
  let retryAfter: number | null = null;
  try {
    // Bounded body read (codex round-3 finding 3): fetch settles at response
    // HEADERS; a stalled body must not hang past the request budget on
    // engines whose signal cannot abort the read.
    const body: unknown = await boundWait(res.json(), 10_000);
    if (body && typeof body === 'object') {
      const e = (body as { error?: unknown }).error;
      if (typeof e === 'string') wireCode = e;
      const r = (body as { retryAfter?: unknown }).retryAfter;
      if (typeof r === 'number') retryAfter = r;
    }
  } catch {
    // Non-JSON error body; fall through to a generic mapping.
  }
  if (KNOWN_WIRE_CODES.has(wireCode)) {
    throw new ReporterApiError(wireCode as ReporterApiErrorCode, res.status, retryAfter);
  }
  throw new ReporterApiError('malformed_response', res.status, retryAfter);
}

export function createReporterApi(deps: ReporterApiDeps): ReporterApi {
  const base = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? 10_000;

  async function call(
    deviceToken: string,
    path: string,
    init: { method?: string; body?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.apiKey}`,
      'X-TX-Device-Token': deviceToken,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.extraHeaders ?? {}),
    };
    if (deps.identityToken) {
      try {
        const token = await deps.identityToken.get(Date.now());
        if (token) headers[IDENTITY_TOKEN_HEADER] = token;
      } catch {
        /* swallow — identity is best-effort, never blocks a reporter call */
      }
    }
    let res: Response;
    try {
      const fetchOptions: RequestInit = {
        method: init.method ?? 'GET',
        headers,
        // timeoutSignal, not bare AbortSignal.timeout — Chrome 103+ only;
        // see transport/timeout-signal.ts (field bug 2026-08-27).
        signal: timeoutSignal(timeoutMs),
      };
      if (init.body !== undefined) {
        fetchOptions.body = init.body;
      }
      // boundWait backstops engines with no abort primitive at all — see
      // config-provider.ts's fetch for the full rationale.
      res = await boundWait(deps.fetchImpl(`${base}${path}`, fetchOptions), timeoutMs);
    } catch {
      throw new ReporterApiError('network_error', null);
    }
    return res;
  }

  return {
    async listThreads(deviceToken, etag) {
      const res = await call(deviceToken, '/api/reporter/threads', {
        extraHeaders: etag ? { 'If-None-Match': etag } : {},
      });
      if (res.status === 304) return { kind: 'not-modified' };
      if (!res.ok) await throwWireError(res);
      let parsed;
      try {
        parsed = ThreadListSchema.safeParse(await boundWait(res.json(), timeoutMs));
      } catch {
        throw new ReporterApiError('malformed_response', res.status);
      }
      if (!parsed.success) throw new ReporterApiError('malformed_response', res.status);
      return { kind: 'ok', threads: parsed.data.threads, etag: res.headers.get('ETag') };
    },

    async listMessages(deviceToken, threadId, cursor) {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await call(deviceToken, `/api/reporter/threads/${threadId}/messages${qs}`);
      if (!res.ok) await throwWireError(res);
      let parsed;
      try {
        parsed = MessagePageSchema.safeParse(await boundWait(res.json(), timeoutMs));
      } catch {
        throw new ReporterApiError('malformed_response', res.status);
      }
      if (!parsed.success) throw new ReporterApiError('malformed_response', res.status);
      return parsed.data;
    },

    async postMessage(deviceToken, threadId, body) {
      const res = await call(deviceToken, `/api/reporter/threads/${threadId}/messages`, {
        method: 'POST', body: JSON.stringify({ body }),
      });
      if (res.status !== 201) await throwWireError(res);
      let id: unknown;
      try {
        id = ((await boundWait(res.json(), timeoutMs)) as { id?: unknown }).id;
      } catch {
        throw new ReporterApiError('malformed_response', res.status);
      }
      if (typeof id !== 'string') throw new ReporterApiError('malformed_response', res.status);
      return { id };
    },

    async markRead(deviceToken, threadId) {
      const res = await call(deviceToken, `/api/reporter/threads/${threadId}/read`, { method: 'POST' });
      if (res.status !== 204) await throwWireError(res);
    },

    async deleteThread(deviceToken, threadId) {
      const res = await call(deviceToken, `/api/reporter/threads/${threadId}`, { method: 'DELETE' });
      if (res.status !== 204) await throwWireError(res);
    },
  };
}
