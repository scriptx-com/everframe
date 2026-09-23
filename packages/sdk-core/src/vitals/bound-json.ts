// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Bounds a customer-supplied `trackVitals` payload to the protocol's
// MAX_CUSTOM_DATA_BYTES (spec 2026-09-02 §2). Over the cap we KEEP the entry
// and ship a preview — vitals are lossy but a silently vanishing log line is
// the one thing a customer debugging playback cannot tolerate.
//
// Contract: for EVERY maxBytes >= 0, the returned `data` either re-serialises
// within maxBytes bytes of UTF-8, or is `undefined`. `undefined` is the
// escape hatch for a cap too small to hold even a fixed-shape wrapper (the
// `{ unserializable: true }` marker, or the `{ truncated, preview: '' }`
// shell once even an empty preview doesn't fit) — Task 1's VitalsCustomEntry
// refinement exempts `data: undefined` from the byte check, so dropping the
// payload there can never fail validation downstream. We never throw to
// enforce this: boundJson sits on the SDK's safe path, where a throw would
// surface as a host-visible crash from a customer's own log line.
import { MAX_CUSTOM_DATA_BYTES, utf8ByteLength } from '@everframe/protocol';

export interface BoundedJson {
  data: unknown;
  truncated: boolean;
}

/** Does `data` re-serialise within `maxBytes` bytes of UTF-8? */
function withinCap(data: unknown, maxBytes: number): boolean {
  return utf8ByteLength(JSON.stringify(data)) <= maxBytes;
}

/** The unserializable marker, or `undefined` if even IT doesn't fit `maxBytes`. */
function unserializable(maxBytes: number): BoundedJson {
  const data = { unserializable: true };
  return withinCap(data, maxBytes) ? { data, truncated: true } : { data: undefined, truncated: true };
}

/** Cut `s` to at most `maxBytes` of UTF-8 without splitting a code point. */
function cutUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const b = utf8ByteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    out += ch;
  }
  return out;
}

export function boundJson(value: unknown, maxBytes: number = MAX_CUSTOM_DATA_BYTES): BoundedJson {
  if (value === undefined) return { data: undefined, truncated: false };
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return unserializable(maxBytes);
  }
  if (serialised === undefined) return unserializable(maxBytes); // function / symbol at the top level
  if (utf8ByteLength(serialised) <= maxBytes) {
    // Item 2 (codex round 1) — `value` is the CALLER's own reference. If we
    // hand it straight back, the collector holds that reference until
    // flush, and a customer who mutates it afterwards (growing it past the
    // cap, or making it cyclic) corrupts an entry that already "passed" —
    // at flush time the chunk gets dropped, or worse, an entry stamped into
    // a report envelope makes the WHOLE bug report get rejected. We just
    // proved `serialised` is valid JSON for this exact value, so parsing it
    // back is the cheapest correct deep copy — no reference to `value`
    // survives this call.
    return { data: JSON.parse(serialised), truncated: false };
  }

  // The preview is a JSON string INSIDE a wrapper object; quotes and control
  // characters in it get escaped again on re-serialisation, so measure the
  // wrapped result and halve the preview budget until it fits.
  let budget = Math.floor(maxBytes / 2);
  while (budget > 0) {
    const data = { truncated: true, preview: cutUtf8(serialised, budget) };
    if (withinCap(data, maxBytes)) return { data, truncated: true };
    budget = budget >> 1;
  }
  // Even an EMPTY preview's fixed wrapper overhead doesn't fit maxBytes
  // (very small caps). Dropping the payload — not shipping a shell that
  // itself violates the cap — is what keeps the size guarantee
  // unconditional; see the module doc-comment.
  const emptyShell = { truncated: true, preview: '' };
  return withinCap(emptyShell, maxBytes)
    ? { data: emptyShell, truncated: true }
    : { data: undefined, truncated: true };
}

export interface BoundedStructuredJson {
  data: Record<string, unknown> | undefined;
  truncated: boolean;
}

/** `true` for a value `JSON.stringify` renders as itself, with no growth from shrinking possible — the ONLY kinds `boundStructuredRecord` keeps verbatim regardless of size. */
function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * A nested (non-scalar, non-string) field is kept only when it is cheap on
 * its own — this function's job is to protect the report path from a
 * pathological FIELD, not to losslessly repack an arbitrarily deep
 * structure the way a full JSON diff/patch tool would. 256 bytes
 * comfortably covers the documented player-event payload shapes that carry
 * a nested value at all (`source_change`'s `{ src, protocol, mime?,
 * live? }` is itself flat; nothing in the spec nests deeper), while still
 * refusing to let a customer integration's arbitrarily large nested object
 * ride through untouched.
 */
const MAX_NESTED_FIELD_BYTES = 256;

/** Exact UTF-8 byte cost of `"key":value` as it appears inside a `JSON.stringify`d object — no other field's presence changes this. */
function fieldFragmentBytes(key: string, value: unknown): number {
  return utf8ByteLength(JSON.stringify(key) + ':' + JSON.stringify(value));
}

/**
 * Shrinks `raw` so that `"key":"<shrunk>"` fits within `fragBudget` bytes —
 * the SAME halving-until-it-fits technique `boundJson` already uses for its
 * own preview string (module doc above: measure the wrapped result, halve
 * the raw budget on failure), just scoped to one field's fragment instead of
 * a whole wrapper object. Escaping (quotes, backslashes, control chars) can
 * make a truncated string's JSON encoding cost MORE bytes than its raw UTF-8
 * length, so a single raw-byte estimate can't be trusted without
 * re-measuring — this loop is what makes the result exact regardless. Cost
 * is O(log(fragBudget)) field-local operations, independent of how many
 * OTHER fields exist — this is what keeps `boundStructuredJson` from
 * degrading to per-field-count quadratic work when many fields need
 * shrinking. `undefined` if even an empty value doesn't fit.
 */
function truncateFieldToFit(key: string, raw: string, fragBudget: number): string | undefined {
  if (fragBudget < 0) return undefined;
  let rawBudget = Math.floor(fragBudget / 2);
  while (rawBudget > 0) {
    const candidate = cutUtf8(raw, rawBudget);
    if (fieldFragmentBytes(key, candidate) <= fragBudget) return candidate;
    rawBudget = rawBudget >> 1;
  }
  return fieldFragmentBytes(key, '') <= fragBudget ? '' : undefined;
}

/**
 * Codex round-5 item 3 — the structure-preserving counterpart to
 * `boundJson`, for a payload the caller has already promised is a flat-ish
 * RECORD (player-event `data` — spec 2026-09-02 §1's `error { message,
 * code?, fatal?, detail? }` and friends). `boundJson`'s collapse-to-preview
 * behaviour is right for an opaque, arbitrary-shape `trackVitals` payload,
 * but wrong here: it replaced the WHOLE object with `{ truncated, preview }`,
 * losing scalar fields (`code`, `fatal`) an operator needs even when the
 * free-text fields (`message`, `detail`) had to be cut.
 *
 * Every scalar field (string excluded — see below) survives verbatim,
 * regardless of size, for as long as the object still needs shrinking at
 * all — an operator triaging a decode error needs to know it was FATAL even
 * if the message describing it got cut. A nested (object/array) field is
 * kept only if it's cheap on its own (`MAX_NESTED_FIELD_BYTES`); this
 * function does not attempt to recursively bound one.
 *
 * Codex round-6 item 2 — round 5's string handling shrank the LARGEST
 * remaining string by half, rebuilt `{...kept, ...strings}`, and
 * re-serialised the WHOLE object to check whether it fit — repeated, then
 * repeated AGAIN in a second loop that dropped fields outright once
 * shrinking bottomed out. Both loops rescanned every remaining string field
 * to find "the largest" on every iteration: quadratic in the field count.
 * 1,000 small string fields (that never fully fit no matter how they're
 * individually shrunk) drove the drop-loop through nearly 1,000 iterations,
 * each doing a full object rebuild + re-serialise: ~716ms measured, ~1.5s
 * at 2,000 fields, synchronously blocking the host page (`safeWrap` cannot
 * interrupt CPU-bound work).
 *
 * Fixed as a SINGLE pass: sort the string fields once by their full
 * (untouched) fragment size (`O(n log n)`), then walk that sorted list ONCE
 * with a running prefix sum, no rescanning. Every field whose full size
 * still fits the remaining budget is kept byte-for-byte, smallest first;
 * the first field that doesn't fit whole gets ONE truncation attempt
 * (`truncateFieldToFit`, itself `O(log budget)` and independent of field
 * count) using whatever budget is left over; every field after it is
 * strictly larger and is dropped outright, in one shot, with no per-field
 * search. The whole decision — kept, truncated boundary field, or dropped —
 * is made from numbers computed in the single pass; the candidate object is
 * built once and measured once (`withinCap`), not looped-and-reserialised.
 * `kept`'s own fragment cost is summed once up front the same way. The
 * comma/field-count budget assumes every string field survives, which can
 * only under-count the true budget once fields are dropped (fewer commas
 * than assumed) — so the real result never exceeds `maxBytes`; the
 * `withinCap` check below is a cheap (O(1) extra) verification, not a retry
 * loop.
 *
 * Same never-throw discipline as `boundJson`: this sits on the SDK's safe
 * telemetry path.
 */
export function boundStructuredJson(
  value: Record<string, unknown> | undefined,
  maxBytes: number,
): BoundedStructuredJson {
  if (value === undefined) return { data: undefined, truncated: false };

  let whole: string | undefined;
  try {
    whole = JSON.stringify(value);
  } catch {
    whole = undefined;
  }
  if (whole !== undefined && utf8ByteLength(whole) <= maxBytes) {
    // Defensive copy — same reasoning as `boundJson`'s own under-cap path:
    // no reference to the caller's `value` survives this call.
    return { data: JSON.parse(whole) as Record<string, unknown>, truncated: false };
  }

  // Oversized (or unserialisable — a BigInt/circular value in some field):
  // split field-by-field, ONCE. `kept` holds every scalar plus every
  // cheap-enough nested field, verbatim; `strings` holds the shrink/drop
  // candidates, each measured once up front.
  const kept: Record<string, unknown> = {};
  const strings: Array<{ key: string; raw: string; fragBytes: number }> = [];
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      strings.push({ key: k, raw: v, fragBytes: fieldFragmentBytes(k, v) });
    } else if (isScalar(v)) {
      kept[k] = v;
    } else {
      let fieldJson: string | undefined;
      try {
        fieldJson = JSON.stringify(v);
      } catch {
        fieldJson = undefined;
      }
      if (fieldJson !== undefined && utf8ByteLength(fieldJson) <= MAX_NESTED_FIELD_BYTES) {
        kept[k] = JSON.parse(fieldJson);
      }
      // else: dropped — too expensive to keep and not a string this
      // function knows how to shrink.
    }
  }

  // Smallest-first: a running prefix sum tells us, in one pass, exactly how
  // many of the smallest fields fit verbatim before the budget runs out.
  strings.sort((a, b) => a.fragBytes - b.fragBytes);
  const n = strings.length;
  const prefix: number[] = new Array(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + strings[i]!.fragBytes;

  let keptFragBytes = 0;
  for (const [k, v] of Object.entries(kept)) keptFragBytes += fieldFragmentBytes(k, v);
  // Assumes every string field survives — an upper bound on real comma
  // count once some are dropped below, never an under-count. See doc above.
  const assumedFieldCount = Object.keys(kept).length + n;
  const commaBytes = assumedFieldCount > 0 ? assumedFieldCount - 1 : 0;
  const budgetForStrings = maxBytes - 2 /* braces */ - commaBytes - keptFragBytes;

  let k = 0;
  while (k < n && prefix[k + 1]! <= budgetForStrings) k++;

  const finalStrings: Record<string, string> = {};
  for (let i = 0; i < k; i++) finalStrings[strings[i]!.key] = strings[i]!.raw;

  // The next-smallest field that didn't fit whole gets ONE shrink attempt
  // with the leftover budget; everything after it is strictly larger and is
  // dropped outright — no per-field search, no rescanning.
  if (k < n) {
    const leftover = budgetForStrings - prefix[k]!;
    const truncated = truncateFieldToFit(strings[k]!.key, strings[k]!.raw, leftover);
    if (truncated !== undefined) finalStrings[strings[k]!.key] = truncated;
  }

  const candidate: Record<string, unknown> = { ...kept, ...finalStrings };
  if (withinCap(candidate, maxBytes)) return { data: candidate, truncated: true };

  // Defensive-only fallback (see doc above — the math guarantees `candidate`
  // already fits): drop the boundary field, then fall back to `kept` alone,
  // then to dropping the payload entirely. Fixed-size steps, never
  // proportional to field count.
  if (k < n) {
    delete finalStrings[strings[k]!.key];
    const withoutBoundary: Record<string, unknown> = { ...kept, ...finalStrings };
    if (withinCap(withoutBoundary, maxBytes)) return { data: withoutBoundary, truncated: true };
  }
  if (withinCap(kept, maxBytes)) return { data: kept, truncated: true };
  return { data: undefined, truncated: true };
}
