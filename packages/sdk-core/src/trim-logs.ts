// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { LogEntry } from './types/platform.js';

/** Max total characters of captured-log messages shipped in a report envelope. */
export const MAX_LOG_CHARS = 4000;

/** Message placed on the single synthetic entry that stands in for trimmed logs. */
export const TRIMMED_LOGS_MESSAGE = 'REDACTED';

/**
 * Trim captured logs to the most recent ones that fit within `maxChars` total
 * message characters. Everything older is collapsed into ONE synthetic
 * `"REDACTED"` entry at the front, so chronology reads `[REDACTED, …recent]`.
 *
 * Why a single marker (not per-entry redaction): the goal is to shrink the
 * envelope (a noisy app can emit tens of thousands of lines). Redacting each
 * old entry in place would keep the same entry count and not help.
 *
 * Newest-first accumulation: the most recent logs are the ones a bug report
 * needs. The single newest entry is always kept — truncated to `maxChars` if it
 * alone exceeds the budget — so we never emit zero logs.
 *
 * Pure + platform-agnostic: the iOS (Swift) and Android (Kotlin) SDKs mirror
 * this exact algorithm and the same 4000 constant at their envelope-build step.
 */
export function trimLogs(logs: readonly LogEntry[], maxChars: number = MAX_LOG_CHARS): LogEntry[] {
  if (logs.length === 0) return [];

  const kept: LogEntry[] = [];
  let total = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i]!;
    const len = entry.message?.length ?? 0;
    if (kept.length === 0) {
      // Always keep the newest entry; truncate it if it alone blows the budget.
      kept.push(len > maxChars ? { ...entry, message: entry.message.slice(0, maxChars) } : entry);
      total = Math.min(len, maxChars);
      continue;
    }
    if (total + len > maxChars) break;
    kept.push(entry);
    total += len;
  }
  kept.reverse(); // restore chronological (oldest-kept → newest)

  const dropped = logs.length - kept.length;
  if (dropped > 0) {
    // Timestamp the marker just before the oldest kept entry so it sorts first.
    const markerTs = logs[dropped - 1]!.timestamp;
    kept.unshift({ level: 'info', message: TRIMMED_LOGS_MESSAGE, timestamp: markerTs });
  }
  return kept;
}
