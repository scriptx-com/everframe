// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { sha256Hex } from './sha256.js';
import type { HostVisualCapture } from './host-visual.js';

export interface CanvasSensitiveRect { x: number; y: number; width: number; height: number }

export interface CanvasVisualOptions {
  /** The renderer-owned canvas, for example a Compose Multiplatform web surface. */
  canvas: HTMLCanvasElement;
  /** Sensitive bounds in canvas pixel coordinates, resolved for each frame. */
  sensitiveRects(): CanvasSensitiveRect[];
  /** Explicit opt-in only for screens known to contain no private content. */
  allowUnmarked?: boolean;
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 151;
const MAX_AGE_MS = 30_000;

function base64(bytes: Uint8Array): string {
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(raw);
}

/** Copies renderer pixels, blacks registered regions, and keeps only safe images in replay. */
export function createCanvasVisualCapture(options: CanvasVisualOptions): HostVisualCapture {
  const captureScreenshot = async (): Promise<Blob | null> => {
    try {
      const { canvas } = options;
      const { width, height } = canvas;
      if (width < 1 || height < 1 || width > 2048 || height > 2048) return null;
      const rects = options.sensitiveRects();
      if (!Array.isArray(rects) || (!options.allowUnmarked && rects.length === 0)) return null;
      if (rects.some(({ x, y, width: w, height: h }) =>
        ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 ||
        x < 0 || y < 0 || x + w > width || y + h > height)) return null;
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const context = output.getContext('2d');
      if (!context) return null;
      context.drawImage(canvas, 0, 0);
      context.fillStyle = '#000000';
      for (const rect of rects) context.fillRect(rect.x, rect.y, rect.width, rect.height);
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
      return blob?.type === 'image/png' && blob.size <= MAX_BYTES ? blob : null;
    } catch {
      return null;
    }
  };

  let frames: Array<{ at: number; blob: Blob; width: number; height: number }> = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let busy = false;
  let frozen = false;
  let revoked = false;
  let bytes = 0;
  const stop = (): void => { if (timer) clearInterval(timer); timer = undefined; generation++; };
  const reset = (): void => {
    stop(); frames = []; bytes = 0; frozen = false; revoked = false;
  };
  const sample = async (token: number): Promise<void> => {
    if (busy || frozen || revoked || token !== generation) return;
    busy = true;
    try {
      const blob = await captureScreenshot();
      if (token !== generation) return;
      if (!blob || blob.size < 24) { revoked = true; frames = []; stop(); return; }
      const at = Date.now();
      frames.push({ at, blob, width: options.canvas.width, height: options.canvas.height }); bytes += blob.size;
      while (frames.length > MAX_FRAMES || bytes > MAX_BYTES || at - frames[0]!.at > MAX_AGE_MS) {
        bytes -= frames.shift()!.blob.size;
      }
    } finally { busy = false; }
  };
  const start = (): void => {
    reset();
    const token = generation;
    void sample(token);
    timer = setInterval(() => { void sample(token); }, 500);
  };

  return {
    captureScreenshot,
    replay: {
      start,
      freeze() { frozen = true; stop(); },
      discardAndResume: start,
      async takeFrozen() {
        if (!frozen || revoked || frames.length === 0) return null;
        try {
          const first = frames[0]!;
          if (frames.some((frame) => frame.width !== first.width || frame.height !== first.height)) return null;
          const assets: Record<string, { mime: 'image/png'; w: number; h: number; b64: string }> = {};
          const outputFrames: Array<{ timestamp: number; ops: unknown[] }> = [];
          let previousRef: string | undefined;
          for (const frame of frames) {
            const bytes = new Uint8Array(await frame.blob.arrayBuffer());
            const ref = (await sha256Hex(frame.blob)).slice(0, 16);
            assets[ref] ??= { mime: 'image/png', w: first.width, h: first.height, b64: base64(bytes) };
            outputFrames.push({
              timestamp: frame.at - first.at,
              ops: !previousRef
                ? [{ op: 'add', parent: '', index: 0, node: {
                  id: 'kmp-web-root', role: 'image',
                  frame: { x: 0, y: 0, w: first.width, h: first.height },
                  imageRef: ref, children: [],
                } }]
                : ref === previousRef ? [] : [{ op: 'set', id: 'kmp-web-root', imageRef: ref }],
            });
            previousRef = ref;
          }
          const encoded = new TextEncoder().encode(JSON.stringify({
            version: 'everframe-vtree-v1',
            viewport: { width: first.width, height: first.height, scale: 1 },
            frames: outputFrames,
            originEpochMs: first.at,
            assets,
          }));
          if (encoded.byteLength > MAX_BYTES) return null;
          return { format: 'everframe-vtree-v1' as const, bytes: encoded,
            contentType: 'application/json', durationMs: outputFrames.at(-1)!.timestamp };
        } catch { return null; }
      },
      stop,
      kill: reset,
    },
  };
}
