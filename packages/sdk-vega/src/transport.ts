// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// JSON delivery. Vega's native networking replaces every multipart/form-data
// body (string, ArrayBuffer, Blob, XHR or FormData) with an empty one, while
// application/json bodies arrive intact, so reports go to /api/ingest as JSON.
// Outcome classes follow sdk-core's transport (packages/sdk-core/src/transport/http.ts).
import { originOf } from './link-token.js';

export interface FetchInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
  /**
   * Asked for on every JSON request. React Native for Vega 0.72 ignores it and
   * follows redirects anyway (spike, 2026-10-24), so a redirect is also
   * detected from the response's final URL and discarded.
   */
  redirect?: 'error';
}

export interface FetchResponse {
  status: number;
  ok?: boolean;
  url?: string;
  text?: () => Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type SendOutcome = 'sent' | 'drop' | 'retry';

export interface SendResult {
  outcome: SendOutcome;
  status: number;
}

/** Largest JSON body read from an ingest or device-link reply. */
export const MAX_REPLY_CHARS = 4096;

export const SEND_TIMEOUT_MS = 10_000;

export function classify(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retry';
  // 401/403 (bad or suspended key), 426, every other 4xx, and 3xx: the server
  // will not accept this report on a later attempt either.
  return 'drop';
}

export interface SendDeps {
  fetch: FetchLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  timeoutMs?: number;
}

type Abortable = { signal: unknown; abort(): void };

function abortController(): Abortable | undefined {
  const Abort = (globalThis as { AbortController?: new () => Abortable }).AbortController;
  try {
    return Abort ? new Abort() : undefined;
  } catch {
    return undefined;
  }
}

/** Everything after `scheme://authority`, for comparing a final URL. */
function rest(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '') || '/';
}

/**
 * Whether `final` (a response's URL) differs from what was requested. An
 * absent or empty URL is not a redirect; a spelling difference the platform
 * normalized away (host case, default port) is not one either.
 */
export function wasRedirected(requested: string, final: unknown): boolean {
  if (typeof final !== 'string' || final.length === 0 || final === requested) return false;
  const a = originOf(requested);
  const b = originOf(final);
  return a === null || a !== b || rest(requested) !== rest(final);
}

async function readText(response: FetchResponse, maxChars: number): Promise<unknown> {
  if (typeof response.text !== 'function') return undefined;
  const text = await response.text();
  if (typeof text !== 'string' || text.length === 0 || text.length > maxChars) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Runs `work` against a timeout that also aborts the request. Resolves with
 * `onTimeout` when the deadline passes first; never rejects.
 */
async function withTimeout<T>(
  deps: SendDeps,
  work: (signal: unknown) => Promise<T>,
  onTimeout: T,
): Promise<T> {
  const controller = abortController();
  let timer: unknown;
  const timeout = new Promise<T>((resolve) => {
    timer = deps.setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // An abort that throws still leaves the race to the timeout.
      }
      resolve(onTimeout);
    }, deps.timeoutMs ?? SEND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work(controller?.signal), timeout]);
  } finally {
    deps.clearTimeout(timer);
  }
}

export interface JsonRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  /** Bodies longer than this are not parsed. Default `MAX_REPLY_CHARS`. */
  maxChars?: number;
}

export interface JsonResult {
  /** `0` for a network error, a timeout or a redirect. */
  status: number;
  body: unknown;
  redirected: boolean;
}

/**
 * One JSON request for the config and device-link calls. Never rejects. A
 * response whose final URL is not the request URL is discarded whole, so
 * nothing in it (a device token) is ever used.
 */
export function requestJson(deps: SendDeps, req: JsonRequest): Promise<JsonResult> {
  const failed: JsonResult = { status: 0, body: undefined, redirected: false };
  return withTimeout(
    deps,
    async (signal) => {
      try {
        const response = await deps.fetch(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          ...(signal !== undefined ? { signal } : {}),
          redirect: 'error',
        });
        if (wasRedirected(req.url, response?.url))
          return { status: 0, body: undefined, redirected: true };
        const status = typeof response?.status === 'number' ? response.status : 0;
        let body: unknown;
        try {
          body = await readText(response, req.maxChars ?? MAX_REPLY_CHARS);
        } catch {
          body = undefined;
        }
        return { status, body, redirected: false };
      } catch {
        return failed;
      }
    },
    failed,
  );
}

export interface SendExtra {
  /** Added to the request; never replaces `Authorization` or `Content-Type`. */
  headers?: Record<string, string>;
  /** Read the JSON body of a 2xx or 403 reply. */
  readBody?: boolean;
}

export async function sendReport(
  deps: SendDeps,
  ingestUrl: string,
  sdkKey: string,
  body: string,
  extra?: SendExtra,
): Promise<SendResult & { body?: unknown }> {
  return withTimeout<SendResult & { body?: unknown }>(
    deps,
    async (signal) => {
      try {
        const response = await deps.fetch(ingestUrl, {
          method: 'POST',
          headers: {
            ...(extra?.headers ?? {}),
            Authorization: `Bearer ${sdkKey}`,
            'Content-Type': 'application/json',
          },
          body,
          ...(signal !== undefined ? { signal } : {}),
        });
        // A report that was redirected was not stored where it was sent.
        if (wasRedirected(ingestUrl, response?.url)) return { outcome: 'retry', status: 0 };
        const status = typeof response?.status === 'number' ? response.status : 0;
        const outcome = classify(status);
        if (extra?.readBody && ((status >= 200 && status < 300) || status === 403)) {
          let parsed: unknown;
          try {
            parsed = await readText(response, MAX_REPLY_CHARS);
          } catch {
            parsed = undefined;
          }
          return parsed === undefined ? { outcome, status } : { outcome, status, body: parsed };
        }
        return { outcome, status };
      } catch {
        return { outcome: 'retry', status: 0 };
      }
    },
    { outcome: 'retry', status: 0 },
  );
}
