// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { redact } from '../defaults.js';
import { apiBase } from '../upload.js';

export type TicketStep = 'upload' | 'create' | 'attach' | 'comment';

export interface TicketClientOptions {
  /** `EVERFRAME_API_URL ?? DEFAULT_API_URL`; already ends in `/api/v1`. */
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Clock for HTTP-date Retry-After values; defaults to `Date.now`. */
  now?: () => number;
}

export class TicketApiError extends Error {
  constructor(
    public step: TicketStep,
    public status: number | null,
    public code: string,
  ) {
    super(`ticket_${step}_failed: ${code}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'TicketApiError';
  }
}

export interface TicketResult {
  id: string;
  title: string;
  projectId: string;
  boardId: string;
  columnId: string;
  createdAt: string;
  url: string;
}

export interface UploadedAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface CommentResult {
  id: string;
  ticketId: string;
  createdAt: string;
  url: string;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** A 2xx body is only a success if it carries the fields the CLI reads. */
function hasShape(step: TicketStep, body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as { id?: unknown; url?: unknown };
  if (typeof b.id !== 'string' || b.id === '') return false;
  return step === 'upload' || typeof b.url === 'string';
}

const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
function neverSent(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' && NEVER_SENT.has(cause.code);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The API's error code, or a safe fallback for foreign or hostile bodies. */
function errorCode(status: number, body: unknown): string {
  const value = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (typeof value === 'string' && CODE_PATTERN.test(value)) return value;
  if (status === 429) return 'rate_limit_exceeded';
  return `http_${status}`;
}

function retryDelay(
  response: Response | undefined,
  attempt: number,
  now: () => number = Date.now,
): number {
  const retryAfter = response?.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now()), MAX_RETRY_AFTER_MS);
  }
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 251);
}

export function createTicketClient(o: TicketClientOptions) {
  const fetcher = o.fetch ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const maxAttempts = Math.max(1, o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  // Same rules as the build upload: https, or http on loopback only. Throws before any request.
  const base = apiBase(o.apiUrl);

  async function request<T>(
    step: TicketStep,
    path: string,
    init: { body: BodyInit; headers?: Record<string, string>; timeoutMs: number },
    expectedStatus: number,
  ): Promise<T> {
    let last: TicketApiError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetcher(`${base}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${o.token}`, ...init.headers },
          body: init.body,
          // fetch would resend the body and token to a 307/308 target.
          redirect: 'manual',
          signal: AbortSignal.timeout(init.timeoutMs),
        });
      } catch (error) {
        last = new TicketApiError(step, null, 'network_error');
        // An unkeyed upload may have reached the server; only retry if it certainly did not.
        if (step === 'upload' && !neverSent(error)) throw sanitize(last);
      }
      if (response) {
        if (response.status >= 300 && response.status < 400)
          throw sanitize(new TicketApiError(step, response.status, 'unexpected_redirect'));
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          parsed = undefined;
        }
        if (response.status === expectedStatus || (response.ok && response.status < 300)) {
          if (hasShape(step, parsed)) return parsed as T;
          last = new TicketApiError(step, response.status, 'invalid_server_response');
          // A keyed write replays on retry; an upload has no key and would leave an orphan.
          if (step === 'upload') throw sanitize(last);
          if (attempt < maxAttempts) await sleep(retryDelay(undefined, attempt));
          continue;
        }
        last = new TicketApiError(step, response.status, errorCode(response.status, parsed));
        // An unkeyed upload retries only answers that mean nothing was stored; a 500,
        // 502 or 504 may arrive after the file was saved and would leave an orphan.
        const retryable =
          step === 'upload'
            ? response.status === 429 || response.status === 503
            : response.status === 429 || response.status >= 500;
        if (!retryable) throw sanitize(last);
      }
      if (attempt < maxAttempts) await sleep(retryDelay(response, attempt, now));
    }
    throw sanitize(last as TicketApiError);
  }

  // Defence in depth: the token never reaches a message, whatever the server echoed.
  function sanitize(error: TicketApiError): TicketApiError {
    error.message = redact(error.message, o.token);
    error.code = redact(error.code, o.token);
    return error;
  }

  const query = (projectId: string | undefined): string =>
    projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const jsonRequest = (body: unknown, idempotencyKey: string) => ({
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  return {
    upload(
      file: { path: string; name: string; bytes: Buffer },
      projectId?: string,
    ): Promise<UploadedAttachment> {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file.bytes)]), file.name);
      return request<UploadedAttachment>(
        'upload',
        `/attachments${query(projectId)}`,
        { body: form, timeoutMs: UPLOAD_TIMEOUT_MS },
        201,
      );
    },
    createTicket(body: Record<string, unknown>, idempotencyKey: string): Promise<TicketResult> {
      return request<TicketResult>('create', '/tickets', jsonRequest(body, idempotencyKey), 201);
    },
    attach(
      ticket: string,
      attachmentIds: string[],
      projectId: string | undefined,
      idempotencyKey: string,
    ): Promise<TicketResult & { attachmentCount: number }> {
      return request<TicketResult & { attachmentCount: number }>(
        'attach',
        `/tickets/${encodeURIComponent(ticket)}/attachments${query(projectId)}`,
        jsonRequest({ attachmentIds }, idempotencyKey),
        200,
      );
    },
    comment(
      ticket: string,
      body: { body: string; attachmentIds?: string[] },
      projectId: string | undefined,
      idempotencyKey: string,
    ): Promise<CommentResult> {
      return request<CommentResult>(
        'comment',
        `/tickets/${encodeURIComponent(ticket)}/comments${query(projectId)}`,
        jsonRequest(body, idempotencyKey),
        201,
      );
    },
  };
}
