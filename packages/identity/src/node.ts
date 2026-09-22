// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The ONE file allowed to know Node exists. It is on its own export path
// (@traceitx/identity/node) so importing the main entry never pulls Node types
// into a Worker build.
//
// Note it imports no `node:` MODULE — only Node's TYPES. A request body is read
// by async-iterating IncomingMessage, which needs no import at all.
import type { IncomingMessage, ServerResponse } from 'node:http';

type FetchHandler = (req: Request) => Promise<Response>;

// The mint endpoint itself needs no body at all — this allowance exists only
// so a `resolveUser` that reads one (e.g. a CSRF token) still works. 1 MiB is
// generous for that and small enough that an unauthenticated remote client
// can't use it to exhaust the customer's server heap.
const MAX_BODY_BYTES = 1024 * 1024;

/** Thrown internally to signal "stop reading, the body exceeded the cap." */
class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  // Only POST can meaningfully carry a body AND is a method the handler
  // supports (createIdentityHandler accepts only GET/POST). Everything else
  // — including HEAD/PUT/DELETE/etc — skips reading entirely: there is
  // nothing to gain from buffering a body the handler will 405 anyway.
  if (req.method !== 'POST') return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    // Checked as soon as the running total EXCEEDS the cap — never accumulate
    // first and check after, or the cap is just a suggestion. Deliberately
    // does NOT destroy `req` here: req and res share one socket, and
    // destroying it before the 413 response is written would kill the
    // connection out from under that response instead of delivering it. We
    // simply stop reading; the caller sends the 413 and closes the
    // connection once it's written (see toNodeHandler).
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) return undefined;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Adapt a WHATWG handler to Express, Connect, Next Pages Router, or plain
 * node:http.
 *
 *   const handler = toNodeHandler(createIdentityHandler({ … }));
 *   app.get('/api/traceitx-identity', (req, res) => void handler(req, res));
 */
export function toNodeHandler(
  handler: FetchHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // This whole body is wrapped in try/catch so the returned promise can
    // NEVER reject. This package's own README documents the call site as
    // `void toNodeHandler(handler)(req, res)` — the promise is discarded — so
    // under Node's default unhandled-rejection behaviour a rejection here
    // would terminate the customer's process. One malformed request must
    // never be able to do that.
    try {
      // The absolute URL is required by the Request constructor but is never
      // read by the handler, which routes on method alone. `host` is used
      // when present purely so a resolveUser that inspects req.url sees the
      // truth. A malformed Host header (e.g. containing a space or unmatched
      // bracket) makes `new URL` throw — fall back to a safe constant base
      // rather than failing the request, since the handler never reads the
      // origin and a synthetic base is harmless.
      const host = req.headers.host ?? 'localhost';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${host}`);
      } catch {
        url = new URL(req.url ?? '/', 'http://localhost');
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(key, v);
        else headers.set(key, value);
      }

      let body: Uint8Array | undefined;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          if (!res.headersSent) {
            // `Connection: close` tells Node not to try to reuse this socket
            // for a next request — the remainder of this oversized body is
            // still unread and sitting on it, so keep-alive would desync the
            // next request's parse. Destroying `req` AFTER the response is
            // written (on 'finish') stops the stream from draining further
            // without cutting the 413 off before the client receives it.
            res.statusCode = 413;
            res.setHeader('cache-control', 'no-store');
            res.setHeader('connection', 'close');
            res.once('finish', () => req.destroy());
            res.end();
          }
          return;
        }
        throw err;
      }

      const request = new Request(url, {
        method: req.method ?? 'GET',
        headers,
        ...(body ? { body: body as BodyInit } : {}),
      });

      const response = await handler(request);
      if (res.headersSent) return;
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      const text = await response.text();
      res.end(text === '' ? undefined : text);
    } catch {
      // Never leak an error message — matches the fetch handler's own
      // posture of an empty body on unexpected failure.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('cache-control', 'no-store');
        res.end();
      }
    }
  };
}
