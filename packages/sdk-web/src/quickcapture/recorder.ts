// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): records the remote keys a teammate
// presses during "record on device", for the dashboard to turn into a
// binding. Pure: the caller feeds key inputs and the clock. Times are relative
// to the first recorded keydown; repeats (inferred, as in the detector) and
// keys outside the contract are ignored; at most 32 presses are kept.
import type { KeyInput } from './gesture-detector.js';
import type { GestureKeyName } from './remote-keys.js';

export interface RecordedKey {
  key: GestureKeyName;
  downMs: number;
  upMs: number;
}

export const MAX_EVENTS = 32;
export const DURATION_MS = 10_000;

interface Press {
  key: GestureKeyName;
  downAt: number;
  upAt: number | null;
}

export class GestureRecorder {
  private presses: Press[] = [];
  /** Open presses by key code: index into `presses`, or -1 for an ignored press. */
  private open: { [code: number]: number } = {};
  private firstDown: number | null = null;

  onKey(e: KeyInput): void {
    if (e.type === 'down') {
      if (this.open[e.code] !== undefined) return; // a repeat
      if (e.repeat === true) return; // a press that started before the recording
      if (e.name === null || this.presses.length >= MAX_EVENTS) {
        this.open[e.code] = -1;
        return;
      }
      if (this.firstDown === null) this.firstDown = e.atMs;
      this.open[e.code] = this.presses.length;
      this.presses.push({ key: e.name, downAt: e.atMs, upAt: null });
      return;
    }
    const i = this.open[e.code];
    if (i === undefined) return;
    delete this.open[e.code];
    const p = this.presses[i];
    if (p) p.upAt = e.atMs;
  }

  /** The recorded presses; keys still held end at `nowMs`. */
  finish(nowMs: number): RecordedKey[] {
    const first = this.firstDown;
    if (first === null) return [];
    const rel = (t: number): number => Math.max(0, Math.round(t - first));
    return this.presses.map((p) => ({
      key: p.key,
      downMs: rel(p.downAt),
      upMs: Math.max(rel(p.downAt), rel(p.upAt === null ? nowMs : p.upAt)),
    }));
  }
}
