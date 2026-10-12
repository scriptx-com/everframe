// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-04 (transport floor) + perf budget — rrweb record-option mapping.
//
// Spec 2026-10-11, "Web masking" (matches mobile): rrweb masks every form input
// value (maskAllInputs) and blocks host-marked-sensitive elements (rr-block
// class + [data-everframe-sensitive] selector); ordinary text is NOT masked so
// the replay is watchable. The post-serialization scrub (scrub.ts) gets the
// LAST word: it removes pattern PII everywhere and re-enforces input masking.
// This module owns:
//   - the rr-block / rr-mask class names + the maskInputFn/maskTextFn placeholder,
//   - the perf budget knobs (checkoutEveryNms = clamp(durationSec/2, 8, 30) * 1000,
//     sampling { mousemove: 50, scroll: 50 }, input 'last', recordCanvas false,
//     inlineStylesheet true, collectFonts false).
//
// This module is rrweb-import-free (REPLAY-05): it returns a plain options object
// the lazily-imported `record()` consumes.

/** rrweb class names. `block` removes the subtree entirely; `mask` obfuscates text. */
export const RR_BLOCK_CLASS = 'rr-block';
export const RR_MASK_CLASS = 'rr-mask';

// Redaction switch. It was a temporary kill switch (2026-06-16) for end-to-end
// replay verification; masking is ON since spec 2026-10-11. `true` records text
// and input values raw and skips the scrub. Never ship `true`:
// mask-zero-leak.spec.ts pins `false`.
export const REDACTION_DISABLED = false;

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
  /** Selector covering host-marked-sensitive elements (data-everframe-sensitive + .rr-block). */
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
 * Build the rrweb `record()` options enforcing the masking floor + perf budget.
 * Inputs are always masked to the placeholder (no length leak). Text is masked
 * only inside a host `rr-mask` element: rrweb calls `maskTextFn` only for text
 * that matches `maskTextClass`/`maskTextSelector`, and no selector is set, so
 * ordinary page text stays readable. Pattern PII in that text is the scrub's job.
 */
export function buildRecordOptions(deps: BuildRecordOptionsDeps): RrwebRecordOptions {
  const opts: RrwebRecordOptions = {
    emit: deps.emit,
    checkoutEveryNms: checkoutIntervalMs(deps.durationSec),
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
