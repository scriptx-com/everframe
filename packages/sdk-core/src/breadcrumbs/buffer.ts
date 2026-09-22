// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Rolling breadcrumb ring buffer (spec §3). Capture adapters push typed
// crumbs; overflow evicts oldest. MASK-BEFORE-BYTES: every string passes the
// existing redaction engine BEFORE entering the buffer — same doctrine as
// replay (REPLAY-04); no raw PII is ever buffered.
//
// Lifecycle mirrors the replay seam (types/platform.ts `replay`):
//   freeze() at reporter-open snapshots the chain so the reporter's own
//   taps don't pollute it; discardAndResume() on cancel drops the snapshot
//   (live capture never stopped); takeFrozen() on submit hands the snapshot
//   to the envelope build. clear() zeroizes on logout/identity change.
import type { Breadcrumb } from '@traceitx/protocol';
import { redactStringContent } from '../redaction/index.js';
import type { RedactionConfig } from '../redaction/index.js';

/** Buffer capacity (spec §3/§6 `maxCount` default). */
export const MAX_BREADCRUMBS = 100;
/** Protocol Breadcrumb.message ceiling — enforced at add-time. */
const MAX_MESSAGE_CHARS = 2048;
/**
 * Recursion cap for data redaction — kind data shapes are flat; custom may nest.
 * Bounded recursion also guards against cyclic/pathological input. Crucially it
 * never leaks: an object/array subtree at or beyond the cap is NOT passed through
 * raw — it is replaced wholesale with the '[TRUNCATED:DEPTH]' sentinel, since any
 * strings inside it would otherwise skip redactStringContent entirely.
 */
const MAX_DATA_DEPTH = 4;
/** Sentinel replacing object/array subtrees at/beyond MAX_DATA_DEPTH (never passed raw). */
const DEPTH_TRUNCATION_SENTINEL = '[TRUNCATED:DEPTH]';

export interface BreadcrumbInput {
  kind: Breadcrumb['kind'];
  message: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

export interface BreadcrumbBufferDeps {
  /** Live redaction config (client config can arrive after buffer creation). */
  getRedaction?: () => RedactionConfig;
  maxCount?: number;
  /** Injectable epoch-ms clock. Defaults to Date.now. */
  now?: () => number;
}

export interface BreadcrumbBuffer {
  add(input: BreadcrumbInput): void;
  /** Snapshot the chain at reporter-open. No-op while already frozen. */
  freeze(): void;
  /** Drop the frozen snapshot (reporter cancelled). Live capture continues. */
  discardAndResume(): void;
  /** Return + clear the frozen snapshot, or null if freeze() was never called. */
  takeFrozen(): Breadcrumb[] | null;
  /** Zeroize everything (logout / identity change). */
  clear(): void;
  /**
   * Re-cap the buffer (server-driven `maxCount`, spec §6). Shrinking evicts
   * oldest immediately; growing takes effect on future adds. Non-positive,
   * non-integer, or non-finite values are ignored (config is server input —
   * never let a bad value zeroize the chain).
   */
  setMaxCount(count: number): void;
  /**
   * Non-destructive copy of the LIVE chain for crash-time serialization
   * (spec 2026-07-18). Independent of the freeze lifecycle: never blocks,
   * never clears, safe to call from an uncaught-exception path.
   */
  snapshot(): Breadcrumb[];
  readonly size: number;
}

function redactData(value: unknown, config: RedactionConfig, depth: number): unknown {
  if (typeof value === 'string') return redactStringContent(value, config);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DATA_DEPTH) return DEPTH_TRUNCATION_SENTINEL;
  if (Array.isArray(value)) return value.map((v) => redactData(v, config, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, redactData(v, config, depth + 1)])
  );
}

export function createBreadcrumbBuffer(deps: BreadcrumbBufferDeps = {}): BreadcrumbBuffer {
  let maxCount = deps.maxCount ?? MAX_BREADCRUMBS;
  const now = deps.now ?? Date.now;
  const getRedaction = deps.getRedaction ?? ((): RedactionConfig => ({}));

  const entries: Breadcrumb[] = [];
  let frozen: Breadcrumb[] | null = null;
  let seq = 0;

  return {
    add(input: BreadcrumbInput): void {
      const redaction = getRedaction();
      const redacted = redactStringContent(input.message, redaction);
      // SURROGATE EDGE (documented platform divergence — spec 2026-07-08
      // ruling): when this UTF-16 cut lands inside a surrogate pair, JS
      // .slice() and Kotlin substring keep the lone surrogate; Swift's
      // String(decoding:as:UTF16.self) substitutes U+FFFD (Swift String
      // cannot hold a lone surrogate). Accepted: each SDK trims only its own
      // crumbs, so the divergence cannot surface in a shipped report — it
      // exists only under a shared-oracle comparison. Pinned by the
      // characterization tests beside each mirror (see trim.ts).
      const message = redacted.slice(0, MAX_MESSAGE_CHARS);
      const crumb: Breadcrumb = {
        t: now(),
        seq: seq++,
        kind: input.kind,
        ...(input.level ? { level: input.level } : {}),
        message,
        ...(message.length < redacted.length ? { truncated: true } : {}),
        ...(input.data
          ? { data: redactData(input.data, redaction, 0) as Record<string, unknown> }
          : {}),
      };
      entries.push(crumb);
      if (entries.length > maxCount) entries.shift();
    },

    freeze(): void {
      // Idempotent open (matches replay lifecycle): never a second snapshot.
      if (frozen === null) frozen = entries.slice();
    },

    discardAndResume(): void {
      frozen = null;
    },

    takeFrozen(): Breadcrumb[] | null {
      const out = frozen;
      frozen = null;
      return out;
    },

    clear(): void {
      entries.length = 0;
      frozen = null;
    },

    setMaxCount(count: number): void {
      if (!Number.isInteger(count) || count < 1) return;
      maxCount = count;
      while (entries.length > maxCount) entries.shift();
    },

    snapshot(): Breadcrumb[] {
      return [...entries];
    },

    get size(): number {
      return entries.length;
    },
  };
}
