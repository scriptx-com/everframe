// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Helpers shared by the eager companion bridge and the lazily loaded
// companion submit (companion-submit.ts). Moved verbatim from capture-bridge.
'use client';
import type { z } from 'zod';
import type { relay, FocusedNode } from '@everframe/protocol';
import type { DeviceMetadata, LogEntry, NetworkEntry } from '@everframe/sdk-core';
import type { ShotCapture } from '../capture/shot-capture.js';

type ReportCompleted = z.infer<typeof relay.ReportCompleted>;
type ReportFailed = z.infer<typeof relay.ReportFailed>;

/**
 * Capture taken at report.request, stashed by correlation_id so the later
 * report.submit can build a complete envelope (logs/network/metadata are NOT
 * re-sent by the phone — only the baked screenshot is).
 */
export interface StashedCapture {
  logs: LogEntry[];
  network: NetworkEntry[];
  metadata: DeviceMetadata | null;
  focused: FocusedNode | null;
  screenshotWidth: number;
  screenshotHeight: number;
  /** The primary shot as captured — image, snapshot, reason, render context. */
  primary: ShotCapture | null;
}

export function reportCompleted(correlationId: string, eventId: string): ReportCompleted {
  return { type: 'report.completed', correlation_id: correlationId, event_id: eventId };
}

export function reportFailed(correlationId: string, reason: string): ReportFailed {
  return { type: 'report.failed', correlation_id: correlationId, reason };
}

/** Run a sync capture, swallowing throws (DEFE-02) and returning a fallback. */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Sniff the image MIME from the baked bytes (the binary frame carries no type). */
export function sniffImageMime(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes.slice(0, 12));
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png';
  if (
    u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && // RIFF
    u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  return 'image/png';
}

/**
 * Decode a Blob into an HTMLImageElement, bounded (see reencodeToWebP's
 * rationale). Capture paths keep the default budget; BEST-EFFORT callers
 * (attachment dims, where the fallback is perfectly serviceable) pass a
 * short one so a degraded engine can't stall every submit by the full
 * timeout.
 */
export async function decodeImageBlob(blob: Blob, timeoutMs = 1_000): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await Promise.race([
      new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('image-decode-failed'));
        el.src = url;
      }),
      new Promise<HTMLImageElement>((_, reject) =>
        setTimeout(() => reject(new Error('image-decode-timeout')), timeoutMs),
      ),
    ]);
  } finally {
    URL.revokeObjectURL(url);
  }
}
