// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installXHRPatcher, type BodyCaptureHooks } from '../../src/capture/network.js';
import * as networkBodyModule from '../../src/capture/network-body.js';
import type { NetworkBodyEntry } from '@traceitx/protocol';

// See network-body-fetch.spec.ts's `bigBody` for why this isn't one giant
// unbroken run of word characters (avoids quadratic backtracking in the
// pre-existing, unrelated JWT_INLINE regex on a multi-megabyte homogeneous run).
function bigBody(byteLen: number): string {
  return 'x '.repeat(Math.ceil(byteLen / 2));
}

// Minimal fake XHR that drives readystatechange to 4 with a text response.
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 200;
  readyState = 0;
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  private headers: Record<string, string> = {};
  private listeners: Record<string, Array<() => void>> = {};
  constructor() { FakeXHR.instances.push(this); }
  open(_m: string, _u: string) {}
  setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  getResponseHeader(k: string) { return this.headers[k.toLowerCase()] ?? null; }
  addEventListener(t: string, cb: () => void) { (this.listeners[t] ??= []).push(cb); }
  removeEventListener() {}
  send(_b?: unknown) {
    this.readyState = 4;
    this.headers['content-type'] = 'application/json';
    this.responseText = JSON.stringify({ card: '4242 4242 4242 4242' });
    for (const cb of this.listeners['readystatechange'] ?? []) cb();
  }
}

function hooks(): { h: BodyCaptureHooks; sunk: NetworkBodyEntry[] } {
  const sunk: NetworkBodyEntry[] = [];
  let id = 0;
  return {
    sunk,
    h: {
      enabled: () => true,
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json', 'text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    },
  };
}

describe('xhr body capture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('captures + redacts the responseText and the string request body', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const { h, sunk } = hooks();
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/x');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('{"q":1}');
    expect(sunk).toHaveLength(1);
    expect(sunk[0].resBody).toContain('[REDACTED:CC]');
    expect(sunk[0].reqBody).toBe('{"q":1}');
    uninstall();
  });

  it('F19 audit: XHR response redacts a boundary-straddling secret before capping (bodyField redacts-then-caps the full responseText)', () => {
    // Standalone fake (not a FakeXHR subclass) so it can freely set its own
    // response content-type/text without reaching into FakeXHR's private fields.
    class SecretXHR {
      static instances: SecretXHR[] = [];
      status = 200;
      readyState = 0;
      responseType: XMLHttpRequestResponseType = '';
      responseText = '';
      headers: Record<string, string> = {};
      listeners: Record<string, Array<() => void>> = {};
      constructor() { SecretXHR.instances.push(this); }
      open(_m: string, _u: string) {}
      setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
      getResponseHeader(k: string) { return this.headers[k.toLowerCase()] ?? null; }
      addEventListener(t: string, cb: () => void) { (this.listeners[t] ??= []).push(cb); }
      removeEventListener() {}
      send(_b?: unknown) {
        this.readyState = 4;
        this.headers['content-type'] = 'text/plain';
        this.responseText = 'aaaa:4242424242424242';
        for (const cb of this.listeners['readystatechange'] ?? []) cb();
      }
    }
    vi.stubGlobal('XMLHttpRequest', SecretXHR as unknown as typeof XMLHttpRequest);
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: 13, bodyContentTypes: ['text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.test/secret');
    xhr.send();
    expect(sunk[0].resBody).not.toMatch(/\d{6,}/);
    expect(sunk[0].resBody).toContain('[REDACT');
    uninstall();
  });

  it('F19 audit: XHR request body redacts a boundary-straddling secret before capping', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: 13, bodyContentTypes: ['application/json', 'text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/secret');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('aaaa:4242424242424242');
    expect(sunk[0].reqBody).not.toMatch(/\d{6,}/);
    expect(sunk[0].reqBody).toContain('[REDACT');
    uninstall();
  });

  it('does not read a non-text responseType', () => {
    class BlobXHR extends FakeXHR { override responseType: XMLHttpRequestResponseType = 'blob'; }
    vi.stubGlobal('XMLHttpRequest', BlobXHR as unknown as typeof XMLHttpRequest);
    const { h, sunk } = hooks();
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.test/x');
    xhr.send();
    expect(sunk[0].resBody).toBeUndefined();
    expect(sunk[0].resBodySkipped).toBe('content-type'); // no readable text ⇒ treated as skip
    uninstall();
  });

  // ==================== F29 (round-6 review): bound the inspected prefix on
  // the XHR request AND response directions, not just the streamed fetch
  // response path ====================

  it('F29: a multi-megabyte XHR REQUEST body only hands redaction a bounded window, not the full body', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const redactSpy = vi.spyOn(networkBodyModule, 'redactBodyText');
    const byteCap = 8192;
    const windowCap = byteCap + 4096; // SECRET_SCAN_OVERLAP
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['application/json', 'text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/huge');
    xhr.setRequestHeader('Content-Type', 'application/json');
    const hugeBody = bigBody(5_000_000); // ~5 MB request body
    xhr.send(hugeBody);

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

  it('F29: a multi-megabyte XHR RESPONSE body (responseText) only hands redaction a bounded window, not the full body', () => {
    class HugeResponseXHR {
      status = 200;
      readyState = 0;
      responseType: XMLHttpRequestResponseType = '';
      responseText = bigBody(5_000_000); // ~5 MB response body
      headers: Record<string, string> = {};
      listeners: Record<string, Array<() => void>> = {};
      open(_m: string, _u: string) {}
      setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
      getResponseHeader(k: string) { return this.headers[k.toLowerCase()] ?? null; }
      addEventListener(t: string, cb: () => void) { (this.listeners[t] ??= []).push(cb); }
      removeEventListener() {}
      send(_b?: unknown) {
        this.readyState = 4;
        this.headers['content-type'] = 'text/plain';
        for (const cb of this.listeners['readystatechange'] ?? []) cb();
      }
    }
    vi.stubGlobal('XMLHttpRequest', HugeResponseXHR as unknown as typeof XMLHttpRequest);
    const redactSpy = vi.spyOn(networkBodyModule, 'redactBodyText');
    const byteCap = 8192;
    const windowCap = byteCap + 4096;
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.test/huge');
    xhr.send();

    expect(redactSpy).toHaveBeenCalled();
    const seenLengths = redactSpy.mock.calls.map(([input]) => input.length);
    expect(Math.max(...seenLengths)).toBeLessThanOrEqual(windowCap);
    expect(sunk[0].resBodyTruncated).toBe(true);
    uninstall();
  });

  // ==================== F30 (round-6 review): <dir>BodyBytes reports the
  // ORIGINAL byte length, not the post-redaction one ====================

  it('F30: reqBodyBytes and resBodyBytes report the ORIGINAL byte length, not the redacted (shorter) length', () => {
    // Reviewer probe: raw 'aaaa:4242424242424242' is 21 bytes; redaction
    // replaces the card number with the 13-byte marker '[REDACTED:CC]',
    // shrinking the string to 18 bytes. Parity case for BOTH XHR directions
    // in one round trip.
    class SecretXHR {
      status = 200;
      readyState = 0;
      responseType: XMLHttpRequestResponseType = '';
      responseText = 'aaaa:4242424242424242';
      headers: Record<string, string> = {};
      listeners: Record<string, Array<() => void>> = {};
      open(_m: string, _u: string) {}
      setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
      getResponseHeader(k: string) { return this.headers[k.toLowerCase()] ?? null; }
      addEventListener(t: string, cb: () => void) { (this.listeners[t] ??= []).push(cb); }
      removeEventListener() {}
      send(_b?: unknown) {
        this.readyState = 4;
        this.headers['content-type'] = 'text/plain';
        for (const cb of this.listeners['readystatechange'] ?? []) cb();
      }
    }
    vi.stubGlobal('XMLHttpRequest', SecretXHR as unknown as typeof XMLHttpRequest);
    const body = 'aaaa:4242424242424242';
    expect(new TextEncoder().encode(body).length).toBe(21); // sanity on the raw size
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const byteCap = 13;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: byteCap, bodyContentTypes: ['text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/secret');
    xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.send(body);

    expect(sunk[0].reqBodyTruncated).toBe(true);
    expect(sunk[0].reqBody).toContain('[REDACT');
    expect(sunk[0].reqBodyBytes).toBe(21); // ORIGINAL size, not the 18-byte redacted size

    expect(sunk[0].resBodyTruncated).toBe(true);
    expect(sunk[0].resBody).toContain('[REDACT');
    expect(sunk[0].resBodyBytes).toBe(21);
    uninstall();
  });

  // ==================== F33 (round-7 review): the XHR REQUEST path bypassed
  // the `bodyContentTypes` allowlist entirely — every string passed to
  // `xhr.send()` was captured unconditionally because the patcher never
  // retained the request's Content-Type (set via `setRequestHeader`, not
  // observable post-hoc). Fixed by patching `setRequestHeader` to record the
  // content-type on the instance, then running it through the SAME
  // `contentTypeAllowed` allowlist check the fetch request path uses, with a
  // default-deny when no Content-Type was ever set. ====================

  it('F33: reviewer repro — explicit octet-stream Content-Type not in the allowlist skips reqBody entirely, no plaintext leaks', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/login');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send('password=secret');

    expect(sunk[0].reqBody).toBeUndefined();
    expect(sunk[0].reqBodySkipped).toBe('content-type');
    // Plaintext must appear nowhere in the sunk entry (not just not on reqBody).
    expect(JSON.stringify(sunk[0])).not.toContain('secret');
    uninstall();
  });

  it('F33: explicit Content-Type matching the allowlist still captures the body (no over-gating)', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/login');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('{"q":1}');

    expect(sunk[0].reqBodySkipped).toBeUndefined();
    expect(sunk[0].reqBody).toBe('{"q":1}');
    uninstall();
  });

  it('F33: no explicit Content-Type ⇒ default-deny (the browser default is not observable, so absence must NOT be treated as allowed)', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const sunk: NetworkBodyEntry[] = [];
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      // Allowlist even includes a wildcard that WOULD have matched the
      // browser's real default ('text/plain;charset=UTF-8' for a string
      // send) — proving the skip is driven by "we don't know", not by the
      // allowlist itself rejecting a known type.
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    };
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/no-header');
    xhr.send('password=secret');

    expect(sunk[0].reqBody).toBeUndefined();
    expect(sunk[0].reqBodySkipped).toBe('content-type');
    expect(JSON.stringify(sunk[0])).not.toContain('secret');
    uninstall();
  });

  it('F33: setRequestHeader still forwards to the underlying XHR (transparent passthrough)', () => {
    const setHeaderCalls: Array<[string, string]> = [];
    class SpyXHR extends FakeXHR {
      override setRequestHeader(k: string, v: string) {
        setHeaderCalls.push([k, v]);
        super.setRequestHeader(k, v);
      }
    }
    vi.stubGlobal('XMLHttpRequest', SpyXHR as unknown as typeof XMLHttpRequest);
    const { h, sunk } = hooks();
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/x');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Custom', 'value');
    xhr.send('{"q":1}');

    // Every call reached the real XHR unmodified, in order.
    expect(setHeaderCalls).toContainEqual(['Content-Type', 'application/json']);
    expect(setHeaderCalls).toContainEqual(['X-Custom', 'value']);
    // And the app's own request still completed and was captured normally.
    expect(sunk).toHaveLength(1);
    expect(sunk[0].reqBody).toBe('{"q":1}');
    uninstall();
  });

  it('F33: a non-string/odd header name cannot throw out of our bookkeeping and the underlying call still happens', () => {
    // A dedicated fake whose setRequestHeader is intentionally permissive
    // (mirrors real WebIDL DOMString coercion — a browser never throws for a
    // non-string name/value) so this test isolates OUR patch's own
    // bookkeeping robustness, not this test double's strictness.
    const setHeaderCalls: Array<[unknown, unknown]> = [];
    class OddXHR extends FakeXHR {
      override setRequestHeader(k: unknown, v: unknown) {
        setHeaderCalls.push([k, v]);
      }
    }
    vi.stubGlobal('XMLHttpRequest', OddXHR as unknown as typeof XMLHttpRequest);
    const { h, sunk } = hooks();
    const uninstall = installXHRPatcher({ bodyCapture: h });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.test/x');
    // A non-string header name — our own content-type-tracking bookkeeping
    // must not throw trying to inspect it, and the call must still reach the
    // underlying XHR unmodified.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (xhr as any).setRequestHeader(null, 'x-weird')).not.toThrow();
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('{"q":1}');

    expect(setHeaderCalls).toContainEqual([null, 'x-weird']);
    expect(setHeaderCalls).toContainEqual(['Content-Type', 'application/json']);
    // The app's own request still completed and was captured normally.
    expect(sunk).toHaveLength(1);
    expect(sunk[0].reqBody).toBe('{"q":1}');
    uninstall();
  });
});
