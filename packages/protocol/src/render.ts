// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// POST /api/render: smart-TV screenshot render contract.
//   request : gzip JSON `DomSnapshotV1` body, Content-Type application/json,
//             Content-Encoding gzip, Authorization: Bearer <sdk key>
//   200     : image/webp body + X-Everframe-Render-Meta (JSON RenderMeta)
//   non-200 : JSON { error: RenderErrorCode }
import { z } from 'zod';

export const RENDER_PATH = '/api/render';
export const RENDER_META_HEADER = 'X-Everframe-Render-Meta';
export const RENDER_REQUEST_CONTENT_TYPE = 'application/json';
export const RENDER_REQUEST_CONTENT_ENCODING = 'gzip';
export const RENDER_RESPONSE_CONTENT_TYPE = 'image/webp';

/**
 * Capability token an SDK sends in X-Everframe-SDK-Features to receive the
 * `screenshotRender` kill switch on GET /api/config.
 */
export const SCREENSHOT_RENDER_SDK_FEATURE = 'screenshotrender';

/**
 * Attributes the capture side writes on the focused element and its ancestors
 * so the server render can draw the TV focus ring.
 */
export const RENDER_FOCUS_ATTR = 'data-everframe-focus';
export const RENDER_FOCUS_WITHIN_ATTR = 'data-everframe-focus-within';

/** At most this many missing-asset urls are listed in the meta header. */
export const MAX_RENDER_MISSING_ASSET_URLS = 10;
/** Each listed url is origin + path only, truncated to this many characters. */
export const MAX_RENDER_MISSING_ASSET_URL_LENGTH = 256;

export const RenderMeta = z.object({
  /** The server render failed the blank check (see RENDER_BLANK_CHECK). */
  blank: z.boolean(),
  /** Subresources that were blocked, failed, or answered >= 400 (full count). */
  missingAssets: z.number().int().nonnegative(),
  /** A sample of the missing subresources: origin + path only, capped in count and length. */
  missingAssetUrls: z
    .array(z.string().max(MAX_RENDER_MISSING_ASSET_URL_LENGTH))
    .max(MAX_RENDER_MISSING_ASSET_URLS),
  /** The platform's system fonts were not installed; fallbacks were used. */
  fontsSubstituted: z.boolean(),
  renderMs: z.number().nonnegative(),
});
export type RenderMeta = z.infer<typeof RenderMeta>;

export const RenderErrorCode = z.enum([
  'render_unavailable',
  'render_failed',
  'render_timeout',
  'invalid_snapshot',
  'rate_limit_exceeded',
  'invalid_sdk_key',
  'org_suspended',
]);
export type RenderErrorCode = z.infer<typeof RenderErrorCode>;

export const RenderErrorBody = z.object({ error: RenderErrorCode }).passthrough();
export type RenderErrorBody = z.infer<typeof RenderErrorBody>;

/** Parse the meta header; null for anything absent, oversized or malformed. */
export function parseRenderMeta(header: string | null | undefined): RenderMeta | null {
  if (!header || header.length > 4096) return null;
  let json: unknown;
  try {
    json = JSON.parse(header);
  } catch {
    return null;
  }
  const parsed = RenderMeta.safeParse(json);
  return parsed.success ? parsed.data : null;
}
