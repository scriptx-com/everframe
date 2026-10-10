// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// JSON delivery. Vega's native networking replaces every multipart/form-data
// body (string, ArrayBuffer, Blob, XHR or FormData) with an empty one, while
// application/json bodies arrive intact, so reports go to /api/ingest as JSON.
// Outcome classes follow sdk-core's transport (packages/sdk-core/src/transport/http.ts).

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: unknown },
) => Promise<{ status: number; ok?: boolean }>;

export type SendOutcome = 'sent' | 'drop' | 'retry';

export interface SendResult {
  outcome: SendOutcome;
  status: number;
}

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

export async function sendReport(
  deps: SendDeps,
  ingestUrl: string,
  sdkKey: string,
  body: string,
): Promise<SendResult> {
  const Abort = (globalThis as { AbortController?: new () => { signal: unknown; abort(): void } }).AbortController;
  let controller: { signal: unknown; abort(): void } | undefined;
  try {
    controller = Abort ? new Abort() : undefined;
  } catch {
    controller = undefined;
  }
  let timer: unknown;
  const timeout = new Promise<SendResult>((resolve) => {
    timer = deps.setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // An abort that throws still leaves the race to the timeout.
      }
      resolve({ outcome: 'retry', status: 0 });
    }, deps.timeoutMs ?? SEND_TIMEOUT_MS);
  });
  const request = (async (): Promise<SendResult> => {
    try {
      const response = await deps.fetch(ingestUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sdkKey}`, 'Content-Type': 'application/json' },
        body,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const status = typeof response?.status === 'number' ? response.status : 0;
      return { outcome: classify(status), status };
    } catch {
      return { outcome: 'retry', status: 0 };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    deps.clearTimeout(timer);
  }
}
