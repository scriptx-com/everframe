// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { pushNetworkEntry } from './buffers.js';
import type { CrumbSink, KindGate } from './breadcrumbs.js';
import { contentTypeAllowed, capUtf8, redactBodyText } from './network-body.js';
import type { NetworkBodyEntry } from '@traceitx/protocol';
import type { RedactionConfig } from '@traceitx/sdk-core';

/**
 * BodyCaptureHooks — opt-in wiring for request/response body capture (spec
 * 2026-07-18 §6). All hooks are read per-request so callers can react to live
 * server config / sampling without reinstalling the patcher.
 */
export interface BodyCaptureHooks {
  /** Effective gate (server ON && !veto && sampled-in). Read per request. */
  enabled: () => boolean;
  /**
   * F34 (round-7 review) — a token that changes whenever the effective
   * `enabled()` bit flips (at minimum: any transition to inactive). Read
   * ONCE, synchronously, right after `enabled()` at the decision point
   * (before the possibly-async body read/redaction work below) and handed
   * to `sink()` unchanged, so `networkBodyBuffer.add()`'s `guard` can
   * re-validate — right before the actual insert — that a remote
   * `captureBodies: false` config refresh hasn't landed in the meantime.
   * Optional so existing hand-rolled `BodyCaptureHooks` test doubles that
   * don't supply it keep compiling and keep their old (unguarded) behavior.
   */
  generation?: () => number;
  /** Live effective config (allowlist + byte cap). */
  config: () => { bodyByteCap: number; bodyContentTypes: string[] };
  /** Live redaction config. */
  redaction: () => RedactionConfig;
  /** Monotonic per-session request id generator. */
  nextReqId: () => number;
  /**
   * Redacted, capped body entry sink (→ networkBodyBuffer.add). `generation`
   * is the DECISION-TIME token from `generation()` above — undefined when
   * the hooks object doesn't supply `generation` at all, in which case the
   * sink must not attempt any re-validation (matches pre-F34 behavior).
   */
  sink: (entry: NetworkBodyEntry, generation?: number) => void;
}

/**
 * Module-level body-capture-hooks forwarding slot — same rebind doctrine as
 * `boundSink`/`boundGate` in breadcrumbs.ts (round-8 review Finding F37).
 * `installFetchPatcher`/`installXHRPatcher` below are install-once (Symbol.for
 * markers), so once patched they hold the closure they were given FOREVER —
 * they never re-read a fresh `bodyCapture` option on a later call that no-ops
 * as already-installed. Passing an adapter's `bodyCapture` object directly at
 * install time (the pre-fix bug) meant a Provider remount's fresh adapter
 * could never get its bodies captured again: the old adapter's teardown
 * (`onKill()`) sets only ITS OWN `killed` flag — it must not (and does not)
 * uninstall these page-global patchers — so the stale closure just kept
 * calling a dead adapter's hooks forever.
 *
 * The fix mirrors `__bindCrumbHooks` exactly: the patchers close over THIS
 * stable forwarding object, never an adapter's hooks directly, and every
 * `createWebPlatformAdapter()` call (at construction AND again from
 * `__rebindCrumbHooks()`, the same StrictMode/Fast-Refresh/remount doctrine)
 * re-points the slot at its own `bodyCapture` — so the CURRENT adapter's
 * buffer keeps receiving bodies across remounts, while a killed adapter's own
 * buffer instance stays permanently dead (buffer-level `kill()` in
 * network-body-buffer.ts is per-instance and never consulted by a different
 * adapter's hooks).
 */
let boundBodyCapture: BodyCaptureHooks | null = null;

export function __bindBodyCaptureHooks(hooks: BodyCaptureHooks | null): void {
  boundBodyCapture = hooks;
}

export const forwardingBodyCaptureHooks: BodyCaptureHooks = {
  enabled: (): boolean => {
    try {
      return boundBodyCapture?.enabled() ?? false;
    } catch {
      return false;
    }
  },
  generation: (): number => {
    try {
      return boundBodyCapture?.generation?.() ?? 0;
    } catch {
      return 0;
    }
  },
  config: (): { bodyByteCap: number; bodyContentTypes: string[] } => {
    try {
      return boundBodyCapture?.config() ?? { bodyByteCap: 8192, bodyContentTypes: [] };
    } catch {
      return { bodyByteCap: 8192, bodyContentTypes: [] };
    }
  },
  redaction: (): RedactionConfig => {
    try {
      return boundBodyCapture?.redaction() ?? {};
    } catch {
      return {};
    }
  },
  nextReqId: (): number => {
    try {
      return boundBodyCapture?.nextReqId() ?? 0;
    } catch {
      return 0;
    }
  },
  sink: (entry, generation): void => {
    try {
      boundBodyCapture?.sink(entry, generation);
    } catch {
      /* swallow — DEFE-02 */
    }
  },
};

/**
 * F42 (round-9 review, P1) — CROSS-TENANT DATA LEAK. Pin ONE request's
 * entire body-capture lifecycle — decision AND eventual sink delivery — to
 * whichever adapter is bound at the moment the request is ISSUED, never to
 * "whichever adapter happens to be bound whenever a later part of
 * processing this request happens to run".
 *
 * Pre-fix, `forwardingBodyCaptureHooks` (the shared, page-global object
 * every adapter instance rebinds via `__bindBodyCaptureHooks`, see above)
 * resolved EVERY method call — `enabled()`, `generation()`, `config()`,
 * `redaction()`, `nextReqId()`, AND `sink()` — against whichever adapter was
 * CURRENTLY bound at the exact moment each individual call executed:
 *   - fetch: the decision block (enabled/generation/reqId/config/redaction)
 *     runs synchronously right after `await original()` resolves — fine as
 *     long as nothing rebinds mid-request — but `sink()` fires later, inside
 *     the background `readCappedText().then()`, after however long it takes
 *     to read the response body stream. A kill()+remount landing in that gap
 *     hands the entry to the NEW adapter's `sink()`.
 *   - XHR: decision AND sink both live inside the SAME `readystatechange`
 *     handler, gated on `readyState === 4` — but that handler doesn't fire
 *     until the browser actually delivers the response, which can be
 *     arbitrarily later than `send()`. A kill()+remount landing between
 *     `send()` and the response arriving means EVERY method call —
 *     including `enabled()`/`generation()`/`nextReqId()` — resolves against
 *     the NEW adapter, silently attributing adapter A's request/response to
 *     adapter B's buffer (using B's config, B's redaction, B's reqId
 *     sequence) as if it were B's own traffic.
 *
 * Both are the same root cause, just surfacing at different points: the
 * forwarding object has no memory of WHICH adapter was live when the
 * request started. The F34 per-adapter generation token does NOT save this
 * either — two freshly constructed adapters routinely both start at
 * generation 1 (no transition has happened on either yet), so the token
 * "matches" purely by coincidence, exactly as the reviewer's repro shows.
 *
 * The fix: `installFetchPatcher`/`installXHRPatcher` call this at
 * request-issue time (top of the fetch wrapper / top of `send()`, before
 * anything async runs) to snapshot the EXACT `BodyCaptureHooks` instance
 * bound right now, and use the returned wrapper — never `opts.bodyCapture`
 * directly — for every method call for THIS request, decision and sink
 * alike. `sink()` additionally re-checks, immediately before delivery, that
 * the snapshotted instance is STILL the live binding; if not (killed,
 * replaced, or simply unbound), the entry is DROPPED — never redirected to
 * whichever adapter is current, and never force-delivered to the stale
 * snapshot either (relying on that instance's own killed/generation guards
 * to also reject it would work in the common case, but dropping here is the
 * direct, unconditional guarantee the fix is meant to provide).
 *
 * A hand-rolled `BodyCaptureHooks` test double passed directly (i.e. NOT
 * the shared `forwardingBodyCaptureHooks` singleton) is inherently already
 * "one instance for the whole test" and is returned unchanged — there is no
 * module-level rebind slot for it to race against.
 */
function pinBodyCapture(bc: BodyCaptureHooks): BodyCaptureHooks {
  if (bc !== forwardingBodyCaptureHooks) return bc;
  const pinned = boundBodyCapture;
  return {
    enabled: (): boolean => {
      try {
        return pinned?.enabled() ?? false;
      } catch {
        return false;
      }
    },
    generation: (): number => {
      try {
        return pinned?.generation?.() ?? 0;
      } catch {
        return 0;
      }
    },
    config: (): { bodyByteCap: number; bodyContentTypes: string[] } => {
      try {
        return pinned?.config() ?? { bodyByteCap: 8192, bodyContentTypes: [] };
      } catch {
        return { bodyByteCap: 8192, bodyContentTypes: [] };
      }
    },
    redaction: (): RedactionConfig => {
      try {
        return pinned?.redaction() ?? {};
      } catch {
        return {};
      }
    },
    nextReqId: (): number => {
      try {
        return pinned?.nextReqId() ?? 0;
      } catch {
        return 0;
      }
    },
    sink: (entry, generation): void => {
      try {
        // F42 — deliver ONLY if the snapshotted adapter is STILL the
        // currently-bound one; otherwise DROP. Never redirect to whichever
        // adapter is live now, and never force-deliver to a stale one.
        if (!pinned || boundBodyCapture !== pinned) return;
        pinned.sink(entry, generation);
      } catch {
        /* swallow — DEFE-02 */
      }
    },
  };
}

export interface NetworkPatcherOptions {
  /** Optional breadcrumb dual-write (spec §5): one network crumb per request. */
  crumbSink?: CrumbSink;
  crumbGate?: KindGate;
  /** Opt-in body capture (spec 2026-07-18). Absent ⇒ metadata-only (today's behavior). */
  bodyCapture?: BodyCaptureHooks;
}

function networkCrumb(
  opts: NetworkPatcherOptions,
  input: { message: string; level: 'info' | 'warn' | 'error'; data: Record<string, unknown> },
): void {
  try {
    if (opts.crumbSink && (opts.crumbGate?.('network') ?? true)) {
      opts.crumbSink({ kind: 'network', level: input.level, message: input.message, data: input.data });
    }
  } catch {
    /* swallow — DEFE-02 */
  }
}

function statusLevel(status: number): 'info' | 'warn' | 'error' {
  if (status === 0) return 'error'; // network failure / abort — no HTTP status
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
}

const FETCH_MARKER = Symbol.for('__traceitx_patched_fetch__');
const XHR_MARKER = Symbol.for('__traceitx_patched_xhr__');

// Phase-1 sensitive-header lock — values are replaced with '[REDACTED]', keys preserved.
// Lowercase comparison; mirrors sdk-core/src/redaction defaults.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

export function filterHeaders(
  h: Headers | Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  // Headers#forEach is in lib.dom (no DOM.Iterable needed); plain-object branch uses
  // Object.entries which is ES2017+.
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
    });
  } else {
    for (const [k, v] of Object.entries(h)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
    }
  }
  return out;
}

/** Read a request init body as text when cheaply possible; else signal 'unsupported'. */
function readRequestBody(
  init: RequestInit | undefined,
): { text?: string; skipped?: 'unsupported' } {
  const b = init?.body;
  if (b == null) return {};
  if (typeof b === 'string') return { text: b };
  if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) {
    return { text: b.toString() };
  }
  return { skipped: 'unsupported' };
}

/**
 * F19 (round-2 review) — cap-before-redaction leaks boundary-straddling
 * secrets. Extra bytes read PAST the byte cap, purely for redaction-window
 * purposes, so a secret (CC/SSN/JWT/bearer) starting just before the cap
 * boundary is still fully present for the regexes to match instead of being
 * cut mid-secret. Mirrors the native SDKs' `secretScanOverlap` /
 * `SECRET_SCAN_OVERLAP` constant exactly (ac39a9c9 F6, mirrored again on
 * Android) — the window is redacted FIRST, then truncated to the byte cap on
 * the REDACTED output, so plaintext is never truncated ahead of redaction.
 *
 * Residual risk (documented, not closed by this constant, same as native):
 * a secret that starts within the first `byteCap` bytes but is itself
 * longer than `byteCap + SECRET_SCAN_OVERLAP` bytes still straddles the
 * WIDENED window's end and can leak a partial run. 4096 bytes is judged
 * wide enough that no real-world secret shape here (credit card, SSN, JWT,
 * bearer token) gets anywhere close to exhausting it from a start point
 * inside the window.
 */
const SECRET_SCAN_OVERLAP = 4096;

/**
 * F25 — small headroom (in bytes) retained past `windowCap` in
 * `readCappedText`'s stream loop, purely to give a UTF-8 multi-byte
 * character that starts inside the window enough trailing bytes to decode
 * without corrupting into a replacement character before `capUtf8` gets a
 * chance to trim it cleanly. 3 is exact: the longest UTF-8 sequence is 4
 * bytes, so a sequence starting at the very last retained byte needs at
 * most 3 more.
 */
const UTF8_TAIL_MARGIN = 3;

/**
 * Build a redacted+capped body entry from raw text for one direction:
 * fetch-request, XHR-request, XHR-response. `raw` is always the FULL text
 * for these three directions (fetch init bodies and XHR's buffered
 * `responseText` are never read in a size-bounded way) — only the fetch
 * RESPONSE direction reads a bounded prefix directly off a stream (see
 * `readCappedText` below).
 *
 * F29 (round-6 review) — `raw` can be a multi-megabyte string (a large POST
 * body, a large JSON `responseText`). The OLD implementation ran every
 * redaction regex over the FULL string and then had `capUtf8` re-encode the
 * FULL REDACTED string before truncating — both costs scaling with
 * `raw.length`, on the app's path, independent of `bodyByteCap`. Fixed by
 * windowing FIRST, via the SAME boundary-safe helper (`capUtf8`) the
 * streamed fetch-response path uses: `capUtf8(raw, windowCap)` is called
 * exactly once — it still has to walk the whole string to measure its true
 * encoded length (F30 needs that exact number, and there is no cheaper way
 * to learn a JS string's UTF-8 byte length than encoding it once) — but
 * EVERYTHING downstream of that single call, the redaction regexes and the
 * final `capUtf8` cap, now runs over the small WINDOWED text only, never
 * over the full original. That closes both costs the finding called out:
 * unbounded regex work, and the second (redundant, now-eliminated) full
 * encode of the redacted string.
 *
 * F30 (round-6 review) — `<dir>BodyBytes` must report the ORIGINAL,
 * pre-redaction byte length: redaction can change the string's length in
 * either direction (a 21-byte card number becomes the 13-byte marker
 * `[REDACTED:CC]`), so measuring bytes on the REDACTED string (the old bug)
 * reports the wrong number. `capUtf8(text, cap).bytes` is always the full
 * encoded length of whatever `text` it is handed, regardless of `cap` —
 * calling it on `raw` (BEFORE redaction) is what makes `windowed.bytes` the
 * true original size instead of the post-redaction one.
 */
function bodyField(
  raw: string,
  cfg: { bodyByteCap: number },
  redaction: RedactionConfig,
): { body: string; truncated: boolean; bytes: number } {
  const windowCap = cfg.bodyByteCap + SECRET_SCAN_OVERLAP;
  const windowed = capUtf8(raw, windowCap);
  const redactedWindow = redactBodyText(windowed.text, redaction);
  const capped = capUtf8(redactedWindow, cfg.bodyByteCap);
  return { body: capped.text, truncated: windowed.bytes > cfg.bodyByteCap, bytes: windowed.bytes };
}

/**
 * readCappedText — read a fetch Response body up to ~(byteCap +
 * SECRET_SCAN_OVERLAP) bytes WITHOUT draining the rest of the stream
 * (DEFE-02 / spec D8: never buffer the whole body; a chunked/SSE response
 * must never be fully drained just to capture it). Reads chunks until either
 * the accumulated size reaches the WIDENED window or the stream finishes,
 * whichever comes first.
 *
 * Returns the WINDOW text (up to byteCap + SECRET_SCAN_OVERLAP bytes) —
 * NOT yet truncated to `byteCap` — so the caller can redact the full window
 * before truncating the REDACTED output down to `byteCap` (F19: redact
 * before cap, never cap before redact).
 *
 * - Stopped early because the WIDENED window was hit (stream not yet done):
 *   the reader is cancelled and `truncated` is true. `exactBytes` (F30) is
 *   the response's declared `Content-Length` when present and consistent
 *   with what we actually read (mirrors Android's `resBodyBytes =
 *   contentLength when known`) — we did not drain the stream, so we cannot
 *   measure the true total ourselves; when `Content-Length` is absent
 *   `exactBytes` is deliberately omitted rather than inventing a number
 *   (matches the native SDKs' null-when-unknown convention).
 * - Stream finished within the window: `total` (the exact number of bytes
 *   actually read) IS the true original size regardless of whether it
 *   exceeds `byteCap`, so `exactBytes` is always set and `truncated` is
 *   decided directly against `byteCap`.
 *
 * Falls back to `res.text()` when `res.body` is unavailable (some
 * test/jsdom environments don't implement the streaming body) — still
 * invoked only from the backgrounded (non-blocking) caller. This fallback
 * cannot avoid draining the whole response over the wire (there is no
 * bounded-read alternative without a streaming body), but F29/F30 still
 * apply to what happens with that text afterward: a SINGLE `capUtf8` call
 * both measures the true original byte length and produces the
 * boundary-safe windowed text, replacing the previous two redundant
 * full-string encodes.
 */
async function readCappedText(
  res: Response,
  byteCap: number,
): Promise<{ text: string; truncated: boolean; exactBytes?: number }> {
  const windowCap = byteCap + SECRET_SCAN_OVERLAP;
  const body = res.body;
  if (!body) {
    const full = await res.text();
    const windowed = capUtf8(full, windowCap);
    return { text: windowed.text, truncated: windowed.bytes > byteCap, exactBytes: windowed.bytes };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let hitWindow = false;
  // F25 (round-5 review) — bound each chunk BEFORE retaining it. A
  // service-worker/custom Response can hand back one arbitrarily large
  // chunk (e.g. 32 MiB) in a single `reader.read()`; pushing it wholesale
  // and only checking `total` against the cap AFTER meant a stream whose
  // first chunk vastly exceeds the window retained (and later re-copied
  // into a matching-size `Uint8Array(total)`) that whole oversized chunk —
  // contradicting this helper's bounded-read contract. `retainCap` adds a
  // few bytes of headroom past `windowCap` (UTF8_TAIL_MARGIN) purely so the
  // single `TextDecoder().decode(merged)` below never has to decode a raw
  // byte sequence deliberately cut mid multi-byte UTF-8 character — the
  // longest possible UTF-8 sequence is 4 bytes, so 3 extra bytes are always
  // enough to let a character that starts inside the window-byte prefix
  // decode cleanly; `capUtf8` (unchanged) still does the exact, boundary-
  // safe trim down to `windowCap` immediately below, so the returned text
  // is byte-for-byte identical to what this function returned before this
  // fix — only the amount of memory retained/copied to get there is bounded
  // now.
  const retainCap = windowCap + UTF8_TAIL_MARGIN;
  for (;;) {
    const { done, value } = await reader.read();
    if (value && value.byteLength > 0) {
      const remaining = retainCap - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        hitWindow = true;
        if (!done) {
          // Fire-and-forget: never AWAIT cancel() here. It's a best-effort
          // courtesy to the underlying source — some tee()/clone()
          // implementations do not settle a lone branch's cancel() promptly
          // while the sibling branch (the app's own `res`) is still open and
          // unread/uncancelled, which would otherwise hang OUR capture
          // (though never the app's own request/response) indefinitely.
          reader.cancel().catch(() => {
            /* best-effort cancel — DEFE-02 */
          });
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (total >= windowCap) {
      hitWindow = true;
      if (!done) {
        reader.cancel().catch(() => {
          /* best-effort cancel — DEFE-02 */
        });
      }
      break;
    }
    if (done) break;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder().decode(merged);
  const windowed = capUtf8(decoded, windowCap);
  // hitWindow ⇒ total >= windowCap > byteCap ⇒ definitely truncated. The true
  // original size is unknown from what we read (we deliberately stopped
  // early), so fall back to the response's declared Content-Length (F30) —
  // but only trust it when it's consistent with what we actually observed
  // (>= total): never report a number smaller than what we saw.
  if (hitWindow) {
    const declaredRaw = res.headers.get('content-length');
    const declared = declaredRaw != null ? Number(declaredRaw) : NaN;
    if (Number.isFinite(declared) && declared >= total) {
      return { text: windowed.text, truncated: true, exactBytes: declared };
    }
    return { text: windowed.text, truncated: true };
  }
  // Stream finished naturally within the window: `total` IS the exact
  // original size (known regardless of whether it exceeds `byteCap`).
  return { text: windowed.text, truncated: total > byteCap, exactBytes: total };
}

/**
 * installFetchPatcher — Wraps globalThis.fetch to push a NetworkEntry per call.
 * Captures method/url/status/durationMs/startedAt + filtered response headers.
 * Request/response bodies are captured only when `opts.bodyCapture` is
 * supplied and its `enabled()` gate is true (spec 2026-07-18 §6); absent that,
 * behavior is unchanged from the metadata-only v1 patcher.
 *
 * Idempotent via Symbol.for('__traceitx_patched_fetch__'); returns uninstall fn.
 */
export function installFetchPatcher(opts: NetworkPatcherOptions = {}): () => void {
  if (typeof globalThis === 'undefined' || typeof globalThis.fetch !== 'function') {
    return () => undefined;
  }
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (slot[FETCH_MARKER]) return () => undefined;
  slot[FETCH_MARKER] = true;

  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const start = performance.now();
    const startedAt = Date.now();
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method =
      init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');
    // F42 (round-9 review) — pin body-capture identity to whichever adapter
    // is bound RIGHT NOW, at request-issue time, before `await original()`
    // (or anything else async) runs. See `pinBodyCapture`'s doc comment for
    // why this must happen here rather than at the (later) decision point.
    const bc = opts.bodyCapture ? pinBodyCapture(opts.bodyCapture) : undefined;
    try {
      const res = await original(input, init);
      const durationMs = performance.now() - start;
      pushNetworkEntry({
        method,
        url,
        status: res.status,
        durationMs,
        startedAt,
        headers: filterHeaders(res.headers),
      });

      let reqId: number | undefined;
      if (bc) {
        try {
          if (bc.enabled()) {
            // F34 — captured HERE, at the decision point, before any of the
            // (possibly async, for the response direction) body-read work
            // below. Handed to every `bc.sink()` call below unchanged.
            const gateGeneration = bc.generation?.();
            reqId = bc.nextReqId();
            const cfg = bc.config();
            const redaction = bc.redaction();
            const entry: NetworkBodyEntry = { ref: reqId, t: startedAt };

            // Request body (from init). Normalize headers the way the Fetch spec
            // does: a plain-string body implies 'text/plain;charset=UTF-8' and a
            // URLSearchParams body implies 'application/x-www-form-urlencoded'
            // when the caller didn't set an explicit content-type — the same
            // default the underlying fetch would send on the wire.
            const reqHeadersObj = new Headers(init?.headers as HeadersInit | undefined);
            if (!reqHeadersObj.has('content-type')) {
              const body = init?.body;
              if (typeof body === 'string') {
                reqHeadersObj.set('content-type', 'text/plain;charset=UTF-8');
              } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                reqHeadersObj.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
              }
            }
            const reqCt = reqHeadersObj.get('content-type');
            const reqRead = readRequestBody(init);
            if (reqRead.skipped) {
              entry.reqBodySkipped = reqRead.skipped;
            } else if (reqRead.text !== undefined) {
              if (contentTypeAllowed(reqCt, cfg.bodyContentTypes)) {
                const f = bodyField(reqRead.text, cfg, redaction);
                entry.reqBody = f.body;
                if (f.truncated) {
                  entry.reqBodyTruncated = true;
                  entry.reqBodyBytes = f.bytes;
                }
              } else {
                entry.reqBodySkipped = 'content-type';
              }
            }
            if (init?.headers != null) {
              entry.reqHeaders = filterHeaders(reqHeadersObj);
            }

            // Response body — clone SYNCHRONOUSLY (before `return res` below) so
            // the app's own stream is completely untouched, then read/redact/sink
            // in the background. Never await this: draining an SSE/chunked body
            // here would hang the app's `await fetch()` forever (DEFE-02 / D8).
            const clone = res.clone();
            const resCt = res.headers.get('content-type');
            entry.resHeaders = filterHeaders(res.headers);
            if (contentTypeAllowed(resCt, cfg.bodyContentTypes)) {
              void readCappedText(clone, cfg.bodyByteCap)
                .then(({ text, truncated, exactBytes }) => {
                  // F19: `text` is the WIDENED window (up to bodyByteCap +
                  // SECRET_SCAN_OVERLAP bytes read off the read prefix, never
                  // the full drained body — draining to redact fully would
                  // defeat the whole point of the non-blocking, bounded read
                  // above). Redact the WHOLE window FIRST, then truncate the
                  // REDACTED string down to the byte cap — never the other
                  // way around, or a secret straddling the cap boundary
                  // leaks an unredacted, regex-too-short fragment.
                  const redactedWindow = redactBodyText(text, redaction);
                  if (truncated) {
                    entry.resBody = capUtf8(redactedWindow, cfg.bodyByteCap).text;
                    entry.resBodyTruncated = true;
                  } else {
                    entry.resBody = redactedWindow;
                  }
                  // F30: unlike truncated-req/XHR directions (which only
                  // report bytes when truncated, since the untruncated case
                  // is self-evidently `body.length`), the streamed fetch-
                  // response direction can know its ORIGINAL size even while
                  // truncated (stream fully drained within the window, or a
                  // trustworthy Content-Length) — so report it whenever
                  // `readCappedText` gave us one, truncated or not.
                  if (exactBytes !== undefined) {
                    entry.resBodyBytes = exactBytes;
                  }
                  bc.sink(entry, gateGeneration);
                })
                .catch(() => {
                  entry.resBodySkipped = 'error';
                  bc.sink(entry, gateGeneration);
                });
            } else {
              entry.resBodySkipped = 'content-type';
              bc.sink(entry, gateGeneration);
            }
          }
        } catch {
          /* swallow — DEFE-02; never affect the app path */
        }
      }

      networkCrumb(opts, {
        message: `${method} ${url} ${res.status}`,
        level: statusLevel(res.status),
        data: { method, url, status: res.status, durationMs, ...(reqId !== undefined ? { reqId } : {}) },
      });
      return res;
    } catch (err) {
      const durationMs = performance.now() - start;
      pushNetworkEntry({
        method,
        url,
        durationMs,
        startedAt,
      });
      networkCrumb(opts, {
        message: `${method} ${url} failed`,
        level: 'error',
        data: { method, url, durationMs },
      });
      throw err;
    }
  };
  return () => {
    globalThis.fetch = original;
    delete slot[FETCH_MARKER];
  };
}

interface XHRWithMeta extends XMLHttpRequest {
  __txx_method?: string;
  __txx_url?: string;
  __txx_start?: number;
  __txx_startedAt?: number;
  /**
   * F33 (round-7 review) — the request Content-Type, captured off a patched
   * `setRequestHeader` call. Unlike the response side (`getResponseHeader`
   * is always observable post-hoc), XHR gives no way to read back a request
   * header the app set — so this is the ONLY way `send()` can learn it.
   * Reset on every `open()` so a reused XHR instance never leaks a stale
   * content-type from a prior request into this one's allowlist decision.
   */
  __txx_reqContentType?: string;
}

/**
 * installXHRPatcher — Patches XMLHttpRequest.prototype.open + send to push a
 * NetworkEntry on readystatechange===4. Captures method/url/status/durationMs.
 *
 * Idempotent via Symbol.for('__traceitx_patched_xhr__'); returns uninstall fn.
 */
export function installXHRPatcher(opts: NetworkPatcherOptions = {}): () => void {
  if (typeof globalThis === 'undefined' || typeof XMLHttpRequest === 'undefined') {
    return () => undefined;
  }
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (slot[XHR_MARKER]) return () => undefined;
  slot[XHR_MARKER] = true;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (
    this: XHRWithMeta,
    method: string,
    url: string | URL,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ) {
    this.__txx_method = method;
    this.__txx_url = typeof url === 'string' ? url : url.href;
    // A reused XHR instance (open() called again without `new`) must not
    // carry a prior request's content-type into this one's allowlist check.
    delete this.__txx_reqContentType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origOpen.apply(this, [method, url, ...rest] as any);
  };

  // F33 (round-7 review) — record the request's Content-Type so `send()` can
  // run it through the SAME `contentTypeAllowed` allowlist check the fetch
  // request path uses. XHR has no way to read a request header back after
  // the fact (unlike the response side), so this is the only observation
  // point. Bookkeeping is guarded so a malformed/odd call can never throw
  // out of our wrapper; the original call is always forwarded unconditionally
  // so app-visible behavior (including any native throw, e.g. calling before
  // open()) is unchanged.
  XMLHttpRequest.prototype.setRequestHeader = function (
    this: XHRWithMeta,
    name: string,
    value: string,
  ) {
    try {
      if (typeof name === 'string' && name.toLowerCase() === 'content-type') {
        this.__txx_reqContentType = String(value);
      }
    } catch {
      /* swallow — DEFE-02; our bookkeeping must never affect the app's call */
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (
    this: XHRWithMeta,
    requestBody?: Document | XMLHttpRequestBodyInit | null,
  ) {
    this.__txx_start = performance.now();
    this.__txx_startedAt = Date.now();
    const reqBodyText = typeof requestBody === 'string' ? requestBody : undefined;
    const reqBodyUnsupported = requestBody != null && typeof requestBody !== 'string';
    // F42 (round-9 review) — pin body-capture identity to whichever adapter
    // is bound RIGHT NOW, at send() time — the response (and thus `onDone`,
    // where decision + sink both live) can land arbitrarily later, and by
    // then a different adapter may be bound. See `pinBodyCapture`'s doc
    // comment.
    const bc = opts.bodyCapture ? pinBodyCapture(opts.bodyCapture) : undefined;
    const onDone = () => {
      if (this.readyState === 4) {
        const durationMs = performance.now() - (this.__txx_start ?? performance.now());
        pushNetworkEntry({
          method: this.__txx_method ?? 'GET',
          url: this.__txx_url ?? '',
          status: this.status,
          durationMs,
          startedAt: this.__txx_startedAt ?? Date.now(),
        });

        let reqId: number | undefined;
        if (bc) {
          try {
            if (bc.enabled()) {
              // F34 — captured at the decision point, exactly like the
              // fetch patcher above. The XHR direction builds/sinks the
              // entry entirely synchronously within THIS `onDone` call (no
              // async gap within onDone itself) — but `onDone` can fire
              // arbitrarily later than `send()` (F42, round-9 review), which
              // is why `bc` is the pinned-at-send()-time wrapper, not
              // `opts.bodyCapture` directly. Threading the token through
              // also keeps `sink()`'s contract uniform across both patchers.
              const gateGeneration = bc.generation?.();
              reqId = bc.nextReqId();
              const cfg = bc.config();
              const redaction = bc.redaction();
              const entry: NetworkBodyEntry = { ref: reqId, t: this.__txx_startedAt ?? Date.now() };

              if (reqBodyUnsupported) {
                entry.reqBodySkipped = 'unsupported';
              } else if (reqBodyText !== undefined) {
                // F33 (round-7 review) — the request Content-Type is only known
                // if the app explicitly called setRequestHeader('Content-Type', …)
                // (recorded above into __txx_reqContentType). When it wasn't set,
                // the browser may still send a DEFAULT content-type on the wire
                // (e.g. 'text/plain;charset=UTF-8' for a string body) that this
                // SDK cannot observe — so an absent header must be treated as
                // "unknown", never as "allowed". contentTypeAllowed(undefined, …)
                // already returns false, giving default-deny for free.
                if (contentTypeAllowed(this.__txx_reqContentType, cfg.bodyContentTypes)) {
                  const f = bodyField(reqBodyText, cfg, redaction);
                  entry.reqBody = f.body;
                  if (f.truncated) {
                    entry.reqBodyTruncated = true;
                    entry.reqBodyBytes = f.bytes;
                  }
                } else {
                  entry.reqBodySkipped = 'content-type';
                }
              }

              const resCt = this.getResponseHeader('content-type');
              const textReadable = this.responseType === '' || this.responseType === 'text';
              if (textReadable && contentTypeAllowed(resCt, cfg.bodyContentTypes)) {
                const f = bodyField(this.responseText, cfg, redaction);
                entry.resBody = f.body;
                if (f.truncated) {
                  entry.resBodyTruncated = true;
                  entry.resBodyBytes = f.bytes;
                }
              } else {
                entry.resBodySkipped = 'content-type';
              }
              if (resCt) {
                entry.resHeaders = { 'content-type': resCt };
              }

              bc.sink(entry, gateGeneration);
            }
          } catch {
            /* swallow — DEFE-02 */
          }
        }

        const xhrStatus = this.status;
        const xhrMethod = this.__txx_method ?? 'GET';
        const xhrUrl = this.__txx_url ?? '';
        networkCrumb(opts, {
          message:
            xhrStatus === 0
              ? `${xhrMethod} ${xhrUrl} failed`
              : `${xhrMethod} ${xhrUrl} ${xhrStatus}`,
          level: statusLevel(xhrStatus),
          data: {
            method: xhrMethod,
            url: xhrUrl,
            status: xhrStatus,
            durationMs,
            ...(reqId !== undefined ? { reqId } : {}),
          },
        });
        this.removeEventListener('readystatechange', onDone);
      }
    };
    this.addEventListener('readystatechange', onDone);
    return origSend.call(this, requestBody ?? null);
  };

  return () => {
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    XMLHttpRequest.prototype.setRequestHeader = origSetRequestHeader;
    delete slot[XHR_MARKER];
  };
}

export const __SENSITIVE_HEADERS_FOR_TESTING = SENSITIVE_HEADERS;
