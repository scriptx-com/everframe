// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): recognizes the dashboard's remote
// binding (`captureGesture.tv`) in the page's key stream. A pure state machine
// over key-event fields: no timers, no DOM, no clock of its own. The listener
// (`key-listener.ts`) feeds it every key event, runs the hold timer it asks
// for, and decides whether `swallow` applies (only on a linked TV).
//
// Repeats are inferred: a down for a code that is already held is a repeat,
// whatever `event.repeat` says (some engines never set it). A down that says
// `repeat` for a code this detector never saw go down belongs to a press that
// started before it existed: it passes and never fires.
//
//   longPress  the first down passes and asks for a hold timer at
//              atMs + holdMs. The press fires once, from the timer while the
//              key is still held or from a repeat that late (that repeat is
//              swallowed). Later repeats are swallowed; the up never is. An
//              up before the deadline is a tap.
//   sequence   only first downs count; fire when the last N names equal the
//              binding within windowMs. The completing down, its repeats and
//              its up are swallowed. The history is cleared after firing.
//   chord      fire on the first down, of a key in the binding, that makes
//              every binding key held (SHIFT also counts while the event's
//              shiftKey is set). That key's down, repeats and up are
//              swallowed; overlapping completions keep each fired key
//              swallowed until its own up.
//
// Normal TV use never fires: a held D-pad only repeats (never a new step), and
// a tapped Play/Pause is released long before the deadline.
import type { GestureKeyName, TvGestureBinding } from './remote-keys.js';

export interface KeyInput {
  type: 'down' | 'up';
  name: GestureKeyName | null;
  code: number;
  shift: boolean;
  /** The event's own `repeat` flag; used only to spot a press this detector never saw start. */
  repeat?: boolean;
  atMs: number;
}

export interface KeyVerdict {
  fire: boolean;
  swallow: boolean;
  holdDeadlineMs: number | null;
}

const PASS: KeyVerdict = { fire: false, swallow: false, holdDeadlineMs: null };
const SWALLOW: KeyVerdict = { fire: false, swallow: true, holdDeadlineMs: null };
const FIRE: KeyVerdict = { fire: true, swallow: true, holdDeadlineMs: null };

export class GestureDetector {
  readonly binding: TvGestureBinding;

  /** Codes whose first down was seen and whose up was not. */
  private held: { [code: number]: true } = {};

  // longPress
  private holdCode: number | null = null;
  private holdDownAt = 0;
  private holdFired = false;

  // sequence
  private steps: Array<{ name: GestureKeyName | null; atMs: number }> = [];

  // chord
  private chordHeld: { [name: string]: true } = {};

  /** Sequence and chord: codes whose down fired, each swallowed until its own up. */
  private fired: { [code: number]: true } = {};

  constructor(binding: TvGestureBinding) {
    this.binding = binding;
  }

  onKey(e: KeyInput): KeyVerdict {
    const code = e.code;
    if (e.type === 'down') {
      if (this.held[code] === true) return this.onRepeat(e);
      // A repeat of a press that started before this detector saw it.
      if (e.repeat === true) return PASS;
      this.held[code] = true;
      return this.onFirstDown(e);
    }
    if (this.held[code] !== true) return PASS;
    delete this.held[code];
    return this.onUp(e);
  }

  /** True once, while the long-press key is still held at or after its deadline. */
  onHoldTimer(nowMs: number): boolean {
    const b = this.binding;
    if (b.kind !== 'longPress' || this.holdCode === null || this.holdFired) return false;
    if (nowMs < this.holdDownAt + b.holdMs) return false;
    this.holdFired = true;
    return true;
  }

  /**
   * Drops recognition in progress (a pending hold, sequence steps, held chord
   * keys) but keeps fired keys swallowed until their own up. Used while a text
   * field has focus, when non-swallowed keys are not fed in at all.
   */
  dropPending(): void {
    if (!this.holdFired) this.holdCode = null;
    this.steps = [];
    this.chordHeld = {};
    const keep: { [code: number]: true } = {};
    for (const k in this.fired) keep[Number(k)] = true;
    if (this.holdCode !== null) keep[this.holdCode] = true;
    this.held = keep;
  }

  reset(): void {
    this.held = {};
    this.holdCode = null;
    this.holdDownAt = 0;
    this.holdFired = false;
    this.steps = [];
    this.chordHeld = {};
    this.fired = {};
  }

  private onFirstDown(e: KeyInput): KeyVerdict {
    const b = this.binding;
    if (b.kind === 'longPress') {
      if (e.name === null || e.name !== b.keys[0]) return PASS;
      this.holdCode = e.code;
      this.holdDownAt = e.atMs;
      this.holdFired = false;
      return { fire: false, swallow: false, holdDeadlineMs: e.atMs + b.holdMs };
    }
    if (b.kind === 'sequence') {
      this.steps.push({ name: e.name, atMs: e.atMs });
      while (this.steps.length > b.keys.length) this.steps.shift();
      if (this.steps.length < b.keys.length) return PASS;
      for (let i = 0; i < b.keys.length; i++) {
        if ((this.steps[i] as { name: GestureKeyName | null }).name !== b.keys[i]) return PASS;
      }
      const first = this.steps[0] as { atMs: number };
      if (e.atMs - first.atMs > b.windowMs) return PASS;
      this.steps = [];
      this.fired[e.code] = true;
      return FIRE;
    }
    if (e.name === null) return PASS;
    this.chordHeld[e.name] = true;
    if (b.keys.indexOf(e.name) === -1) return PASS;
    for (const k of b.keys) {
      if (this.chordHeld[k] === true) continue;
      if (k === 'SHIFT' && e.shift) continue;
      return PASS;
    }
    this.fired[e.code] = true;
    return FIRE;
  }

  private onRepeat(e: KeyInput): KeyVerdict {
    const b = this.binding;
    if (b.kind === 'longPress') {
      if (this.holdCode !== e.code) return PASS;
      if (this.holdFired) return SWALLOW;
      if (e.atMs - this.holdDownAt >= b.holdMs) {
        this.holdFired = true;
        return FIRE;
      }
      return PASS;
    }
    return this.fired[e.code] === true ? SWALLOW : PASS;
  }

  private onUp(e: KeyInput): KeyVerdict {
    const b = this.binding;
    if (b.kind === 'longPress') {
      if (this.holdCode === e.code) {
        this.holdCode = null;
        this.holdFired = false;
      }
      return PASS;
    }
    if (b.kind === 'chord' && e.name !== null) delete this.chordHeld[e.name];
    if (this.fired[e.code] === true) {
      delete this.fired[e.code];
      return SWALLOW;
    }
    return PASS;
  }
}
