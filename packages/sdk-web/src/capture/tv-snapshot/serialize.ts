// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// One-off TV DOM snapshot (spec §"Smart-TV web", step 1). Masking is ALWAYS
// ON here — its own option set, deliberately independent of mask-mapping's
// REDACTION_DISABLED kill switch, which only governs replay. Pipeline, all
// synchronous so the page cannot move between serialization and measurement:
//   rrweb-snapshot (blocked sensitive + masked inputs) → prune (live geometry)
//   → scrub (allowlists) → Meta + FullSnapshot + context.
// Prune and scrub are iterative, so page-controlled depth never grows the
// stack there. The protocol's size, node and depth caps are enforced when the
// snapshot is packed for upload.
// LAZY (tv-snapshot chunk) — the only module that imports rrweb-snapshot.
import { cleanupSnapshot, createMirror, snapshot } from 'rrweb-snapshot';
import type { RedactionEngineConfig } from '@everframe/sdk-core';
import { applyReplayMaskClasses, MASK_PLACEHOLDER, RR_BLOCK_CLASS, RR_MASK_CLASS } from '../replay/mask-mapping.js';
import type { RenderContext } from '../shot-capture.js';
import { defaultFragmentsOf, defaultSizeOf, defaultTextRectsOf, pruneSnapshot, type PruneDeps } from './prune.js';
import { collectRetainedIds, scrubSnapshotTree } from './snapshot-scrub.js';
import { pageRedactionConfig, redactUrlPath } from './page-redact.js';
import { sanitizeMetaHref } from './url-sanitize.js';
import { ensureGlobalThis } from '../../internal/global-scope.js';
import { buildSnapshotContext, focusedSnapshotId, viewportEdge, type DomSnapshotDoc } from './context.js';
import type { SnDocument } from './sn-types.js';

/** SDK chrome is blocked at serialization (its inputs never serialize) and removed by the pruner. */
export const SNAPSHOT_BLOCK_SELECTOR = '[data-everframe-skip-capture="true"]';

/** DomSnapshotMetaEvent.href bound. */
const MAX_META_HREF_LENGTH = 2048;

export interface SnapshotDeps {
  win: Window;
  doc: Document;
  sensitiveElements: () => Element[];
  isSensitive: (el: Element) => boolean;
  redaction?: RedactionEngineConfig | undefined;
  now?: () => number;
  measure?: Partial<Pick<PruneDeps, 'rectOf' | 'styleOf' | 'sizeOf' | 'fragmentsOf' | 'textRectsOf'>>;
}

export interface TakenSnapshot {
  doc: DomSnapshotDoc;
  render: RenderContext;
  masked: boolean;
}

/**
 * Meta href: origin + path only (sanitizeMetaHref), path pattern-redacted
 * like every other URL in the snapshot. One too long for the protocol falls
 * back to the origin rather than a cut path.
 */
function metaHref(href: string, redaction: RedactionEngineConfig | undefined): string {
  const clean = sanitizeMetaHref(href);
  if (clean === '') return '';
  const redacted = redactUrlPath(clean, pageRedactionConfig(redaction));
  if (redacted.length <= MAX_META_HREF_LENGTH) return redacted;
  const origin = sanitizeMetaHref(new URL('/', clean).href);
  return origin.length <= MAX_META_HREF_LENGTH ? origin : '';
}

/** Synchronous; throws when the page cannot be serialized (the caller falls back). */
export function takeDomSnapshot(deps: SnapshotDeps): TakenSnapshot {
  // rrweb-snapshot reads bare `globalThis` (Chrome 71+); TVs run Chrome 53.
  ensureGlobalThis();
  const { win, doc } = deps;
  const mirror = createMirror();
  let inputMasked = false;
  let textMasked = false;
  const restore = applyReplayMaskClasses(deps.sensitiveElements());
  let root: SnDocument;
  try {
    const node = snapshot(doc, {
      mirror,
      blockClass: RR_BLOCK_CLASS,
      blockSelector: SNAPSHOT_BLOCK_SELECTOR,
      maskTextClass: RR_MASK_CLASS,
      maskTextSelector: null,
      maskTextFn: (text: string) => {
        textMasked = true;
        return text.replace(/\S/g, '•');
      },
      maskAllInputs: true,
      maskInputFn: (text: string) => {
        if (text.length > 0) inputMasked = true;
        return MASK_PLACEHOLDER;
      },
      inlineStylesheet: true,
      inlineImages: false,
      recordCanvas: false,
      slimDOM: 'all',
      preserveWhiteSpace: true,
    });
    if (node === null || node.type !== 0) throw new Error('snapshot_empty');
    root = node as unknown as SnDocument;
  } finally {
    restore();
    try {
      cleanupSnapshot();
    } catch {
      /* releases rrweb-snapshot's canvas helper; never fatal */
    }
  }

  const viewport = { width: viewportEdge(win.innerWidth), height: viewportEdge(win.innerHeight) };
  const pruned = pruneSnapshot(root, {
    nodeFor: (id) => mirror.getNode(id),
    rectOf: deps.measure?.rectOf ?? ((el) => el.getBoundingClientRect()),
    styleOf:
      deps.measure?.styleOf ??
      ((el) => {
        try {
          return win.getComputedStyle(el);
        } catch {
          return null;
        }
      }),
    sizeOf: deps.measure?.sizeOf ?? defaultSizeOf,
    fragmentsOf: deps.measure?.fragmentsOf ?? defaultFragmentsOf,
    textRectsOf: deps.measure?.textRectsOf ?? defaultTextRectsOf,
    isSensitive: deps.isSensitive,
    viewport,
  });
  // SDK chrome is removed by the pruner without being recorded as hidden, so
  // it is excluded here: a focused reporter button must not name a missing node.
  const focusedId = focusedSnapshotId(
    doc,
    { getId: (n) => ((n as Element).closest?.(SNAPSHOT_BLOCK_SELECTOR) ? -1 : mirror.getId(n)) },
    pruned.hiddenIds,
  );
  // Whether any content was withheld from the DOM (reported; the CSS policy
  // no longer depends on it — see S26 below).
  const masked = pruned.changed || inputMasked || textMasked;
  const baseHref = sanitizeMetaHref(win.location.href);
  scrubSnapshotTree(root, {
    // S26: the allowlist (masked) scrub on EVERY TV snapshot. Withheld content
    // can live on in the stylesheet by many paths (content:, custom
    // properties, title/textarea copies…); switching on detection kept
    // missing one, so the switch is gone.
    masked: true,
    retainedIds: collectRetainedIds(root),
    baseHref,
    redaction: deps.redaction,
  });

  const context = buildSnapshotContext(win, doc, focusedId);
  const timestamp = (deps.now ?? Date.now)();
  const snapshotDoc: DomSnapshotDoc = {
    v: 1,
    events: [
      { type: 4, data: { href: metaHref(win.location.href, deps.redaction), width: viewport.width, height: viewport.height }, timestamp },
      {
        type: 2,
        data: {
          node: root as unknown as DomSnapshotDoc['events'][1]['data']['node'],
          initialOffset: { top: scrollOffset(win.scrollY, win.pageYOffset), left: scrollOffset(win.scrollX, win.pageXOffset) },
        },
        timestamp,
      },
    ],
    context,
  };
  return {
    doc: snapshotDoc,
    masked,
    render: {
      platform: context.platform,
      viewport: context.viewport,
      dpr: context.dpr,
      fontStatus: context.fonts.status,
    },
  };
}

/** scrollX/scrollY, or the legacy pageXOffset/pageYOffset on old engines; 0 when neither is a number. */
function scrollOffset(modern: number | undefined, legacy: number | undefined): number {
  if (typeof modern === 'number' && Number.isFinite(modern)) return modern;
  return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : 0;
}
