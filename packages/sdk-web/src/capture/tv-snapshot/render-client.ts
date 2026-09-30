// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// POST the gzip DomSnapshotV1 to the render API and get a WebP back (spec
// §"Smart-TV web", step 2). Never rejects: every failure is a reason string,
// and the caller ships the snapshot alone flagged screenshot_render_failed.
// Dimensions come from the WebP header — decoding a 1080p image on TV silicon
// just to learn its size would cost hundreds of milliseconds. LAZY chunk only:
// nothing in the eager graph may import this module.
import {
  parseRenderMeta,
  RenderErrorCode,
  RENDER_META_HEADER,
  RENDER_REQUEST_CONTENT_ENCODING,
  RENDER_REQUEST_CONTENT_TYPE,
  RENDER_RESPONSE_CONTENT_TYPE,
  type RenderMeta,
} from '@everframe/protocol';

export const RENDER_TIMEOUT_MS = 10_000;

/** A readable image whose meta header could not be read (e.g. not exposed by CORS) keeps these. */
const DEFAULT_META: RenderMeta = { blank: false, missingAssets: 0, missingAssetUrls: [], fontsSubstituted: false, renderMs: 0 };

export type RenderOutcome =
  | { ok: true; blob: Blob; width: number; height: number; meta: RenderMeta }
  | { ok: false; reason: string };

export interface RenderDeps {
  url: string;
  sdkKey: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  fallbackSize: { width: number; height: number };
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

export function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 25 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 };
  }
  return null;
}

async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const code = RenderErrorCode.safeParse(body.error);
    if (code.success) return code.data;
  } catch {
    /* not JSON */
  }
  return `http_${res.status}`;
}

export async function renderSnapshot(gz: Uint8Array, deps: RenderDeps): Promise<RenderOutcome> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RenderOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve({ ok: false, reason: 'render_timeout' });
    }, deps.timeoutMs ?? RENDER_TIMEOUT_MS);
  });
  const attempt = (async (): Promise<RenderOutcome> => {
    const res = await deps.fetchImpl(deps.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.sdkKey}`,
        'Content-Type': RENDER_REQUEST_CONTENT_TYPE,
        'Content-Encoding': RENDER_REQUEST_CONTENT_ENCODING,
      },
      body: new Blob([gz as BlobPart]),
      credentials: 'omit',
      ...(controller !== null ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return { ok: false, reason: await errorReason(res) };
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== RENDER_RESPONSE_CONTENT_TYPE) return { ok: false, reason: 'render_failed' };
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return { ok: false, reason: 'render_failed' };
    const dims = webpDimensions(new Uint8Array(buf)) ?? deps.fallbackSize;
    return {
      ok: true,
      blob: new Blob([buf], { type: RENDER_RESPONSE_CONTENT_TYPE }),
      width: dims.width,
      height: dims.height,
      meta: parseRenderMeta(res.headers.get(RENDER_META_HEADER)) ?? DEFAULT_META,
    };
  })().catch((): RenderOutcome => ({ ok: false, reason: 'render_failed' }));
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
