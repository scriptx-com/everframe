// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { trimLogs, MAX_LOG_CHARS, TRIMMED_LOGS_MESSAGE } from '../src/trim-logs.js';
import type { LogEntry } from '../src/types/platform.js';

const mk = (message: string, ts: number): LogEntry => ({ level: 'log', message, timestamp: ts });

describe('trimLogs', () => {
  it('returns [] for empty input (no marker)', () => {
    expect(trimLogs([])).toEqual([]);
  });

  it('keeps everything when under budget, unchanged, no marker', () => {
    const logs = [mk('a', 1), mk('b', 2), mk('c', 3)];
    expect(trimLogs(logs, 100)).toEqual(logs);
  });

  it('keeps the most recent logs within the char budget, collapsing older into one REDACTED at the front', () => {
    // 5 entries of 10 chars each = 50 total; budget 25 keeps the 2 newest (20 chars).
    const logs = Array.from({ length: 5 }, (_, i) => mk('x'.repeat(10), i + 1));
    const out = trimLogs(logs, 25);
    expect(out).toHaveLength(3); // 1 marker + 2 kept
    expect(out[0]).toMatchObject({ message: TRIMMED_LOGS_MESSAGE, level: 'info' });
    expect(out[1]!.timestamp).toBe(4);
    expect(out[2]!.timestamp).toBe(5);
    // Marker sorts chronologically before the kept window.
    expect(out[0]!.timestamp).toBe(logs[2]!.timestamp); // newest dropped = index 2 (ts 3)
  });

  it('boundary: an entry that exactly fills the remaining budget is kept', () => {
    const logs = [mk('aaaaa', 1), mk('bbbbb', 2)]; // 5 + 5
    const out = trimLogs(logs, 10);
    expect(out).toEqual(logs); // both fit exactly, no marker
  });

  it('always keeps the newest entry, truncated to the budget, when it alone exceeds it', () => {
    const logs = [mk('old', 1), mk('y'.repeat(9000), 2)];
    const out = trimLogs(logs, MAX_LOG_CHARS);
    expect(out).toHaveLength(2); // marker + truncated newest
    expect(out[0]!.message).toBe(TRIMMED_LOGS_MESSAGE);
    expect(out[1]!.message).toHaveLength(MAX_LOG_CHARS);
    expect(out[1]!.timestamp).toBe(2);
  });

  it('total kept message chars never exceed the budget', () => {
    const logs = Array.from({ length: 50 }, (_, i) => mk('z'.repeat(137), i));
    const out = trimLogs(logs, 1000);
    const keptChars = out
      .filter((e) => e.message !== TRIMMED_LOGS_MESSAGE)
      .reduce((n, e) => n + e.message.length, 0);
    expect(keptChars).toBeLessThanOrEqual(1000);
  });
});
