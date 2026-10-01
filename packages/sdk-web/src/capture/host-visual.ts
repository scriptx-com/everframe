// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { PlatformAdapter, ScreenshotResult } from '@everframe/sdk-core';
import { sha256Hex } from './sha256.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Renderer-owned visual artifacts. The host must mask all sensitive pixels before returning PNGs. */
export interface HostVisualCapture {
  captureScreenshot(): Promise<Blob | null>;
  replay?: NonNullable<PlatformAdapter['replay']> & {
    kill?(): void;
    revive?(): void;
  };
}

/** Accept only an explicitly supplied renderer PNG; never use DOM capture as fallback. */
export async function captureHostScreenshot(
  capture: () => Promise<Blob | null>,
): Promise<ScreenshotResult> {
  const blob = await capture();
  if (!blob || blob.type !== 'image/png' || blob.size < 24 || blob.size > MAX_FRAME_BYTES) {
    throw new Error('Everframe: safe renderer frame is unavailable');
  }
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (!PNG_SIGNATURE.every((byte, index) => header[index] === byte)) {
    throw new Error('Everframe: renderer frame is not a PNG');
  }
  const view = new DataView(header.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > 2048 || height > 2048) {
    throw new Error('Everframe: renderer frame dimensions are invalid');
  }
  return { blob, width, height, sha256: await sha256Hex(blob) };
}
