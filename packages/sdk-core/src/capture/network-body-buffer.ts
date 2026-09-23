// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

// Dedicated network-body ring buffer (spec 2026-07-18 §7). Holds already-
// redacted NetworkBodyEntry items with a byte budget over summed body text;
// oldest entry (by insertion) is shed on overflow. SEPARATE from the crumb
// buffer so it never perturbs the parity-locked crumb trim. Mirrors the
// breadcrumb buffer's freeze/takeFrozen/discardAndResume/clear lifecycle so
// bodies snapshot at reporter-open in lockstep with the frozen crumb chain.
import type { NetworkBodyEntry } from '@everframe/protocol';

/** Default summed-body-bytes budget (spec §4.1 `bodyTotalBudget`). */
export const DEFAULT_BODY_TOTAL_BUDGET = 262144;

export interface NetworkBodyBufferDeps {
  byteBudget?: number;
}

export interface NetworkBodyBuffer {
  /**
   * F34 (round-7 review) — `guard`, when supplied, is evaluated
   * synchronously, immediately before the insert (JS has no lock to hold,
   * but this is the same "re-check atomically at the sink boundary"
   * discipline round-4's F15 and round-6's F26 established on the native
   * SDKs). The web adapter passes a closure capturing the gate generation
   * observed at DECISION time (before the async body read/redaction work in
   * `network.ts`'s fetch patcher), so a remote `captureBodies: false` config
   * refresh landing between that decision and this `add()` call is caught
   * here even though the decision-time `enabled()` check already passed.
   * Omitted (the default) skips the check entirely, so every existing call
   * site that doesn't care about gate-generation validity is unaffected.
   */
  add(entry: NetworkBodyEntry, guard?: () => boolean): void;
  freeze(): void;
  takeFrozen(): NetworkBodyEntry[] | null;
  discardAndResume(): void;
  clear(): void;
  /**
   * F17 (round-4 review) — PERMANENT zeroization + append gate, distinct from
   * `clear()`. `clear()` is a resumable wipe (logout/identity change — the
   * buffer is expected to keep accepting entries afterward); `kill()` is
   * one-way: once called, EVERY subsequent `add()` is a silent no-op for the
   * lifetime of this buffer instance. This is what closes the reviewer's
   * repro (buffer `size` going 1 → 0 → 1 across capture → `client.kill()` →
   * one post-kill fetch) for the IN-FLIGHT case specifically: an async body
   * read (`readCappedText().then(...)` in sdk-react's fetch patcher) that
   * resolves and calls `sink()` → `add()` AFTER `kill()` has already run must
   * still find the buffer refusing the entry, even though the patcher's own
   * `bodyCapture.enabled()` gate check ran (and passed) BEFORE `kill()`.
   * Mirrors the native SDKs' `honorsKillGate` re-check on `NetworkBodyRingBuffer.append`
   * (ac39a9c9 F1, hardened further by fea4155e F15) — JS is single-threaded so
   * there is no lock-acquisition race to close, only the async-continuation
   * gap between a synchronous gate check and a later microtask's `add()`
   * call, which this flag closes by construction (checked synchronously,
   * atomically, at the top of `add()` itself).
   */
  kill(): void;
  setByteBudget(bytes: number): void;
  readonly size: number;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of `s` — NOT `.length` (UTF-16 code units), which
 * undercounts multi-byte characters and would let a buffer sized in real
 * bytes grow past its intended budget. */
function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/**
 * F20 (round-2 review): a fixed per-entry overhead so an entry with NO
 * bodies (204s, content-type skips) still costs something and remains
 * subject to eviction — without this, zero-body entries' refs/skip-metadata/
 * header maps could grow the buffer without bound while `total` never
 * crossed the budget. Mirrors the native SDKs' `entryOverhead` /
 * `ENTRY_OVERHEAD` constant exactly (ac39a9c9 F2).
 */
const ENTRY_OVERHEAD = 256;

function headerBytes(headers: Record<string, string> | undefined): number {
  if (!headers) return 0;
  let total = 0;
  for (const [k, v] of Object.entries(headers)) {
    total += utf8Bytes(k) + utf8Bytes(v);
  }
  return total;
}

/** Byte cost of a single entry: UTF-8 byte count of `reqBody` + `resBody`
 * (nil bodies cost 0) + UTF-8 byte count of every header key and value in
 * `reqHeaders`/`resHeaders` + a fixed `ENTRY_OVERHEAD` so body-less entries
 * are still bounded (F20). */
function entryBytes(e: NetworkBodyEntry): number {
  return (
    utf8Bytes(e.reqBody ?? '') +
    utf8Bytes(e.resBody ?? '') +
    headerBytes(e.reqHeaders) +
    headerBytes(e.resHeaders) +
    ENTRY_OVERHEAD
  );
}

export function createNetworkBodyBuffer(deps: NetworkBodyBufferDeps = {}): NetworkBodyBuffer {
  let byteBudget = deps.byteBudget ?? DEFAULT_BODY_TOTAL_BUDGET;
  const entries: NetworkBodyEntry[] = [];
  let total = 0;
  let frozen: NetworkBodyEntry[] | null = null;
  // F17 — set once by kill(), never reset. Checked synchronously at the top
  // of add() so a later microtask (an in-flight body read's `.then()`) can
  // never repopulate a buffer that has already been permanently killed.
  let killed = false;

  function evictToBudget(): void {
    // Oldest-first: entries is insertion-ordered (== chronological by add).
    while (total > byteBudget && entries.length > 0) {
      const victim = entries.shift()!;
      total -= entryBytes(victim);
    }
  }

  return {
    add(entry: NetworkBodyEntry, guard?: () => boolean): void {
      // F17 — authoritative, checked BEFORE anything else. This is what
      // makes a post-kill (or in-flight-resolving-post-kill) append a no-op
      // rather than merely unlikely.
      if (killed) return;
      // F34 — the last check before the insert, mirroring the native SDKs'
      // guard/`guard` parameter on their ring buffers' append/setTotalBudget.
      if (guard && !guard()) return;
      entries.push(entry);
      total += entryBytes(entry);
      evictToBudget();
    },
    freeze(): void {
      if (frozen === null) frozen = entries.slice();
    },
    takeFrozen(): NetworkBodyEntry[] | null {
      const out = frozen;
      frozen = null;
      return out;
    },
    discardAndResume(): void {
      frozen = null;
    },
    clear(): void {
      entries.length = 0;
      total = 0;
      frozen = null;
    },
    kill(): void {
      killed = true;
      entries.length = 0;
      total = 0;
      frozen = null;
    },
    setByteBudget(bytes: number): void {
      if (!Number.isInteger(bytes) || bytes < 1) return;
      byteBudget = bytes;
      evictToBudget();
    },
    get size(): number {
      return entries.length;
    },
  };
}
