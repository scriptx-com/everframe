// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDER_META_HEADER } from '@everframe/protocol';
import { renderSnapshot, webpDimensions } from '../../../src/capture/tv-snapshot/render-client.js';
import { readBlobArrayBuffer } from '../../../src/internal/blob.js';

function riff(chunk: string, data: number[]): Uint8Array {
  const bytes = [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)), [...chunk].map((c) => c.charCodeAt(0)), [data.length, 0, 0, 0], data);
  return new Uint8Array(bytes);
}
const vp8 = (w: number, h: number) => riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f]);
const vp8l = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
};
const vp8x = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, (w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff]);

const GZ = new Uint8Array([0x1f, 0x8b, 8, 0]);
const base = { url: 'https://api.example.test/api/render', sdkKey: 'k', fallbackSize: { width: 2560, height: 1440 } };
const webp = (bytes: Uint8Array, meta?: string) =>
  new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200, headers: { 'content-type': 'image/webp', ...(meta !== undefined ? { [RENDER_META_HEADER]: meta } : {}) } });

afterEach(() => vi.useRealTimers());

describe('webpDimensions', () => {
  it('reads lossy, lossless and extended headers', () => {
    expect(webpDimensions(vp8(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(webpDimensions(vp8l(640, 360))).toEqual({ width: 640, height: 360 });
    expect(webpDimensions(vp8x(3840, 2160))).toEqual({ width: 3840, height: 2160 });
    expect(webpDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('renderSnapshot', () => {
  it('posts the gzip bytes with auth and Content-Encoding, returns the image and meta', async () => {
    const fetchImpl = vi.fn(async () => webp(vp8(1920, 1080), JSON.stringify({ blank: true, missingAssets: 2, missingAssetUrls: ['https://cdn.example.test/a.png'], fontsSubstituted: true, renderMs: 900 })));
    const r = await renderSnapshot(GZ, { ...base, fetchImpl });
    expect(r).toMatchObject({ ok: true, width: 1920, height: 1080, meta: { blank: true, missingAssets: 2, missingAssetUrls: ['https://cdn.example.test/a.png'], fontsSubstituted: true, renderMs: 900 } });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(base.url);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k', 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(new Uint8Array(await readBlobArrayBuffer(init.body as Blob))).toEqual(GZ);
    if (r.ok) expect(r.blob.type).toBe('image/webp');
  });

  it('parses a meta header with an empty missingAssetUrls list', async () => {
    const fetchImpl = vi.fn(async () => webp(vp8(64, 64), JSON.stringify({ blank: false, missingAssets: 0, missingAssetUrls: [], fontsSubstituted: false, renderMs: 5 })));
    const r = await renderSnapshot(GZ, { ...base, fetchImpl });
    expect(r).toMatchObject({ ok: true, meta: { renderMs: 5, missingAssetUrls: [] } });
  });

  it('maps a known error body to its reason, anything else to http_<status>', async () => {
    const known = vi.fn(async () => new Response(JSON.stringify({ error: 'render_unavailable' }), { status: 503 }));
    await expect(renderSnapshot(GZ, { ...base, fetchImpl: known })).resolves.toEqual({ ok: false, reason: 'render_unavailable' });
    const unknown = vi.fn(async () => new Response('oops', { status: 500 }));
    await expect(renderSnapshot(GZ, { ...base, fetchImpl: unknown })).resolves.toEqual({ ok: false, reason: 'http_500' });
  });

  it('treats a non-webp 200, an empty body and a network error as render_failed', async () => {
    const png = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } }));
    await expect(renderSnapshot(GZ, { ...base, fetchImpl: png })).resolves.toEqual({ ok: false, reason: 'render_failed' });
    const empty = vi.fn(async () => webp(new Uint8Array(0)));
    await expect(renderSnapshot(GZ, { ...base, fetchImpl: empty })).resolves.toEqual({ ok: false, reason: 'render_failed' });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(renderSnapshot(GZ, { ...base, fetchImpl: offline })).resolves.toEqual({ ok: false, reason: 'render_failed' });
  });

  it('gives up at the deadline and aborts the request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hang = vi.fn((_u: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); });
    const pending = renderSnapshot(GZ, { ...base, fetchImpl: hang as unknown as typeof fetch, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'render_timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('falls back to the supplied size and default meta when headers are unreadable', async () => {
    const odd = vi.fn(async () => webp(new Uint8Array([9, 9, 9, 9]), 'not json'));
    const r = await renderSnapshot(GZ, { ...base, fetchImpl: odd });
    expect(r).toMatchObject({ ok: true, width: 2560, height: 1440, meta: { blank: false, missingAssets: 0, missingAssetUrls: [], fontsSubstituted: false, renderMs: 0 } });
  });
});
