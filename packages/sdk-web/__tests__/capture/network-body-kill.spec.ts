// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-4 review Finding F17 (P1) — post-kill capture on web.
//
// Reviewer repro: buffer `size` went 1 → 0 → 1 across capture → client.kill()
// → one post-kill fetch. `createClient().kill()` cleared `state.networkBodies`
// but the installed fetch/XHR patchers stayed live, and the adapter's
// `bodyCapture.enabled()` only consulted the cached server config — neither
// checked `state.killed`. Fixed two ways (mirrors ac39a9c9's iOS kill-gating
// of capture + buffer):
//   1. `bodyCapture.enabled()` (adapter.ts) now returns false once the client
//      is killed (via the new `PlatformAdapter.onKill()` seam, called from
//      sdk-core's `client.kill()`).
//   2. `NetworkBodyBuffer.kill()` (sdk-core) is a PERMANENT append gate — even
//      if something races past #1, `add()` after `kill()` is a no-op. This is
//      what closes the IN-FLIGHT case: an async fetch-response body read
//      whose `enabled()` check ran (and passed) BEFORE kill(), but whose
//      `.then()` callback calls `sink()` → `add()` AFTER kill() has already
//      run.
//
// These tests drive the REAL adapter + REAL client wiring (the same seams
// provider.tsx wires up), not a hand-rolled BodyCaptureHooks stub, so they
// exercise the actual production post-kill path end to end.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createClient, __internalClientState } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A validated `GET /api/config` response with capture ON and sampling 100%. */
function configResponse(captureBodies: boolean): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: { captureBodies },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Flush pending microtasks (background body-capture `.then()` chains). */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Build a wired adapter + client exactly like provider.tsx does, with the
 * config route answering ON so real captures happen. `appFetchImpl` answers
 * every non-config URL. */
function wireClient(appFetchImpl: (input: RequestInfo | URL) => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse(true);
      return appFetchImpl(input);
    }),
  );
  const adapter = createWebPlatformAdapter({ apiKey: 'k' });
  adapters.push(adapter);
  const client = createClient(adapter);
  client.init({ apiKey: 'k' });
  adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
  return { adapter, client, buf: () => __internalClientState.get(client)!.networkBodies };
}

describe('F17: post-kill capture on web', () => {
  it('(a) capture → kill → post-kill fetch → buffer stays empty', async () => {
    const { adapter, client, buf } = wireClient(async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await adapter.__initReplay(); // resolves config ON, sampling passes (rate 1)

    await fetch('https://api.test/before-kill');
    await flushMicrotasks();
    expect(buf().size).toBe(1); // capture works pre-kill

    client.kill();
    expect(buf().size).toBe(0); // zeroized by kill()

    await fetch('https://api.test/after-kill');
    await flushMicrotasks();
    expect(buf().size).toBe(0); // reviewer repro: must NOT go back to 1
  });

  it('(b) IN-FLIGHT: a response body read that resolves AFTER kill() runs still leaves the buffer empty', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const { adapter, client, buf } = wireClient(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await adapter.__initReplay();

    // enabled() is checked synchronously inside the fetch patcher BEFORE the
    // response body stream is read — this call resolves with enabled()
    // already having returned true, exactly like production.
    const res = await fetch('https://api.test/slow');
    expect(res).toBeDefined();

    // kill() lands while the response body read is still pending (the
    // patcher's background readCappedText().then() has not fired yet).
    client.kill();
    expect(buf().size).toBe(0);

    // NOW let the body read resolve — its .then() callback calls
    // bc.sink(entry) → buffer.add(entry), strictly AFTER kill().
    controller!.enqueue(new TextEncoder().encode('a body that arrives late'));
    controller!.close();
    await flushMicrotasks();

    expect(buf().size).toBe(0); // the buffer-level kill() guard must have refused the append
  });

  it('a fresh request after kill() never even reaches the buffer sink (enabled() gate, not just the buffer guard)', async () => {
    const sinkCalls: number[] = [];
    const { adapter, client } = wireClient(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    // Instrument the real buffer's add() to prove enabled() itself gated
    // this request (not merely the buffer swallowing an attempted append).
    const state = __internalClientState.get(client)!;
    const originalAdd = state.networkBodies.add.bind(state.networkBodies);
    state.networkBodies.add = (e) => {
      sinkCalls.push(e.ref ?? -1);
      originalAdd(e);
    };

    await adapter.__initReplay();
    client.kill();

    await fetch('https://api.test/after-kill');
    await flushMicrotasks();
    expect(sinkCalls).toEqual([]); // add() was never even called
  });
});

// ==================== Round-8 review Finding F37 (P1) ====================
//
// Body capture is permanently dead after a Provider remount. The fetch/XHR
// patchers are install-once (Symbol.for markers on globalThis) and, pre-fix,
// closed over the FIRST adapter's `bodyCapture` object directly. Production
// teardown (Provider unmount → `client.kill()` → `adapter.onKill()`)
// permanently sets THAT adapter's own `killed` flag but never uninstalls the
// patchers — so a fresh Provider mount's new adapter's `installFetchPatcher`/
// `installXHRPatcher` calls just no-op (already installed), and the
// page-global patchers keep calling the DEAD adapter's hooks forever.
// Reviewer repro: capture (buffer size 1) → kill()/unmount → mount a fresh
// server-ON adapter → the second adapter's buffer stays 0.
//
// Fixed by mirroring the crumb-hook forwarding slot exactly
// (`__bindCrumbHooks`/`forwardingCrumbSink`/`forwardingCrumbGate` in
// breadcrumbs.ts): a module-level `forwardingBodyCaptureHooks` object
// (network.ts) that the install-once patchers close over FOREVER, and a
// `__bindBodyCaptureHooks()` slot that every `createWebPlatformAdapter()`
// call (construction time) AND `__rebindCrumbHooks()` (the Provider's mount
// effect, same StrictMode/Fast-Refresh/remount doctrine as crumbs/crash-sink)
// re-points at the CURRENT adapter's own `bodyCapture`.
//
// These tests drive the REAL adapter + REAL client wiring end to end (no
// hand-rolled BodyCaptureHooks stub) so they exercise the actual production
// remount path, not just the forwarding plumbing in isolation.
describe('F37 (round-8 review): body capture survives a Provider remount', () => {
  /** Minimal fake XHR that drives readystatechange to 4 with a JSON response
   * (same shape as network-body-xhr.spec.ts's FakeXHR) — used only for the
   * XHR variant of the repro below; the fetch variant uses `wireClient`. */
  class FakeXHR {
    status = 200;
    readyState = 0;
    responseType: XMLHttpRequestResponseType = '';
    responseText = '';
    private headers: Record<string, string> = {};
    private listeners: Record<string, Array<() => void>> = {};
    open(_m: string, _u: string) {}
    setRequestHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    }
    getResponseHeader(k: string) {
      return this.headers[k.toLowerCase()] ?? null;
    }
    addEventListener(t: string, cb: () => void) {
      (this.listeners[t] ??= []).push(cb);
    }
    removeEventListener() {}
    send(_b?: unknown) {
      this.readyState = 4;
      this.headers['content-type'] = 'application/json';
      this.responseText = '{"ok":true}';
      for (const cb of this.listeners['readystatechange'] ?? []) cb();
    }
  }

  /** Mount a second real adapter+client WITHOUT re-stubbing `fetch` — the
   * install-once patchers must stay wired to whatever `globalThis.fetch`/
   * `XMLHttpRequest` already is (re-stubbing here would silently bypass the
   * very patchers this suite is testing). Mirrors provider.tsx's useMemo
   * factory + mount-effect rebind exactly (construction binds the forwarding
   * slots once; `__rebindCrumbHooks()` re-claims them from the mount effect
   * for the pair React actually commits). */
  function mountAdapter() {
    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    adapter.__rebindCrumbHooks();
    return { adapter, client, buf: () => __internalClientState.get(client)!.networkBodies };
  }

  it('FETCH: kill/unmount A, mount fresh server-ON B — B captures (fails pre-fix: stays 0)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const A = mountAdapter();
    await A.adapter.__initReplay();
    await fetch('https://api.test/a-before-kill');
    await flushMicrotasks();
    expect(A.buf().size).toBe(1); // capture works pre-kill

    A.client.kill(); // production teardown path (Provider unmount → client.kill())
    expect(A.buf().size).toBe(0);

    // Fresh Provider mount — server still ON. `globalThis.fetch` is NEVER
    // re-stubbed here: it's still A's install-once patched wrapper, exactly
    // as it would be on a real page after a remount.
    const B = mountAdapter();
    await B.adapter.__initReplay();

    await fetch('https://api.test/b-after-remount');
    await flushMicrotasks();
    expect(B.buf().size).toBe(1); // the bug: this stayed 0 pre-fix
    expect(A.buf().size).toBe(0); // A's permanently-killed buffer must not be resurrected
  });

  it('XHR: kill/unmount A, mount fresh server-ON B — B captures (fails pre-fix: stays 0)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        throw new Error('unexpected fetch — this repro only issues XHR app requests');
      }),
    );
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);

    const issueXHR = (url: string): Promise<void> =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener('readystatechange', () => {
          if (xhr.readyState === 4) resolve();
        });
        xhr.open('GET', url);
        xhr.send(null);
      });

    const A = mountAdapter();
    await A.adapter.__initReplay();
    await issueXHR('https://api.test/a-xhr-before-kill');
    await flushMicrotasks();
    expect(A.buf().size).toBe(1);

    A.client.kill();
    expect(A.buf().size).toBe(0);

    const B = mountAdapter();
    await B.adapter.__initReplay();

    await issueXHR('https://api.test/b-xhr-after-remount');
    await flushMicrotasks();
    expect(B.buf().size).toBe(1); // the bug: this stayed 0 pre-fix
    expect(A.buf().size).toBe(0);
  });

  it('a killed client stays killed: rebinding to a fresh adapter never resurrects the old one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const A = mountAdapter();
    await A.adapter.__initReplay();
    await fetch('https://api.test/a');
    await flushMicrotasks();
    expect(A.buf().size).toBe(1);

    A.client.kill();

    const B = mountAdapter();
    await B.adapter.__initReplay();

    // Two more requests flow through the SAME page-global patched fetch,
    // now forwarding to B. Neither should ever land in A's permanently-dead
    // buffer, however many requests fire after the takeover (guards against
    // an over-eager rebind that forwards to "whichever adapter forwarded
    // last" instead of strictly the live one).
    await fetch('https://api.test/b-1');
    await fetch('https://api.test/b-2');
    await flushMicrotasks();
    expect(B.buf().size).toBe(2);
    expect(A.buf().size).toBe(0); // still, and forever, dead
  });

  it('idempotency preserved: a second adapter mounted without killing the first does not double-patch fetch', async () => {
    let appCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        appCalls++;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const A = mountAdapter();
    await A.adapter.__initReplay();

    // A second adapter mounts WITHOUT killing the first — e.g. StrictMode's
    // double-invoked factory, or Fast Refresh. installFetchPatcher/
    // installXHRPatcher must stay install-once (no double-wrapping).
    const B = mountAdapter();
    await B.adapter.__initReplay();

    await fetch('https://api.test/once');
    await flushMicrotasks();

    expect(appCalls).toBe(1); // exactly one underlying network call — never double-wrapped
    expect(B.buf().size).toBe(1); // the committed (last-bound) adapter is the live one

    const slot = globalThis as unknown as Record<symbol, unknown>;
    expect(slot[Symbol.for('__everframe_patched_fetch__')]).toBe(true); // installed exactly once
  });
});

// ==================== Round-9 review Finding F42 (P1) ====================
//
// CROSS-TENANT DATA LEAK — a captured body delivered to a DIFFERENT app's
// buffer. `forwardingBodyCaptureHooks` (network.ts) pre-fix resolved EVERY
// method — enabled()/generation()/config()/redaction()/nextReqId() AND
// sink() — against whichever adapter happened to be bound (module-level
// `boundBodyCapture`) at the moment each individual call ran:
//   - fetch: the decision block (enabled/generation/reqId) runs
//     synchronously right after the response headers arrive, but `sink()`
//     fires later, inside the background `readCappedText().then()` — if
//     kill()+remount lands in that async gap, the entry is handed to the
//     NEW adapter's sink.
//   - XHR: decision AND sink both live inside the SAME `readystatechange`
//     (===4) handler — but that handler doesn't fire until the response
//     actually arrives, arbitrarily later than `send()` — so a kill()+
//     remount landing between `send()` and the response arriving
//     misattributes the ENTIRE capture (not just delivery) to the new
//     adapter.
// Either way: adapter A's private response body — captured under app A's
// api key — ends up in app B's buffer, ready to ship under B's key.
//
// The per-adapter F34 generation guard does NOT save this: two freshly
// constructed adapters routinely both start at generation 1 (no transition
// has happened yet on either), so the token "matches" purely by coincidence.
//
// Fixed by pinning the adapter's IDENTITY (not just a generation number) at
// request-issue time (network.ts's `pinBodyCapture`): the exact
// `BodyCaptureHooks` instance bound at that moment is snapshotted, and every
// method (enabled/generation/config/redaction/nextReqId/sink) for THIS
// request delegates to that ONE snapshot, never re-reading the live
// `boundBodyCapture` slot again. `sink()` additionally re-checks,
// immediately before delivery, that the snapshot is STILL the live binding
// — if not, the entry is DROPPED, never redirected to whichever adapter is
// current, and never force-delivered to the stale snapshot either.
describe('F42 (round-9 review): a captured body must never leak to a different adapter', () => {
  function mountAdapterWithKey(apiKey: string) {
    const adapter = createWebPlatformAdapter({ apiKey });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey });
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    adapter.__rebindCrumbHooks();
    return { adapter, client, buf: () => __internalClientState.get(client)!.networkBodies };
  }

  /** Fake XHR whose response only fires when the test calls `respond()` —
   * opens a gap between `send()` (issued under adapter A) and the response
   * actually landing (potentially after A is killed and B is mounted),
   * mirroring a real in-flight network request. */
  class DeferredFakeXHR {
    status = 200;
    readyState = 0;
    responseType: XMLHttpRequestResponseType = '';
    responseText = '';
    private headers: Record<string, string> = {};
    private listeners: Record<string, Array<() => void>> = {};
    open(_m: string, _u: string) {}
    setRequestHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    }
    getResponseHeader(k: string) {
      return this.headers[k.toLowerCase()] ?? null;
    }
    addEventListener(t: string, cb: () => void) {
      (this.listeners[t] ??= []).push(cb);
    }
    removeEventListener() {}
    send(_b?: unknown) {
      /* deferred — respond() drives readyState to 4 later, on demand */
    }
    respond(body: string) {
      this.readyState = 4;
      this.headers['content-type'] = 'application/json';
      this.responseText = body;
      for (const cb of this.listeners['readystatechange'] ?? []) cb();
    }
  }

  it("FETCH: A killed + B mounted while A's response body is still streaming — B stays empty, A stays empty (reviewer repro)", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        if (urlOf(input).includes('a-deferred')) {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const A = mountAdapterWithKey('app-a-key');
    await A.adapter.__initReplay();

    // Headers arrive (the enabled()/generation()/reqId decision runs) while
    // A is still the live adapter — the body stream is still open.
    const res = await fetch('https://api.test/a-deferred');
    expect(res).toBeDefined();

    A.client.kill(); // production teardown path (Provider unmount → client.kill())
    expect(A.buf().size).toBe(0);

    const B = mountAdapterWithKey('app-b-key'); // a DIFFERENT app / api key
    await B.adapter.__initReplay();

    // NOW release A's response body — resolves the background
    // readCappedText().then() and fires bc.sink(entry, gateGeneration).
    // readCappedText's reader loop + the redaction/capping work chained
    // after it cross several `await`/microtask hops before `bc.sink()`
    // finally runs — a plain `flushMicrotasks()` (a handful of
    // `Promise.resolve()` ticks) is not reliably enough to drain all of
    // them, so yield a real macrotask (which only runs once the ENTIRE
    // microtask queue is empty) before the final microtask flush.
    controller!.enqueue(new TextEncoder().encode("A's private response body"));
    controller!.close();
    await new Promise((r) => setTimeout(r, 0));
    await flushMicrotasks();

    expect(B.buf().size).toBe(0); // must NOT have received A's body
    expect(A.buf().size).toBe(0); // A stays permanently dead too
  });

  it("XHR: A killed + B mounted before A's deferred response is released — B stays empty, A stays empty", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        throw new Error('unexpected fetch — this repro only issues XHR app requests');
      }),
    );
    vi.stubGlobal('XMLHttpRequest', DeferredFakeXHR as unknown as typeof XMLHttpRequest);

    const A = mountAdapterWithKey('app-a-key');
    await A.adapter.__initReplay();

    const xhr = new XMLHttpRequest() as unknown as DeferredFakeXHR;
    xhr.open('GET', 'https://api.test/a-xhr-deferred');
    xhr.send(null);

    A.client.kill();
    expect(A.buf().size).toBe(0);

    const B = mountAdapterWithKey('app-b-key'); // a DIFFERENT app / api key
    await B.adapter.__initReplay();

    xhr.respond('{"secret":"A\'s private response"}');
    await flushMicrotasks();

    expect(B.buf().size).toBe(0);
    expect(A.buf().size).toBe(0);
  });

  it("F37 regression guard: after the swap, B's OWN requests still capture normally", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) return configResponse(true);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const A = mountAdapterWithKey('app-a-key');
    await A.adapter.__initReplay();
    A.client.kill();

    const B = mountAdapterWithKey('app-b-key');
    await B.adapter.__initReplay();

    await fetch('https://api.test/b-own-request');
    await flushMicrotasks();

    expect(B.buf().size).toBe(1);
    expect(A.buf().size).toBe(0);
  });

  it('same-adapter happy path: no swap, capture is unaffected', async () => {
    const { adapter, client, buf } = wireClient(async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await adapter.__initReplay();

    await fetch('https://api.test/same-adapter');
    await flushMicrotasks();

    expect(buf().size).toBe(1);
  });
});
