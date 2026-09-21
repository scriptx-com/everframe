// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * Bounded FIFO ring buffer. Used by capture/logs.ts (CAP-04) and capture/network.ts (CAP-05).
 * Eviction order: oldest-first when push() exceeds capacity.
 */
export class RingBuffer<T> {
  private buf: T[] = [];
  private cap: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be positive integer, got ${capacity}`);
    }
    this.cap = capacity;
  }

  push(item: T): void {
    if (this.buf.length >= this.cap) this.buf.shift();
    this.buf.push(item);
  }

  snapshot(): readonly T[] {
    return this.buf.slice();
  }

  size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
  }
}
