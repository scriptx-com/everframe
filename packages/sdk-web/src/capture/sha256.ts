// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { readBlobArrayBuffer } from '../internal/blob.js';

/**
 * Web Crypto SHA-256 hex of a Blob's bytes. Used by captureScreenshot to populate
 * ScreenshotResult.sha256 (consumed by sdk-core/transport/multipart.ts buildMultipart()
 * which puts the digest in attachments[].sha256 — verified server-side per INGEST-03).
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await readBlobArrayBuffer(blob);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
