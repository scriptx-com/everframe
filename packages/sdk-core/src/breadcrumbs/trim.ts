// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Importance-weighted breadcrumb trim (spec §4). Pure + platform-agnostic:
// the iOS (Swift) and Android (Kotlin) SDKs mirror this exact algorithm and
// these exact constants at their envelope-build step, locked by the shared
// parity fixture packages/protocol/__tests__/fixtures/breadcrumb-trim.v1.json.
//
// Extends the trimLogs philosophy (newest-first budget + collapse marker)
// with importance awareness so a bulky console burst can never evict the
// navigation spine.
//
// COST MODEL (deterministic + mirrorable; NOT JSON.stringify, whose key
// ordering is platform-dependent): all lengths are UTF-16 code units
// (JS .length == Swift utf16.count == Kotlin String.length).
//   cost(crumb)   = ENTRY_OVERHEAD + message.length + dataCost(data)
//   dataCost      : string → length · number|boolean → 8 · null → 4
//                   array  → 2 + Σ(item + 2) · object → 2 + Σ(key.length + value + 2)
//                   absent data → 0
import type { Breadcrumb } from '@traceitx/protocol';

/** Total serialized-cost budget for the shipped chain (spec §4, default 16 KB). */
export const BREADCRUMB_BYTE_BUDGET = 16384;
/** Per-entry console message cap: first 512 + last 512 around a splice marker. */
export const CONSOLE_ENTRY_CAP = 1024;
/** Fixed per-entry cost covering the t/seq/kind/level envelope of a crumb. */
export const ENTRY_OVERHEAD = 64;

const STRUCTURAL_KINDS: ReadonlySet<Breadcrumb['kind']> = new Set([
  'navigation', 'tap', 'lifecycle', 'error', 'custom',
]);

/** Structural kinds are cheap and always-keep-first; console/network are trimmable. */
export function isStructural(kind: Breadcrumb['kind']): boolean {
  return STRUCTURAL_KINDS.has(kind);
}

/**
 * Head+tail middle-splice: over-cap messages keep the first and last cap/2
 * chars around a `…[+N chars]…` marker (spec §4.2). UTF-16-unit slicing.
 *
 * SURROGATE EDGE (documented platform divergence — spec 2026-07-08 ruling):
 * when the UTF-16 cut lands inside a surrogate pair, JS .slice() and Kotlin
 * substring keep the lone surrogate; Swift's String(decoding:as:UTF16.self)
 * substitutes U+FFFD (Swift String cannot hold a lone surrogate). Accepted:
 * each SDK trims only its own crumbs, so the divergence cannot surface in a
 * shipped report — it exists only under a shared-oracle comparison. Pinned
 * by the characterization tests beside each mirror.
 */
export function truncateMiddle(
  message: string,
  cap: number
): { message: string; truncated: boolean } {
  if (message.length <= cap) return { message, truncated: false };
  const half = Math.floor(cap / 2);
  const dropped = message.length - half * 2;
  return {
    message: `${message.slice(0, half)}…[+${dropped} chars]…${message.slice(message.length - half)}`,
    truncated: true,
  };
}

function dataCost(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (value === null || value === undefined) return 4;
  if (Array.isArray(value)) {
    let sum = 2;
    for (const item of value) sum += dataCost(item) + 2;
    return sum;
  }
  if (typeof value === 'object') {
    let sum = 2;
    for (const [k, v] of Object.entries(value)) sum += k.length + dataCost(v) + 2;
    return sum;
  }
  return 4;
}

/** Deterministic cross-platform cost of one crumb (see COST MODEL above). */
export function crumbCost(crumb: Breadcrumb): number {
  return ENTRY_OVERHEAD + crumb.message.length + (crumb.data ? dataCost(crumb.data) : 0);
}

/** A synthetic per-kind trim marker ("+N <kind> hidden")? Spec §1 discriminator. */
export function isTrimMarker(crumb: Breadcrumb): boolean {
  return typeof crumb.data?.['droppedCount'] === 'number';
}

export interface TrimOptions {
  byteBudget?: number;
  consoleEntryCap?: number;
}

/** Error crumbs' data.stackDigest is capped to its first N newline-separated lines (spec §4.2). */
export const STACK_DIGEST_MAX_LINES = 10;

/**
 * Hard entry ceiling for trimmed output: 128 (protocol `payload.breadcrumbs`
 * maxItems in packages/protocol/src/envelope.ts) minus 7 (worst case one trim
 * marker per kind), so trimmed entries + markers can never exceed the protocol
 * ceiling regardless of the byte budget or server-driven buffer `maxCount`.
 */
export const MAX_TRIMMED_ENTRIES = 121;

/**
 * Importance-weighted trim (spec §4):
 *   1. per-entry truncation (console middle-splice; error stackDigest line cap),
 *   2. must-keep = the newest entry of every kind present,
 *   3. while over budget evict the oldest BULKY (console/network) crumb,
 *      then — only when no bulky remain — the oldest structural,
 *   4. after byte eviction, if more than MAX_TRIMMED_ENTRIES entries remain,
 *      keep evicting in the SAME order (oldest bulky first, then oldest
 *      structural, skipping must-keep) until MAX_TRIMMED_ENTRIES remain — so
 *      output + markers never exceed the protocol's 128-entry ceiling,
 *   5. one count marker per kind that lost entries, stamped with the newest
 *      dropped entry's (t, seq) so it sorts just before the kept window
 *      (same convention as TRIMMED_LOGS_MESSAGE in trim-logs.ts).
 * Markers are bounded (≤ one per kind) and excluded from the budget.
 *
 * INPUT INVARIANT: no two crumbs may share the same (t, seq) pair — the
 * capture buffer's monotonic seq guarantees this; determinism (and Swift's
 * non-stable sort in the future mirror) depends on it.
 */
export function trimBreadcrumbs(
  crumbs: readonly Breadcrumb[],
  opts: TrimOptions = {}
): Breadcrumb[] {
  const budget = opts.byteBudget ?? BREADCRUMB_BYTE_BUDGET;
  const consoleCap = opts.consoleEntryCap ?? CONSOLE_ENTRY_CAP;
  if (crumbs.length === 0) return [];

  // 1. Per-entry truncation, then defensive (t, seq) sort for determinism.
  const entries = crumbs
    .map((c) => {
      if (c.kind === 'console') {
        const r = truncateMiddle(c.message, consoleCap);
        return r.truncated ? { ...c, message: r.message, truncated: true } : c;
      }
      if (c.kind === 'error' && typeof c.data?.['stackDigest'] === 'string') {
        const lines = (c.data['stackDigest'] as string).split('\n');
        if (lines.length > STACK_DIGEST_MAX_LINES) {
          return {
            ...c,
            data: { ...c.data, stackDigest: lines.slice(0, STACK_DIGEST_MAX_LINES).join('\n') },
            truncated: true,
          };
        }
      }
      return c;
    })
    .sort((a, b) => a.t - b.t || a.seq - b.seq);

  // 2. Must-keep: the newest entry of every kind present — a kind that fired
  //    is never silently absent from the shipped chain.
  const mustKeep = new Set<Breadcrumb>();
  const seenKinds = new Set<Breadcrumb['kind']>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!seenKinds.has(e.kind)) {
      seenKinds.add(e.kind);
      mustKeep.add(e);
    }
  }

  // 3. Evict until under budget: oldest bulky first, structural last resort.
  //    `entries` is oldest→newest, so each filter pass is already in
  //    eviction order.
  const kept = new Set<Breadcrumb>(entries);
  let total = entries.reduce((sum, e) => sum + crumbCost(e), 0);
  const evictionOrder = [
    ...entries.filter((e) => !isStructural(e.kind)),
    ...entries.filter((e) => isStructural(e.kind)),
  ];
  for (const victim of evictionOrder) {
    if (total <= budget) break;
    if (mustKeep.has(victim)) continue;
    kept.delete(victim);
    total -= crumbCost(victim);
  }

  // 3b. Count enforcement: the protocol caps payload.breadcrumbs at 128, so
  //     trimmed entries must never exceed MAX_TRIMMED_ENTRIES (= 128 − 7
  //     worst-case markers). Walk the SAME eviction order; must-keep is at
  //     most 7 entries (one per kind), so the target is always reachable.
  for (const victim of evictionOrder) {
    if (kept.size <= MAX_TRIMMED_ENTRIES) break;
    if (mustKeep.has(victim)) continue;
    kept.delete(victim);
  }

  // 4. One count marker per kind that lost entries.
  const droppedByKind = new Map<Breadcrumb['kind'], Breadcrumb[]>();
  for (const e of entries) {
    if (kept.has(e)) continue;
    const list = droppedByKind.get(e.kind) ?? [];
    list.push(e); // entries is oldest→newest, so list stays ordered
    droppedByKind.set(e.kind, list);
  }
  const markers: Breadcrumb[] = [];
  for (const [kind, dropped] of droppedByKind) {
    const newestDropped = dropped[dropped.length - 1]!;
    markers.push({
      t: newestDropped.t,
      seq: newestDropped.seq,
      kind,
      level: 'info',
      message: `+${dropped.length} ${kind} hidden`,
      data: { droppedCount: dropped.length },
    });
  }

  return [...entries.filter((e) => kept.has(e)), ...markers].sort(
    (a, b) => a.t - b.t || a.seq - b.seq
  );
}
