// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  RENDER_FOCUS_ATTR,
  RENDER_FOCUS_WITHIN_ATTR,
  RENDER_META_HEADER,
  RENDER_PATH,
  RENDER_REQUEST_CONTENT_ENCODING,
  RENDER_REQUEST_CONTENT_TYPE,
  RENDER_RESPONSE_CONTENT_TYPE,
  RenderErrorBody,
  RenderErrorCode,
  SCREENSHOT_RENDER_SDK_FEATURE,
  parseRenderMeta,
} from '../src/index.js';

const meta = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    blank: false,
    missingAssets: 2,
    missingAssetUrls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.woff2'],
    fontsSubstituted: true,
    renderMs: 812,
    ...over,
  });

describe('render HTTP contract', () => {
  it('pins the path, headers and media types', () => {
    expect(RENDER_PATH).toBe('/api/render');
    expect(RENDER_META_HEADER).toBe('X-Everframe-Render-Meta');
    expect(RENDER_REQUEST_CONTENT_TYPE).toBe('application/json');
    expect(RENDER_REQUEST_CONTENT_ENCODING).toBe('gzip');
    expect(RENDER_RESPONSE_CONTENT_TYPE).toBe('image/webp');
    expect(SCREENSHOT_RENDER_SDK_FEATURE).toBe('screenshotrender');
  });

  it('pins the focus marker attribute names', () => {
    expect(RENDER_FOCUS_ATTR).toBe('data-everframe-focus');
    expect(RENDER_FOCUS_WITHIN_ATTR).toBe('data-everframe-focus-within');
  });

  it('parses a well-formed meta header', () => {
    expect(parseRenderMeta(meta())).toEqual({
      blank: false,
      missingAssets: 2,
      missingAssetUrls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.woff2'],
      fontsSubstituted: true,
      renderMs: 812,
    });
  });

  it('accepts exactly 10 missing-asset urls of 256 chars', () => {
    const url = `https://x.example/${'a'.repeat(238)}`;
    expect(url.length).toBe(256);
    expect(parseRenderMeta(meta({ missingAssets: 40, missingAssetUrls: Array(10).fill(url) }))).not.toBeNull();
  });

  it.each([
    ['11 urls', { missingAssetUrls: Array(11).fill('https://x.example/a') }],
    ['url over 256 chars', { missingAssetUrls: [`https://x.example/${'a'.repeat(239)}`] }],
    ['non-string url', { missingAssetUrls: [1] }],
    ['missing urls field', { missingAssetUrls: undefined }],
    ['negative count', { missingAssets: -1 }],
  ])('returns null for %s', (_name, over) => {
    expect(parseRenderMeta(meta(over))).toBeNull();
  });

  it.each([null, undefined, '', 'not json', '{"blank":"no"}', '{"blank":false}', 'x'.repeat(2000)])(
    'returns null for %s',
    (header) => {
      expect(parseRenderMeta(header as string | null | undefined)).toBeNull();
    },
  );

  it('enumerates every error code the render path can answer with', () => {
    expect(RenderErrorCode.options).toEqual([
      'render_unavailable',
      'render_failed',
      'render_timeout',
      'invalid_snapshot',
      'rate_limit_exceeded',
      'invalid_sdk_key',
      'org_suspended',
    ]);
    expect(RenderErrorBody.safeParse({ error: 'render_timeout', retryAfter: 3 }).success).toBe(true);
    expect(RenderErrorBody.safeParse({ error: 'teapot' }).success).toBe(false);
  });
});
