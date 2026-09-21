// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device-side shot stash (spec 2026-07-17 §3, plan 2026-08-12 Task 9).
//
// An unknown shot_id captures fresh at FULL resolution and stashes the
// result; a known one re-crops that stash and never re-captures. That rule is
// the feature: the user drew their crop on a ~480p frame of a screen that has
// since moved on, so re-capturing would crop a different picture than the one
// they were looking at.
'use client';

export interface StashedShotCapture {
  bytes: ArrayBuffer;
  mime: 'image/png' | 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShotStashOptions {
  correlationId: string;
  capture: () => Promise<StashedShotCapture>;
  /** Rect arrives in PIXELS of `source` — the stash owns the normalized→pixel math. */
  crop: (
    source: StashedShotCapture,
    rect: { x: number; y: number; w: number; h: number },
  ) => Promise<StashedShotCapture>;
  send: (message: unknown) => void;
  sendBinary: (bytes: ArrayBuffer) => void;
}

export interface ShotStash {
  handle(req: { shotId: string; rect?: NormalizedRect }): Promise<void>;
  clear(): void;
}

/**
 * Ceiling on distinct stashed shot_ids. The phone's UI caps how many shots a
 * draft can hold, but the wire does not — without a bound here, a peer
 * rotating fresh schema-valid ids holds one full-resolution capture per id in
 * device memory for the life of the report. Oldest-evicted; a re-crop of an
 * evicted id re-captures (slightly wrong pixels beat an unbounded Map on a
 * memory-starved TV).
 */
const MAX_STASHED_SHOTS = 12;

export function createShotStash(opts: ShotStashOptions): ShotStash {
  const stash = new Map<string, StashedShotCapture>();
  // In-flight captures, keyed by shot_id. Two jobs (review round 2,
  // finding 3): concurrent requests for the SAME new id share one capture
  // (a second capture could resolve to a different frame than the one whose
  // crop the phone is already drawing), and the cap below counts these, so
  // a burst of distinct ids cannot start more captures than the stash may
  // ever hold.
  const pending = new Map<string, Promise<StashedShotCapture>>();
  // clear() cannot cancel an in-flight capture/crop, but it must make the
  // completion inert: after report.cancelled / peer loss, a late resolution
  // must neither retain pixels nor send frames into the (possibly re-bonded)
  // socket.
  let cleared = false;

  return {
    async handle(req) {
      try {
        let source = stash.get(req.shotId);
        if (source === undefined) {
          let capture = pending.get(req.shotId);
          if (capture === undefined) {
            if (stash.size + pending.size >= MAX_STASHED_SHOTS) {
              const oldest = stash.keys().next();
              if (oldest.done) throw new Error('shot_stash_full'); // every slot is in-flight
              stash.delete(oldest.value);
            }
            capture = opts.capture();
            pending.set(req.shotId, capture);
          }
          try {
            source = await capture;
          } finally {
            pending.delete(req.shotId);
          }
          if (cleared) return;
          // A concurrent same-id waiter may have stashed first — its frame
          // wins so every re-crop of this id uses ONE consistent bitmap.
          const already = stash.get(req.shotId);
          if (already !== undefined) {
            source = already;
          } else {
            stash.set(req.shotId, source);
          }
        }
        // Clamp to the source frame: the schema bounds each FIELD to 0–1 but
        // not the far edge (x+w may exceed 1). Native SDKs clamp; sampling
        // past the bitmap here would return transparent/black padding.
        const out =
          req.rect === undefined
            ? source
            : await (() => {
                const x = Math.min(Math.max(0, Math.round(req.rect!.x * source.width)), source.width - 1);
                const y = Math.min(Math.max(0, Math.round(req.rect!.y * source.height)), source.height - 1);
                const w = Math.max(1, Math.min(Math.round(req.rect!.w * source.width), source.width - x));
                const h = Math.max(1, Math.min(Math.round(req.rect!.h * source.height), source.height - y));
                return opts.crop(source, { x, y, w, h });
              })();
        if (cleared) return;
        opts.send({
          type: 'shot.assembled',
          correlation_id: opts.correlationId,
          shot_id: req.shotId,
          mime: out.mime,
          width: out.width,
          height: out.height,
          size: out.bytes.byteLength,
        });
        opts.sendBinary(out.bytes);
      } catch (err) {
        if (cleared) return;
        // Scoped to THIS shot — never report.failed. The draft and its other
        // shots are still perfectly good (spec, Error handling).
        opts.send({
          type: 'shot.failed',
          correlation_id: opts.correlationId,
          shot_id: req.shotId,
          reason: err instanceof Error ? err.message.slice(0, 200) : 'capture_failed',
        });
      }
    },
    clear() {
      cleared = true;
      stash.clear();
    },
  };
}
