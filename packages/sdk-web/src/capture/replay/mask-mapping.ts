// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-04 (transport floor) + perf budget — rrweb record-option mapping.
//
// rrweb config is the TRANSPORT FLOOR only (RESEARCH §"Pattern 3"): maskAllInputs,
// mask text by default, block > mask for host-marked-sensitive. The existing
// default-deny + Luhn/JWT scrubber (scrub.ts) gets the LAST word as a
// post-serialization pass. This module owns:
//   - the rr-block / rr-mask class names + a maskTextFn/maskInputFn floor,
//   - the perf budget knobs (checkoutEveryNms = clamp(durationSec/2, 8, 30) * 1000,
//     sampling { mousemove: 50, scroll: 50 }, input 'last', recordCanvas false,
//     inlineStylesheet false, collectFonts false),
//   - mapping the sensitive registry's elements onto rr-block so rrweb itself
//     never serializes their subtree (defense in depth ahead of the scrub).
//
// This module is rrweb-import-free (REPLAY-05): it returns a plain options object
// the lazily-imported `record()` consumes.

/** rrweb class names. `block` removes the subtree entirely; `mask` obfuscates text. */
export const RR_BLOCK_CLASS = 'rr-block';
export const RR_MASK_CLASS = 'rr-mask';

// ⚠ TEMPORARY (2026-06-16): redaction kill-switch for end-to-end replay verification.
// When true, rrweb captures text + input values RAW (no `***`) and the recorder
// skips the post-serialization scrub — so the replay shows the actual page. Flip
// back to `false` to restore the mask-all transport floor + scrub before shipping.
export const REDACTION_DISABLED = true;

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * checkoutEveryNms = clamp(replayDurationSec / 2, 8s, 30s) × 1000.
 * 15s→8s, 30s→15s, 60s→30s (RESEARCH §"Open Item 2").
 */
export function checkoutIntervalMs(durationSec: number): number {
  return clamp(durationSec / 2, 8, 30) * 1000;
}

/** Minimal structural shape of the rrweb record options we produce. */
export interface RrwebRecordOptions {
  emit?: (event: unknown, isCheckout?: boolean) => void;
  checkoutEveryNms: number;
  maskAllInputs: boolean;
  maskTextSelector?: string;
  maskTextClass: string;
  blockClass: string;
  blockSelector?: string;
  recordCanvas: false;
  inlineStylesheet: boolean;
  collectFonts: false;
  sampling: { mousemove: number; scroll: number; input: 'last' };
  maskInputFn?: (text: string) => string;
  maskTextFn?: (text: string) => string;
  errorHandler?: (err: unknown) => void;
}

export interface BuildRecordOptionsDeps {
  durationSec: number;
  emit: (event: unknown, isCheckout?: boolean) => void;
  /** Selector covering host-marked-sensitive elements (data-traceitx-sensitive + .rr-block). */
  blockSelector?: string;
  errorHandler?: (err: unknown) => void;
}

/**
 * The redaction floor placeholder rrweb writes in place of masked text/input.
 * The post-serialization scrub.ts replaces any surviving PII with the SAME
 * affordance so the golden-file always sees a redaction marker, never the value.
 */
export const MASK_PLACEHOLDER = '***';

/**
 * Build the rrweb `record()` options enforcing the transport floor + perf budget.
 * Text is masked by default (maskTextSelector '*' + maskAllInputs), so the
 * full-snapshot/checkout masking gaps (#1385) are belt; scrub.ts is the braces.
 */
export function buildRecordOptions(deps: BuildRecordOptionsDeps): RrwebRecordOptions {
  const opts: RrwebRecordOptions = {
    emit: deps.emit,
    checkoutEveryNms: checkoutIntervalMs(deps.durationSec),
    // TEMP kill-switch: capture inputs raw when redaction is disabled.
    maskAllInputs: !REDACTION_DISABLED,
    maskTextClass: RR_MASK_CLASS,
    blockClass: RR_BLOCK_CLASS,
    recordCanvas: false,
    // Inline stylesheets so the replay renders with the page's real CSS (without
    // this the reconstruction is unstyled — transparent bg, no layout = "black").
    inlineStylesheet: true,
    collectFonts: false,
    sampling: { mousemove: 50, scroll: 50, input: 'last' },
  };
  if (!REDACTION_DISABLED) {
    // Transport floor — mask all text + inputs; the scrub narrows later.
    opts.maskTextSelector = '*';
    opts.maskInputFn = () => MASK_PLACEHOLDER;
    opts.maskTextFn = () => MASK_PLACEHOLDER;
  }
  if (deps.blockSelector !== undefined) opts.blockSelector = deps.blockSelector;
  if (deps.errorHandler !== undefined) opts.errorHandler = deps.errorHandler;
  return opts;
}

/**
 * Map the host's sensitive elements onto the rr-block class so rrweb omits their
 * subtree from the serialized snapshot entirely (block > mask for sensitive).
 * Returns a restore callback that strips the classes again (call in a finally so
 * the live DOM is never left mutated). Mirrors the live-DOM masking pattern the
 * screenshot path uses for the same reason (coordinate-transform-free).
 */
export function applyReplayMaskClasses(elements: Element[]): () => void {
  const touched: Element[] = [];
  for (const el of elements) {
    if (typeof (el as Element).classList?.add !== 'function') continue;
    if (!el.classList.contains(RR_BLOCK_CLASS)) {
      el.classList.add(RR_BLOCK_CLASS);
      touched.push(el);
    }
  }
  return () => {
    for (const el of touched) {
      try {
        el.classList.remove(RR_BLOCK_CLASS);
      } catch {
        /* element may have been removed mid-capture */
      }
    }
  };
}
