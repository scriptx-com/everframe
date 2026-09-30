// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `dom-snapshot` wire format (v1): one rrweb-snapshot serialization of the page
// at report time, plus the context a server render needs. Stored and uploaded
// as gzip JSON. Two consumers:
//   - the render service rebuilds it in headless Chromium and returns a WebP;
//   - admin hands `events` to the rrweb Replayer when no image was rendered.
//
// The node tree itself is opaque here (rrweb-snapshot owns its shape). It is
// bounded by the byte caps below, enforced by whoever decompresses it, and by
// `countDomSnapshotNodes`.
import { z } from 'zod';

export const DOM_SNAPSHOT_VERSION = 1 as const;
export const DOM_SNAPSHOT_PART = 'dom-snapshot' as const;
export const DOM_SNAPSHOT_CONTENT_TYPE = 'application/gzip' as const;

/** Largest gzip body the render endpoint accepts. */
export const MAX_DOM_SNAPSHOT_COMPRESSED_BYTES = 2 * 1024 * 1024;
/** Largest decompressed JSON a consumer may inflate (gzip-bomb bound). */
export const MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES = 10 * 1024 * 1024;
/** Largest node count a consumer will rebuild. A heavy TV page is ~4,100. */
export const MAX_DOM_SNAPSHOT_NODES = 50_000;
/** Largest viewport edge, in CSS pixels, a render will allocate. */
export const MAX_RENDER_VIEWPORT_EDGE = 4096;

export const RenderPlatform = z.enum(['webos', 'tizen', 'other']);
export type RenderPlatform = z.infer<typeof RenderPlatform>;

const Edge = z.number().int().min(1).max(MAX_RENDER_VIEWPORT_EDGE);
export const RenderViewport = z.object({ width: Edge, height: Edge });
export type RenderViewport = z.infer<typeof RenderViewport>;

export const RenderFontStatus = z.enum(['loading', 'loaded']);
export type RenderFontStatus = z.infer<typeof RenderFontStatus>;

export const DomSnapshotMedia = z.object({
  prefersColorScheme: z.enum(['light', 'dark']),
  prefersReducedMotion: z.enum(['no-preference', 'reduce']),
  forcedColors: z.enum(['none', 'active']),
});
export type DomSnapshotMedia = z.infer<typeof DomSnapshotMedia>;

export const DomSnapshotFonts = z.object({
  status: RenderFontStatus,
  loaded: z.array(z.string().max(256)).max(256),
  failed: z.array(z.string().max(256)).max(256),
});
export type DomSnapshotFonts = z.infer<typeof DomSnapshotFonts>;

export const DomSnapshotContext = z.object({
  dpr: z.number().positive().max(8),
  platform: RenderPlatform,
  userAgent: z.string().max(1024),
  fonts: DomSnapshotFonts,
  /** rrweb mirror id of document.activeElement; null when nothing is focused. */
  focusedId: z.number().int().nonnegative().nullable(),
  media: DomSnapshotMedia,
  viewport: RenderViewport,
});
export type DomSnapshotContext = z.infer<typeof DomSnapshotContext>;

/** rrweb EventType.Meta (4). */
export const DomSnapshotMetaEvent = z.object({
  type: z.literal(4),
  timestamp: z.number(),
  data: z.object({
    href: z.string().max(2048),
    width: Edge,
    height: Edge,
  }),
});

/** rrweb EventType.FullSnapshot (2). The root must be a Document (NodeType 0). */
export const DomSnapshotFullSnapshotEvent = z.object({
  type: z.literal(2),
  timestamp: z.number(),
  data: z.object({
    node: z
      .object({ type: z.literal(0), id: z.number().int(), childNodes: z.array(z.unknown()) })
      .passthrough(),
    /** Authoritative root scroll offset (the context carries no separate scroll). */
    initialOffset: z.object({ top: z.number(), left: z.number() }),
  }),
});

export const DomSnapshotV1 = z.object({
  v: z.literal(DOM_SNAPSHOT_VERSION),
  events: z.tuple([DomSnapshotMetaEvent, DomSnapshotFullSnapshotEvent]),
  context: DomSnapshotContext,
});
export type DomSnapshotV1 = z.infer<typeof DomSnapshotV1>;

export type ParseDomSnapshotResult =
  | { ok: true; snapshot: DomSnapshotV1 }
  | { ok: false; error: 'unsupported_version'; version: unknown }
  | { ok: false; error: 'invalid_snapshot'; issues: string[] };

/**
 * Validate a decoded `dom-snapshot` payload. An unknown `v` is reported
 * separately so admin can say "snapshot unavailable" instead of "broken".
 */
export function parseDomSnapshot(json: unknown): ParseDomSnapshotResult {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: 'invalid_snapshot', issues: ['payload is not an object'] };
  }
  if (!('v' in json)) {
    return { ok: false, error: 'invalid_snapshot', issues: ['v: missing'] };
  }
  const version = (json as { v: unknown }).v;
  if (version !== DOM_SNAPSHOT_VERSION) {
    return { ok: false, error: 'unsupported_version', version };
  }
  const parsed = DomSnapshotV1.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_snapshot',
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, snapshot: parsed.data };
}

/**
 * Count serialized nodes, iteratively (no recursion on attacker-shaped depth).
 * Returns early with `limit + 1` once the limit is exceeded.
 */
export function countDomSnapshotNodes(snapshot: DomSnapshotV1, limit: number): number {
  const stack: unknown[] = [snapshot.events[1].data.node];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    if (count > limit) return count;
    const children = (node as { childNodes?: unknown } | null)?.childNodes;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child);
    }
  }
  return count;
}

/** Part name for shot `shotNumber` (1-based): `dom-snapshot`, `dom-snapshot-2`, … */
export function domSnapshotPartName(shotNumber: number): string {
  if (!Number.isInteger(shotNumber) || shotNumber < 1) {
    throw new RangeError(`shot numbers start at 1, got ${shotNumber}`);
  }
  return shotNumber === 1 ? DOM_SNAPSHOT_PART : `${DOM_SNAPSHOT_PART}-${shotNumber}`;
}

/** Inverse of domSnapshotPartName; null for any other part name. */
export function parseDomSnapshotPartName(partName: string): number | null {
  if (partName === DOM_SNAPSHOT_PART) return 1;
  // Shot 1 is the bare name, so the suffix starts at 2 with no leading zeros.
  const match = /^dom-snapshot-([2-9]|[1-9]\d+)$/.exec(partName);
  return match ? Number(match[1]) : null;
}

/**
 * `envelope.captureControl.render` — optional render context for a report whose
 * screenshot came from a server render. Deliberately NOT declared on
 * ReportEnvelope: it rides `captureControl`'s passthrough, so native codegen and
 * older servers are untouched.
 */
export const CaptureControlRender = z.object({
  platform: RenderPlatform,
  viewport: RenderViewport,
  dpr: z.number().positive().max(8),
  fontStatus: RenderFontStatus,
});
export type CaptureControlRender = z.infer<typeof CaptureControlRender>;

export function readCaptureControlRender(envelope: { captureControl?: unknown }): CaptureControlRender | null {
  const cc = envelope.captureControl;
  if (!cc || typeof cc !== 'object') return null;
  const parsed = CaptureControlRender.safeParse((cc as { render?: unknown }).render);
  return parsed.success ? parsed.data : null;
}
