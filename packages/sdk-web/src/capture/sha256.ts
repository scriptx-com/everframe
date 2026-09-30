// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { sha256BytesHex } from '@everframe/sdk-core';
import { readBlobArrayBuffer } from '../internal/blob.js';

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 hex of raw bytes. Web Crypto when it is there; otherwise, or when it
 * throws, the pure-JS digest sdk-core already ships. `crypto.subtle` exists only
 * in a secure context, and smart-TV apps are often hosted on plain `http://`,
 * where depending on it alone failed every screenshot and page snapshot. Both
 * paths produce the same lowercase hex.
 */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      // Web Crypto must see exactly these bytes: a view spanning its whole
      // buffer goes as is, anything partial is copied (`slice` allocates a
      // fresh ArrayBuffer). A shared buffer rejects and takes the fallback.
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      return toHex(await subtle.digest('SHA-256', (whole ? bytes : bytes.slice()) as Uint8Array<ArrayBuffer>));
    } catch {
      // Fall through to the pure-JS digest.
    }
  }
  return sha256BytesHex(bytes);
}

/**
 * SHA-256 hex of a Blob's bytes. Used by captureScreenshot to populate
 * ScreenshotResult.sha256 (consumed by sdk-core/transport/multipart.ts buildMultipart()
 * which puts the digest in attachments[].sha256 — verified server-side per INGEST-03),
 * and by the TV page-snapshot path for the snapshot and its render.
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  return sha256HexOfBytes(new Uint8Array(await readBlobArrayBuffer(blob)));
}
