// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device-side preview producer (spec 2026-07-17 §3, plan 2026-08-12 Task 9).
//
// One timer, at most one in-flight capture. The self-imposed caps here are
// not belt-and-braces against the relay's cap — they are what makes the
// privacy budget honest. The relay drops frames it cannot afford, but a
// device that keeps capturing forever is still capturing forever, and the
// user's screen is still being read. Both caps must exist.
//
// Frames are ArrayBuffer (not Blob) on purpose: the relay HOLDS a
// `preview.frame` header until its binary arrives, so the header and its
// bytes must go out back-to-back with no await between them — a Blob→buffer
// conversion here would open an interleaving window with the next tick.
'use client';

export interface PreviewFrameCapture {
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

export interface PreviewLoopOptions {
  /** 500ms = the 2 fps ceiling of the spec's 1–2 fps budget. */
  intervalMs: number;
  /** Spec: 2 minutes, device-enforced. */
  maxDurationMs: number;
  capture: () => Promise<PreviewFrameCapture>;
  send: (message: unknown) => void;
  sendBinary: (bytes: ArrayBuffer) => void;
}

export interface PreviewLoop {
  start(correlationId: string): void;
  stop(reason: 'user' | 'time_cap' | 'capture_unavailable'): void;
  /**
   * `stop()` without the outbound frame — for peer loss
   * (phone.disconnected / pair.expired), where there is nobody left to
   * receive a `preview.stop`, and for a phone-initiated stop, which needs
   * no echo.
   */
  stopSilently(): void;
  readonly running: boolean;
}

export function createPreviewLoop(opts: PreviewLoopOptions): PreviewLoop {
  let timer: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let correlationId: string | null = null;
  let seq = 0;
  let capturing = false;

  function clearTimers(): void {
    if (timer !== null) clearInterval(timer);
    if (deadline !== null) clearTimeout(deadline);
    timer = null;
    deadline = null;
  }

  const loop: PreviewLoop = {
    get running() {
      return timer !== null;
    },
    start(id) {
      // Idempotent: the phone may re-send preview.start on a reconnect, and a
      // second interval would double the frame rate the caps were sized for.
      if (timer !== null) return;
      correlationId = id;
      seq = 0;
      timer = setInterval(() => {
        // Skip this tick entirely rather than queue: a capture slower than
        // the interval means the device cannot sustain the rate, and queueing
        // would deliver a backlog of stale frames after it recovers.
        if (capturing) return;
        capturing = true;
        void opts
          .capture()
          .then((frame) => {
            if (timer === null) return; // stopped mid-capture
            opts.send({
              type: 'preview.frame',
              correlation_id: correlationId,
              seq: seq++,
              mime: 'image/jpeg',
              width: frame.width,
              height: frame.height,
            });
            opts.sendBinary(frame.bytes);
          })
          .catch(() => {
            // DEFE-02: a preview failure must never break the report. Tell the
            // phone why and go quiet.
            loop.stop('capture_unavailable');
          })
          .finally(() => {
            capturing = false;
          });
      }, opts.intervalMs);
      deadline = setTimeout(() => loop.stop('time_cap'), opts.maxDurationMs);
    },
    stop(reason) {
      if (timer === null) return;
      clearTimers();
      opts.send({ type: 'preview.stop', correlation_id: correlationId, reason });
      correlationId = null;
    },
    stopSilently() {
      if (timer === null) return;
      clearTimers();
      correlationId = null;
    },
  };

  return loop;
}
