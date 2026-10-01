// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DomSnapshotV1.context (spec §Protocol and ingest): what the server render
// and the admin display need to reproduce the TV's screen — fonts, focus
// (the TV selection highlight IS :focus), media features (a dark TV page must
// not render light), viewport, dpr, platform. The root scroll offset is NOT
// here: it travels only as the FullSnapshot's `initialOffset`. Every value is
// clamped to the protocol's bounds so the server never rejects a snapshot for
// an odd window. LAZY (tv-snapshot chunk).
import { MAX_RENDER_VIEWPORT_EDGE, type DomSnapshotContext, type DomSnapshotV1 } from '@everframe/protocol';

export type DomSnapshotDoc = DomSnapshotV1;
export type { DomSnapshotContext };

const MAX_FONT_NAMES = 32;
const MAX_FONT_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 1024;
/** DomSnapshotContext.dpr bound. */
const MAX_DPR = 8;
/** Shadow roots descended to find the focused element. */
const MAX_SHADOW_DEPTH = 32;

export function tvPlatformFamily(ua: string): 'webos' | 'tizen' | 'other' {
  // Length cap before any regex (S18); the markers sit early in real UAs.
  const head = ua.slice(0, MAX_USER_AGENT_LENGTH);
  if (/Web0S|webOS|WebAppManager/i.test(head)) return 'webos';
  if (/Tizen/i.test(head)) return 'tizen';
  return 'other';
}

/**
 * Mirror id of the focused element, or null when nothing is focused or the
 * element is not in the snapshot as itself (pruned, blocked, masked).
 */
export function focusedSnapshotId(
  doc: Document,
  mirror: { getId(n: Node): number },
  hiddenIds: ReadonlySet<number>,
): number | null {
  let active: Element | null = doc.activeElement;
  for (let depth = 0; depth < MAX_SHADOW_DEPTH && active?.shadowRoot?.activeElement; depth++) {
    active = active.shadowRoot.activeElement;
  }
  if (active === null || active === doc.body || active === doc.documentElement) return null;
  const id = mirror.getId(active);
  return id > 0 && !hiddenIds.has(id) ? id : null;
}

function query(win: Window, media: string): boolean {
  try {
    return typeof win.matchMedia === 'function' && win.matchMedia(media).matches === true;
  } catch {
    return false;
  }
}

/** A family name without its surrounding quotes. Linear: no regex over page text. */
function familyName(raw: string): string {
  let name = raw.slice(0, MAX_FONT_NAME_LENGTH + 2);
  if (name.startsWith('"') || name.startsWith("'")) name = name.slice(1);
  if (name.endsWith('"') || name.endsWith("'")) name = name.slice(0, -1);
  return name.slice(0, MAX_FONT_NAME_LENGTH);
}

function fontSummary(doc: Document): DomSnapshotContext['fonts'] {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts === undefined || fonts === null || typeof fonts.forEach !== 'function') {
    return { status: 'loaded', loaded: [], failed: [] };
  }
  const loaded = new Set<string>();
  const failed = new Set<string>();
  try {
    fonts.forEach((face) => {
      if (face.status === 'loaded' && loaded.size < MAX_FONT_NAMES) loaded.add(familyName(String(face.family)));
      if (face.status === 'error' && failed.size < MAX_FONT_NAMES) failed.add(familyName(String(face.family)));
    });
  } catch {
    /* a broken FontFaceSet only costs the font list */
  }
  return { status: fonts.status === 'loading' ? 'loading' : 'loaded', loaded: [...loaded], failed: [...failed] };
}

/** A viewport edge as the protocol accepts it: an integer in 1..MAX_RENDER_VIEWPORT_EDGE. */
export function viewportEdge(value: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(MAX_RENDER_VIEWPORT_EDGE, Math.max(1, n));
}

function devicePixelRatio(win: Window): number {
  const dpr = win.devicePixelRatio;
  return typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? Math.min(MAX_DPR, dpr) : 1;
}

export function buildSnapshotContext(win: Window, doc: Document, focusedId: number | null): DomSnapshotContext {
  const userAgent = String(win.navigator.userAgent).slice(0, MAX_USER_AGENT_LENGTH);
  return {
    dpr: devicePixelRatio(win),
    platform: tvPlatformFamily(userAgent),
    userAgent,
    fonts: fontSummary(doc),
    focusedId,
    media: {
      prefersColorScheme: query(win, '(prefers-color-scheme: dark)') ? 'dark' : 'light',
      prefersReducedMotion: query(win, '(prefers-reduced-motion: reduce)') ? 'reduce' : 'no-preference',
      forcedColors: query(win, '(forced-colors: active)') ? 'active' : 'none',
    },
    viewport: { width: viewportEdge(win.innerWidth), height: viewportEdge(win.innerHeight) },
  };
}
