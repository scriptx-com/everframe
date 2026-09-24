// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchPatcher, type BodyCaptureHooks } from '../../src/capture/network.js';
import * as networkBodyModule from '../../src/capture/network-body.js';
import { createNetworkBodyBuffer } from '@everframe/sdk-core';
import type { NetworkBodyEntry } from '@everframe/protocol';

// A large body used by the F29 bounded-prefix tests below. Deliberately NOT
// one giant unbroken run of word characters: the redaction engine's
// JWT_INLINE regex (`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
// greedily matches an unbroken run and then backtracks character-by-character
// looking for a literal '.' — on a multi-megabyte homogeneous run (e.g.
// `'a'.repeat(5_000_000)`) with no '.' anywhere, that backtracking is
// quadratic and effectively never finishes. Interspersing a space every
// character keeps every match attempt bounded to a single char, avoiding
// that (pre-existing, unrelated) pathological case while still exercising a
// realistic multi-megabyte body.
function bigBody(byteLen: number): string {
  return 'x '.repeat(Math.ceil(byteLen / 2));
}

function hooks(over: Partial<BodyCaptureHooks> = {}): { h: BodyCaptureHooks; sunk: NetworkBodyEntry[] } {
  const sunk: NetworkBodyEntry[] = [];
  let id = 0;
  const h: BodyCaptureHooks = {
    enabled: () => true,
    config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json', 'text/*'] }),
    redaction: () => ({}),
    nextReqId: () => ++id,
    sink: (e) => sunk.push(e),
    ...over,
  };
  return { h, sunk };
}

describe('fetch body capture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('captures + redacts a JSON response body and does not disturb app consumption', async () => {
    const appJson = { card: '4242 4242 4242 4242' };
    const original = vi.fn(async () =>
      new Response(JSON.stringify(appJson), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', original);
    const { h, sunk } = hooks();
    const uninstall = installFetchPatcher({ bodyCapture: h });

    const res = await fetch('https://api.test/x', { method: 'POST', body: '{"q":1}' });
    const appBody = await res.json(); // app still reads its body

    expect(appBody).toEqual(appJson);           // app consumption intact
    await vi.waitFor(() => expect(sunk).toHaveLength(1)); // response body sinks in the background
    expect(sunk[0].resBody).toContain('[REDACTED:CC]'); // body redacted
    expect(sunk[0].reqBody).toBe('{"q":1}');
    expect(typeof sunk[0].ref).toBe('number');
    uninstall();
  });

  it('skips a non-allowlisted response body with resBodySkipped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png' } })));
    const { h, sunk } = hooks();
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/img');
    await vi.waitFor(() => expect(sunk).toHaveLength(1));
    expect(sunk[0].resBody).toBeUndefined();
    expect(sunk[0].resBodySkipped).toBe('content-type');
    uninstall();
  });

  it('marks an unsupported (Blob) request body as skipped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const { h, sunk } = hooks();
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/x', { method: 'POST', body: new Blob(['bin']) });
    await vi.waitFor(() => expect(sunk).toHaveLength(1));
    expect(sunk[0].reqBodySkipped).toBe('unsupported');
    uninstall();
  });

  it('captures nothing when the gate is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const { h, sunk } = hooks({ enabled: () => false });
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/x');
    expect(sunk).toHaveLength(0);
    uninstall();
  });

  it('does not block the app and never drains an unbounded (SSE-like) stream — truncates at the byte cap', async () => {
    // A stream that emits chunks forever and never calls controller.close().
    // Without the DEFE-02/D8 fix, capturing this via `.text()` would hang the
    // app's `await fetch()` forever. With the fix, the read stops as soon as
    // the byte cap is hit and requests cancellation — it never "finishes".
    let pullCount = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        controller.enqueue(encoder.encode('abcd')); // 4 bytes/chunk, forever
      },
    });
    const res = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    vi.stubGlobal('fetch', vi.fn(async () => res));

    // Spy on the reader prototype so we can assert OUR code called
    // reader.cancel() — we deliberately do NOT assert the underlying
    // source's own `cancel()` callback fired, because per the WHATWG
    // streams spec a tee()'d branch's cancel() does not propagate to the
    // source until BOTH branches are cancelled/drained; since this test
    // never touches the app's own `gotRes`, that propagation legitimately
    // never happens. What we care about is that OUR read loop requested
    // cancellation rather than hanging or draining forever.
    const probeReader = new ReadableStream().getReader();
    const cancelSpy = vi.spyOn(Object.getPrototypeOf(probeReader), 'cancel');

    const byteCap = 10;
    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    // The app's fetch resolves promptly — it is never gated behind the
    // (never-ending) response-body read.
    const gotRes = await fetch('https://api.test/sse');
    expect(gotRes).toBeDefined();
    expect(gotRes.status).toBe(200);
    // At most a handful of pulls happened by the time fetch() resolved — the
    // stream (which emits forever) was never fully drained.
    expect(pullCount).toBeLessThan(10);

    await vi.waitFor(() => expect(sunk).toHaveLength(1));
    expect(sunk[0].resBodyTruncated).toBe(true);
    expect(sunk[0].resBody).toBeDefined();
    expect(sunk[0].resBody!.length).toBeLessThanOrEqual(byteCap);
    expect(sunk[0].resBodyBytes).toBeUndefined(); // unknown — we didn't drain
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalled()); // requested, fire-and-forget
    uninstall();
  });

  it('F25: a single oversized chunk is bounded to the window before being retained/copied', async () => {
    // Reviewer repro: cap 8192 with a stream that yields ONE chunk far larger
    // than the (byteCap + SECRET_SCAN_OVERLAP) window (1 MiB). Before the
    // fix, the whole 1 MiB chunk was pushed into `chunks` BEFORE the size
    // check ran, then merged into a second same-size `Uint8Array(total)` —
    // i.e. ~2 MiB retained/copied for an 8 KiB-capped read. The fix must
    // bound the copy to the window (byteCap + SECRET_SCAN_OVERLAP = 12288)
    // regardless of how oversized the incoming chunk is.
    const byteCap = 8192;
    const windowCap = byteCap + 4096; // SECRET_SCAN_OVERLAP
    const oneMiB = 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(oneMiB).fill(97)); // 1 MiB of 'a'
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    vi.stubGlobal('fetch', vi.fn(async () => res));

    // TextDecoder.decode() is called exactly once on the merged/bounded
    // buffer inside readCappedText — spying on it lets us assert on the
    // ACTUAL bytes retained/copied, not just the (already-correct) final
    // output, so this test fails if the unbounded chunk is retained.
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');

    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/huge-chunk');
    await vi.waitFor(() => expect(sunk).toHaveLength(1));

    expect(decodeSpy).toHaveBeenCalled();
    const decodedArg = decodeSpy.mock.calls[0]![0] as Uint8Array;
    // Bounded copy: must be close to the window, nowhere near the 1 MiB
    // source chunk. A small UTF-8-boundary safety margin (a few bytes) is
    // allowed on top of the window; the 1 MiB chunk being retained wholesale
    // would show up here as ~1,048,576 bytes.
    expect(decodedArg.byteLength).toBeLessThan(windowCap + 64);
    expect(decodedArg.byteLength).toBeGreaterThanOrEqual(windowCap);

    expect(sunk[0].resBodyTruncated).toBe(true);
    expect(sunk[0].resBody).toBeDefined();
    expect(sunk[0].resBody!.length).toBeLessThanOrEqual(byteCap);
    expect(sunk[0].resBody).toBe('a'.repeat(byteCap)); // capped output unchanged
    uninstall();
  });

  it('F25: many small chunks summing past the window still truncate correctly (regression guard)', async () => {
    // Same effective scenario as the pre-existing SSE-like test but focused
    // on the truncation/byte-accounting outcome rather than pull-count
    // timing: lots of small chunks that individually never trip the
    // (chunk.byteLength > remaining) branch, only cumulatively.
    const byteCap = 10;
    const windowCap = byteCap + 4096;
    let emitted = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted++;
        controller.enqueue(encoder.encode('ab')); // 2 bytes/chunk
        if (emitted > windowCap) controller.close(); // safety net so the stream terminates
      },
    });
    const res = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    vi.stubGlobal('fetch', vi.fn(async () => res));

    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/many-small-chunks');
    await vi.waitFor(() => expect(sunk).toHaveLength(1));

    expect(sunk[0].resBodyTruncated).toBe(true);
    expect(sunk[0].resBody).toBeDefined();
    expect(sunk[0].resBody!.length).toBeLessThanOrEqual(byteCap);
    expect(sunk[0].resBody).toBe('ab'.repeat(byteCap / 2));
    expect(sunk[0].resBodyBytes).toBeUndefined(); // hit the window — true size unknown
    uninstall();
  });

  it('F19: redacts a secret that straddles the byte cap boundary instead of leaking an unredacted prefix', async () => {
    // Reviewer repro: cap 13, body 'aaaa:4242424242424242' (a 16-digit Luhn-valid
    // card number starting at byte 5; the ':' gives the CC regex's leading `\b`
    // a word boundary to match on, exactly as a real 'field:value' body would).
    // Cutting to 13 bytes BEFORE redaction yields 'aaaa:4242424' — an unredacted
    // 7-digit card-number prefix, since the regex never sees the full digit run
    // (too short to even match the {11,21}-digit pattern). Redacting the
    // WIDENED window first, then truncating the REDACTED text down to the cap,
    // must never leak that raw digit run.
    const body = 'aaaa:4242424242424242';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })));
    const byteCap = 13;
    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/secret');
    await vi.waitFor(() => expect(sunk).toHaveLength(1));
    expect(sunk[0].resBody).toBeDefined();
    expect(sunk[0].resBody).not.toMatch(/\d{6,}/); // no un-redacted digit run survives
    // Positive evidence redaction actually ran (not just "digits absent because
    // truncated before they were read"): the visible prefix of the redaction
    // marker itself must be present in the final, cap-truncated output.
    expect(sunk[0].resBody).toContain('[REDACT');
    expect(sunk[0].resBodyTruncated).toBe(true);
    uninstall();
  });

  // ==================== F29 (round-6 review): bound the inspected prefix on
  // every direction, not just the streamed fetch-response path ====================

  it('F29: a multi-megabyte fetch REQUEST body only hands redaction a bounded window, not the full body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const redactSpy = vi.spyOn(networkBodyModule, 'redactBodyText');
    const byteCap = 8192;
    const windowCap = byteCap + 4096; // SECRET_SCAN_OVERLAP
    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['application/json', 'text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    const hugeBody = bigBody(5_000_000); // ~5 MB request body
    await fetch('https://api.test/x', { method: 'POST', body: hugeBody });
    await vi.waitFor(() => expect(sunk).toHaveLength(1));

    // Reviewer repro for the OLD (unbounded) implementation: redactBodyText
    // was called with the FULL 5,000,000-char body. This assertion fails
    // against that implementation and only passes once the caller windows
    // `raw` down to `byteCap + SECRET_SCAN_OVERLAP` bytes BEFORE redacting.
    expect(redactSpy).toHaveBeenCalled();
    const seenLengths = redactSpy.mock.calls.map(([input]) => input.length);
    expect(Math.max(...seenLengths)).toBeLessThanOrEqual(windowCap);
    expect(sunk[0].reqBodyTruncated).toBe(true);
    uninstall();
  });

  it('F29: a multi-megabyte fetch RESPONSE body read via the !res.body fallback only hands redaction a bounded window', async () => {
    // Simulates "some test/jsdom environments don't implement the streaming
    // body" (the documented `readCappedText` fallback trigger) with a fake
    // Response-like object whose `.body` is null but `.text()` still works —
    // exercising the `!body` branch instead of the chunked-reader loop.
    const hugeBody = bigBody(5_000_000); // ~5 MB response body
    const headers = new Headers({ 'content-type': 'text/plain' });
    const fakeRes = {
      status: 200,
      headers,
      body: null,
      clone(): unknown {
        return fakeRes;
      },
      text: async () => hugeBody,
    };
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes as unknown as Response));
    const redactSpy = vi.spyOn(networkBodyModule, 'redactBodyText');
    const byteCap = 8192;
    const windowCap = byteCap + 4096;
    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    await fetch('https://api.test/huge-fallback');
    await vi.waitFor(() => expect(sunk).toHaveLength(1));

    expect(redactSpy).toHaveBeenCalled();
    const seenLengths = redactSpy.mock.calls.map(([input]) => input.length);
    expect(Math.max(...seenLengths)).toBeLessThanOrEqual(windowCap);
    expect(sunk[0].resBodyTruncated).toBe(true);
    // The !res.body fallback DOES drain the full response over the wire
    // (unavoidable without a streaming body API), so unlike the genuinely
    // partial streamed-read case, the true original size IS known here.
    expect(sunk[0].resBodyBytes).toBe(5_000_000);
    uninstall();
  });

  // ==================== F30 (round-6 review): <dir>BodyBytes reports the
  // ORIGINAL byte length, not the post-redaction one ====================

  it('F30: reqBodyBytes reports the ORIGINAL byte length, not the redacted (shorter) length', async () => {
    // Reviewer probe: raw 'aaaa:4242424242424242' is 21 bytes; redaction
    // replaces the card number with the 13-byte marker '[REDACTED:CC]',
    // shrinking the string to 18 bytes. A small cap forces truncation so
    // `reqBodyBytes` gets reported at all (existing convention: bytes is
    // only set when truncated).
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const body = 'aaaa:4242424242424242';
    expect(new TextEncoder().encode(body).length).toBe(21); // sanity on the raw size
    const byteCap = 13;
    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['application/json', 'text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    await fetch('https://api.test/x', { method: 'POST', body });
    await vi.waitFor(() => expect(sunk).toHaveLength(1));

    expect(sunk[0].reqBodyTruncated).toBe(true);
    expect(sunk[0].reqBody).toContain('[REDACT'); // redaction did run
    expect(sunk[0].reqBodyBytes).toBe(21); // ORIGINAL size, not the 18-byte redacted size
    uninstall();
  });

  it('F30: resBodyBytes reports the ORIGINAL byte length when the stream fully drains within the window despite exceeding the cap', async () => {
    // byteCap smaller than the redacted output but the FULL body still fits
    // inside byteCap + SECRET_SCAN_OVERLAP, so the stream finishes naturally
    // (no hitWindow) and the true original size is exactly knowable — this
    // covers the "total > byteCap but !hitWindow" branch that previously
    // omitted exactBytes even though the size was already known.
    const body = 'aaaa:4242424242424242'; // 21 bytes
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })));
    const byteCap = 13;
    const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    await fetch('https://api.test/secret');
    await vi.waitFor(() => expect(sunk).toHaveLength(1));

    expect(sunk[0].resBodyTruncated).toBe(true);
    expect(sunk[0].resBodyBytes).toBe(21); // original, pre-redaction size
    uninstall();
  });

  it('F30: unknown-length streamed truncation falls back to Content-Length when present, and stays undefined when absent (native parity)', async () => {
    // Case A — Content-Length declared and consistent with what was read:
    // report it (mirrors Android's `resBodyBytes = contentLength when known`).
    const byteCap = 10;
    async function streamOf(totalBytes: number, declareContentLength: boolean): Promise<Response> {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encoder.encode('a'));
        },
      });
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      if (declareContentLength) headers['content-length'] = String(totalBytes);
      return new Response(stream, { status: 200, headers });
    }

    {
      const res = await streamOf(50_000, true);
      vi.stubGlobal('fetch', vi.fn(async () => res));
      const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
      const uninstall = installFetchPatcher({ bodyCapture: h });
      await fetch('https://api.test/known-length');
      await vi.waitFor(() => expect(sunk).toHaveLength(1));
      expect(sunk[0].resBodyTruncated).toBe(true);
      expect(sunk[0].resBodyBytes).toBe(50_000); // taken from Content-Length
      uninstall();
      vi.unstubAllGlobals();
    }

    // Case B — no Content-Length: native parity is to omit the field
    // (Android reports null when Content-Length is absent), never invent one.
    {
      const res = await streamOf(50_000, false);
      vi.stubGlobal('fetch', vi.fn(async () => res));
      const { h, sunk } = hooks({ config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }) });
      const uninstall = installFetchPatcher({ bodyCapture: h });
      await fetch('https://api.test/unknown-length');
      await vi.waitFor(() => expect(sunk).toHaveLength(1));
      expect(sunk[0].resBodyTruncated).toBe(true);
      expect(sunk[0].resBodyBytes).toBeUndefined();
      uninstall();
    }
  });
});

// ==================== Round-7 review Finding F34 ====================
//
// A remote `captureBodies: false` must be authoritative at the final
// append/sink boundary, not just at the pre-read `enabled()` decision point.
// The fetch response direction is the one place on web with a genuine async
// gap between that decision (checked synchronously inside the patched
// `fetch()`) and the eventual `sink()` call (a `.then()` on the background,
// non-blocking `readCappedText` read) — exactly the shape of the reviewer's
// probe. These tests wire `sink` to a REAL `createNetworkBodyBuffer()` with
// the same guard-closure pattern `adapter.ts` installs in production, so the
// buffer-side enforcement is exercised end to end, not just asserted against
// a mock.
describe('F34: gate generation token must be authoritative at the sink boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  function hooksWithLiveGate(initial: { active: boolean; generation: number }) {
    let live = { ...initial };
    const buf = createNetworkBodyBuffer();
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => live.active,
      generation: () => live.generation,
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json', 'text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (entry, generation) => {
        buf.add(
          entry,
          generation === undefined
            ? undefined
            : () => live.active && live.generation === generation,
        );
      },
    };
    return { h, buf, setLive: (next: { active: boolean; generation: number }) => (live = next) };
  }

  it("reviewer's probe: a remote captureBodies:false landing between decision and sink drops the already-built entry", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"secret":"leak-me"}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const { h, buf, setLive } = hooksWithLiveGate({ active: true, generation: 1 });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    // The decision (enabled()===true, generation captured ===1) happens
    // synchronously INSIDE the patched fetch(), before it returns — so by
    // the time this `await` resolves, the token has already been captured.
    // Only the background response-body read/sink is still pending.
    await fetch('https://api.test/x');

    // Remote config refresh disables body capture — the exact race F34
    // closes — landing strictly BEFORE the pending sink() call.
    setLive({ active: false, generation: 2 });

    // Let the background readCappedText().then() → sink() → buf.add() chain run.
    await vi.waitFor(() => expect(buf.size + 1).toBeGreaterThanOrEqual(1)); // yield a microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(buf.size).toBe(0);
    uninstall();
  });

  it('happy path: an unchanged gate does not over-block a normal capture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const { h, buf } = hooksWithLiveGate({ active: true, generation: 1 });
    const uninstall = installFetchPatcher({ bodyCapture: h });

    await fetch('https://api.test/x');
    await vi.waitFor(() => expect(buf.size).toBe(1));

    expect(buf.size).toBe(1);
    uninstall();
  });

  it('a hooks object that omits generation() keeps the pre-F34 unguarded behavior', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const buf = createNetworkBodyBuffer();
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      // no `generation` hook — mirrors existing hand-rolled test doubles.
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json', 'text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (entry) => buf.add(entry),
    };
    const uninstall = installFetchPatcher({ bodyCapture: h });

    await fetch('https://api.test/x');
    await vi.waitFor(() => expect(buf.size).toBe(1));

    expect(buf.size).toBe(1);
    uninstall();
  });
});
