// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * The session-replay refs a bug report carries today. Error replays reuse them
 * unchanged (spec 2026-10-11, "Attaching the replay"). Fresh object per call.
 */
export function rrwebReplayRef(): Record<string, unknown> {
  return {
    partName: 'session-replay',
    kind: 'session-replay',
    contentType: 'application/octet-stream',
    byteLength: 12_345,
    sha256: 'a'.repeat(64),
    format: 'rrweb',
    durationMs: 30_000,
  };
}

export function videoReplayRef(): Record<string, unknown> {
  return {
    partName: 'session-replay',
    kind: 'session-replay',
    contentType: 'video/mp4',
    byteLength: 1_500_000,
    sha256: 'b'.repeat(64),
    format: 'everframe-video-v1',
    width: 854,
    height: 480,
    durationMs: 30_000,
    replayStartEpochMs: 1_760_000_000_000,
  };
}
