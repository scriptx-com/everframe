// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RWEB-01 / REPLAY-01 — rrweb rolling buffer with snapshot-segment rotation
// and time + byte pruning.
//
// Retain the full snapshot at/before the requested window and its following
// events. Time pruning never removes the only anchor. Under the byte/event
// cap, shed whole older segments first; the recorder handles a newest segment
// that alone exceeds the cap. Only report/debug reads flatten the queue.

/** EventType.FullSnapshot in rrweb (@rrweb/types). Duplicated as a literal so the
 *  buffer stays free of any rrweb import (REPLAY-05 lazy-load discipline). */
export const FULL_SNAPSHOT = 2;

/** EventType.Meta in rrweb. rrweb emits a Meta event (carrying the viewport
 *  width/height/href the player needs to SIZE the replay) immediately BEFORE
 *  each FullSnapshot. The prune must retain it with the anchor or rrweb-player
 *  has no dimensions and renders a 0-size (black) frame. Literal to stay
 *  rrweb-import-free. */
export const META = 4;

/** Retained-buffer hard caps (RESEARCH §"Open Item 2"). */
export const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MB uncompressed
export const MAX_BUFFER_EVENTS = 6000;

/** Minimal structural shape the buffer needs — a superset-compatible subset of
 *  rrweb's `eventWithTime`. */
export interface BufferEvent {
  type: number;
  timestamp: number;
  // rrweb events carry a `data` payload we pass through untouched.
  data?: unknown;
  [k: string]: unknown;
}

export interface RollingBufferOptions {
  /** Rolling window in seconds (the configured replayDurationSec). */
  durationSec: number;
  /** Override the byte cap (testing). */
  maxBytes?: number;
  /** Override the event cap (testing). */
  maxEvents?: number;
}

export interface RollingBuffer {
  /** Append an event; pass isCheckout=true when rrweb signals a checkout (full snapshot). */
  push(event: BufferEvent, isCheckout?: boolean): void;
  /** Prune retained events to the rolling window anchored on the latest eligible checkout. */
  rotate(nowTs: number): void;
  /** Snapshot of the currently-retained events (oldest → newest), window-trimmed. */
  frames(): BufferEvent[];
  /** Timestamp of the oldest retained frame, or null when empty. */
  oldestTs(): number | null;
  /** Total retained event count. */
  size(): number;
  /** Conservative retained UTF-8 JSON byte estimate, excluding the outer array. */
  byteSize(): number;
  /** True once a hard cap (bytes or events) has been breached — the session must self-disable. */
  capBreached(): boolean;
  /** Zeroize all retained state (discard). */
  clear(): void;
}

/**
 * Upper bound on UTF-8 JSON size without allocating the serialized event.
 * rrweb emits JSON-shaped data. Stop at the cap (or excessive nesting) rather
 * than letting hostile/custom events make recording do unbounded work. Escaped
 * controls and surrogate code units are deliberately overestimated.
 */
const ESCAPED_OR_MULTIBYTE = /["\\\u0000-\u001f\u007f-\uffff]/;

function stringBytes(value: string, limit: number): number {
  let bytes = value.length + 2;
  if (bytes > limit || !ESCAPED_OR_MULTIBYTE.test(value)) return bytes;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) bytes += 5;
    else if (code === 34 || code === 92 || (code >= 0x80 && code < 0x800)) bytes += 1;
    else if (code >= 0x800) bytes += 2;
    if (bytes > limit) break;
  }
  return bytes;
}

/** Deep rrweb trees alternate element objects and child arrays. Keep the common
 * shallow path unchanged; spill deep subtrees to a bounded explicit stack
 * instead of confusing ordinary DOM nesting with a byte-cap breach. */
function deepJsonBytes(value: unknown, limit: number): number {
  const stack: { value: object; keys: string[] | null; index: number; included: number }[] = [];
  const active = new Set<object>();
  let bytes = 0;
  let current = value;
  for (;;) {
    if (current !== null && typeof current === 'object') {
      // Bound auxiliary memory for pathological custom data. This allows over
      // 2,000 DOM levels without depending on the old TV engine's call stack.
      if (stack.length >= 4096 || active.has(current) ||
          typeof (current as { toJSON?: unknown }).toJSON === 'function') return limit + 1;
      bytes += 2;
      active.add(current);
      stack.push({ value: current, keys: Array.isArray(current) ? null : Object.keys(current), index: 0, included: 0 });
    } else {
      bytes += jsonBytes(current, limit - bytes);
    }
    if (bytes > limit) return bytes;

    let found = false;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const length = frame.keys === null ? (frame.value as unknown[]).length : frame.keys.length;
      if (frame.index >= length) {
        active.delete(frame.value);
        stack.pop();
        continue;
      }
      if (frame.keys === null) {
        current = (frame.value as unknown[])[frame.index++];
        if (frame.included++ > 0) bytes++;
      } else {
        const key = frame.keys[frame.index++]!;
        current = (frame.value as Record<string, unknown>)[key];
        const type = typeof current;
        if (type === 'undefined' || type === 'function' || type === 'symbol') continue;
        if (frame.included++ > 0) bytes++;
        bytes += stringBytes(key, limit - bytes) + 1;
      }
      if (bytes > limit) return bytes;
      found = true;
      break;
    }
    if (!found) return bytes;
  }
}

function jsonBytes(value: unknown, limit: number, depth = 0): number {
  if (limit < 0) return limit + 1;
  if (value === null) return 4;
  switch (typeof value) {
    case 'string': return stringBytes(value, limit);
    case 'number': return Number.isFinite(value) ? String(value).length : 4;
    case 'boolean': return value ? 4 : 5;
    case 'undefined':
    case 'function':
    case 'symbol': return 4; // Array slots; object properties are omitted below.
    case 'object': break;
    default: return limit + 1; // BigInt is not JSON data.
  }
  if (depth >= 128) return deepJsonBytes(value, limit);
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return limit + 1;
  let bytes = 2;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i > 0) bytes++;
      bytes += jsonBytes(value[i], limit - bytes, depth + 1);
      if (bytes > limit) return bytes;
    }
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    let included = 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const child = record[key];
      const type = typeof child;
      if (type === 'undefined' || type === 'function' || type === 'symbol') continue;
      if (included++ > 0) bytes++;
      bytes += stringBytes(key, limit - bytes) + 1;
      if (bytes > limit) return bytes;
      bytes += jsonBytes(child, limit - bytes, depth + 1);
      if (bytes > limit) return bytes;
    }
  }
  return bytes;
}

interface Entry {
  event: BufferEvent;
  bytes: number;
}

interface Segment {
  entries: Entry[];
  bytes: number;
  /** Cached once at push; pruning never reads old event payloads. */
  snapshotTs: number | null;
  next: Segment | null;
  /** Next complete checkout, skipping orphan Meta segments after a failed snapshot. */
  nextSnapshot: Segment | null;
}

/**
 * A deque of snapshot segments. Each segment starts with a full snapshot and
 * its optional preceding Meta. Append is constant-time apart from sizing the
 * NEW event. Pruning and cap shedding unlink whole segments, subtracting their
 * cached totals; retained events are flattened only when a caller needs them.
 */
export function createRollingBuffer(opts: RollingBufferOptions): RollingBuffer {
  const durationMs = Math.max(0, opts.durationSec) * 1000;
  const maxBytes = opts.maxBytes ?? MAX_BUFFER_BYTES;
  const maxEvents = opts.maxEvents ?? MAX_BUFFER_EVENTS;
  let head: Segment | null = null;
  let tail: Segment | null = null;
  let lastSnapshot: Segment | null = null;
  let bytes = 0;
  let count = 0;
  let breached = false;

  function newSegment(snapshotTs: number | null): Segment {
    const segment: Segment = { entries: [], bytes: 0, snapshotTs, next: null, nextSnapshot: null };
    if (tail) tail.next = segment;
    else head = segment;
    tail = segment;
    return segment;
  }

  function append(segment: Segment, entry: Entry): void {
    segment.entries.push(entry);
    segment.bytes += entry.bytes;
    bytes += entry.bytes;
    count++;
  }

  function dropHead(): void {
    if (!head) return;
    if (head === lastSnapshot) lastSnapshot = null;
    bytes -= head.bytes;
    count -= head.entries.length;
    head = head.next;
    if (!head) tail = null;
  }

  return {
    push(event: BufferEvent, _isCheckout = false): void {
      let cost: number;
      try {
        cost = Math.min(jsonBytes(event, maxBytes), maxBytes + 1);
      } catch {
        // Malformed/custom events must never bypass the memory cap.
        cost = maxBytes + 1;
      }
      if (event.type === META) {
        // Meta is emitted immediately before a full snapshot. Stage its new
        // segment now: appending it to an already-full old segment would
        // trigger overflow recovery *inside* rrweb's checkout. Either event
        // may carry isCheckout, so identify the boundary by event type.
        append(newSegment(null), { event, bytes: cost });
      } else if (event.type === FULL_SNAPSHOT) {
        const pending = tail?.snapshotTs === null && tail.entries.length === 1 &&
          tail.entries[0]!.event.type === META;
        const segment = pending ? tail! : newSegment(event.timestamp);
        segment.snapshotTs = event.timestamp;
        if (lastSnapshot) lastSnapshot.nextSnapshot = segment;
        lastSnapshot = segment;
        append(segment, { event, bytes: cost });
      } else {
        append(tail ?? newSegment(null), { event, bytes: cost });
      }
      // Preserve the newest playable segment, shedding older history first.
      while (head !== tail && (bytes > maxBytes || count > maxEvents)) dropHead();
      // An orphan prefix has no anchor and cannot be replayed. Cap shedding
      // can expose one even after a later snapshot is complete. Keep only the
      // last pending segment when no complete snapshot remains, otherwise
      // advance to a real anchor (whose nextSnapshot links support rotation).
      while (head !== tail && head?.snapshotTs === null) dropHead();
      if (bytes > maxBytes || count > maxEvents) breached = true;
    },

    rotate(nowTs: number): void {
      if (durationMs <= 0) return;
      const cutoff = nowTs - durationMs;
      while (head?.nextSnapshot && head.nextSnapshot.snapshotTs! <= cutoff) {
        const anchor = head.nextSnapshot;
        // Never discard an anchor for an incomplete checkout. Once a complete
        // replacement is eligible, unlink intervening orphan segments too.
        while (head !== anchor) dropHead();
      }
    },

    frames(): BufferEvent[] {
      const events: BufferEvent[] = [];
      for (let segment = head; segment; segment = segment.next) {
        for (const entry of segment.entries) events.push(entry.event);
      }
      return events;
    },

    oldestTs(): number | null { return head?.entries[0]?.event.timestamp ?? null; },
    size(): number { return count; },
    byteSize(): number { return bytes; },
    capBreached(): boolean { return breached; },
    clear(): void {
      head = null;
      tail = null;
      lastSnapshot = null;
      bytes = 0;
      count = 0;
      breached = false;
    },
  };
}
