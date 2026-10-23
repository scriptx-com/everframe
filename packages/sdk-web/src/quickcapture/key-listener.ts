// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the remote key listener. Lazy chunk.
//
// Capture-phase `keydown`/`keyup` listeners on `window` (plus `blur` and the
// document's `visibilitychange`) feed the gesture detector. They are attached
// only while the gesture is armed or a recording is active; `rearm()` attaches
// or detaches them after a config or link change.
//
// Keys: the first keydown of a press always reaches the app. A key event is
// swallowed (preventDefault + stopImmediatePropagation) only when the detector
// says so AND `swallowKeys()` was true when the gesture fired; that answer is
// kept per key until the key's own keyup. An unlinked TV never swallows.
//
// While a recording is active every event goes to the recorder and reaches
// the app unchanged. A binding that types (letters, digits, SHIFT) stands
// aside while a text field has focus, including a field inside a shadow root
// (the SDK's own reporter is one). DEFE-02: nothing throws into the host.
import { GestureDetector, type KeyInput } from './gesture-detector.js';
import {
  bindingsEqual,
  isTypingBinding,
  type RemoteKeyMap,
  type TvGestureBinding,
} from './remote-keys.js';

export interface RemoteKeyListenerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export interface RemoteKeyListenerDeps {
  win: Window;
  keyMap: RemoteKeyMap;
  /** The armed binding, or null when the gesture is not armed. */
  armedBinding(): TvGestureBinding | null;
  /** Whether a fired gesture's keys are swallowed (a linked TV). Read when the gesture fires. */
  swallowKeys(): boolean;
  onGesture(): void;
  /** The active gesture recorder, or null. */
  recording(): { onKey(e: KeyInput): void } | null;
  /** A monotonic clock in milliseconds. */
  now(): number;
  timers: RemoteKeyListenerTimers;
  /** Text-field focus probe (tests). Defaults to `isTextFocus(win.document, event)`. */
  isTextFocus?(ev?: Event): boolean;
}

function isTextField(el: unknown): boolean {
  if (!el || typeof (el as Element).tagName !== 'string') return false;
  const tag = (el as Element).tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * The focused element, descending through open shadow roots:
 * `document.activeElement` is only the outermost shadow host.
 */
export function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  for (let depth = 0; el && depth < 32; depth++) {
    const inner = el.shadowRoot ? el.shadowRoot.activeElement : null;
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/**
 * True while a text field has focus, or when the key event itself comes from
 * one (its `composedPath()[0]`, which sees into open shadow roots).
 */
export function isTextFocus(doc: Document, ev?: Event): boolean {
  if (isTextField(deepActiveElement(doc))) return true;
  if (!ev) return false;
  try {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : null;
    return isTextField(path && path.length > 0 ? path[0] : ev.target);
  } catch {
    return false;
  }
}

export interface RemoteKeyListener {
  rearm(): void;
  dispose(): void;
}

interface PendingHold {
  detector: GestureDetector;
  code: number;
  deadline: number;
  handle: unknown;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function installRemoteKeyListener(deps: RemoteKeyListenerDeps): RemoteKeyListener {
  const { win, keyMap, timers } = deps;
  const textFocus = (ev?: Event): boolean =>
    safe(() => (deps.isTextFocus ? deps.isTextFocus(ev) : isTextFocus(win.document, ev)), false);
  let attached = false;
  let disposed = false;
  let detector: GestureDetector | null = null;
  let hold: PendingHold | null = null;
  // Per key: the swallowKeys() answer cached when that key fired, until its keyup.
  let swallowFor: { [code: number]: boolean } = {};

  const now = (): number => safe(() => deps.now(), Date.now());
  const armed = (): TvGestureBinding | null => safe(() => deps.armedBinding(), null);
  const recorder = (): { onKey(e: KeyInput): void } | null => safe(() => deps.recording(), null);

  function cancelHold(): void {
    const h = hold;
    if (!h) return;
    hold = null;
    safe(() => timers.clear(h.handle), undefined);
  }

  /** Forgets the press in progress: hold timer, detector state and swallow answers. */
  function resetGesture(): void {
    cancelHold();
    if (detector) detector.reset();
    swallowFor = {};
  }

  function fire(code: number): void {
    swallowFor[code] = safe(() => deps.swallowKeys() === true, false);
    safe(() => deps.onGesture(), undefined);
  }

  function scheduleHold(d: GestureDetector, code: number, deadline: number): void {
    cancelHold();
    const h: PendingHold = { detector: d, code, deadline, handle: null };
    hold = h;
    const run = (): void => {
      try {
        if (disposed || hold !== h) return;
        hold = null;
        // A remote without autorepeat sends nothing between keydown and keyup,
        // so re-check what may have changed meanwhile.
        if (detector !== d) return;
        const binding = armed();
        if (
          binding === null ||
          !bindingsEqual(binding, d.binding) ||
          recorder() !== null ||
          (isTypingBinding(binding) && textFocus())
        ) {
          resetGesture();
          return;
        }
        const t = now();
        if (t < h.deadline) {
          // A timer that ran early: wait for the rest.
          hold = h;
          h.handle = timers.set(run, h.deadline - t);
          return;
        }
        if (d.onHoldTimer(t)) fire(h.code);
      } catch {
        /* DEFE-02 */
      }
    };
    h.handle = safe(() => timers.set(run, Math.max(0, deadline - now())), null);
  }

  // Engines that report keyCode 0 identify keys only by `key`. The detector
  // and recorder track held keys by code, so each such key gets a stable
  // synthetic negative code (contract keys by name, others by `key`).
  const keyOnlyCodes: { [identity: string]: number } = {};
  let nextKeyOnlyCode = -1;
  function keyOnlyCode(identity: string): number {
    let c = keyOnlyCodes[identity];
    if (c === undefined) {
      c = nextKeyOnlyCode;
      nextKeyOnlyCode -= 1;
      keyOnlyCodes[identity] = c;
    }
    return c;
  }

  function inputFor(ev: KeyboardEvent): KeyInput {
    let code = typeof ev.keyCode === 'number' && ev.keyCode !== 0 ? ev.keyCode : ev.which || 0;
    const key = typeof ev.key === 'string' ? ev.key : '';
    const name = keyMap.nameFor(code, key);
    if (code === 0) {
      if (name !== null) code = keyOnlyCode(`name:${name}`);
      else if (key.length > 0) code = keyOnlyCode(`key:${key}`);
    }
    return {
      type: ev.type === 'keyup' ? 'up' : 'down',
      name,
      code,
      shift: ev.shiftKey === true,
      repeat: ev.repeat === true,
      atMs: now(),
    };
  }

  function swallow(ev: KeyboardEvent): void {
    try {
      ev.preventDefault();
    } catch {
      /* DEFE-02 */
    }
    try {
      ev.stopImmediatePropagation();
    } catch {
      /* DEFE-02 */
    }
  }

  /**
   * A typing binding while a text field has focus: typing stays typing. Only a
   * key that fired before the field took focus is still fed in, so it stays
   * swallowed until its own keyup.
   */
  function standAside(d: GestureDetector, ev: KeyboardEvent, input: KeyInput): void {
    d.dropPending();
    cancelHold();
    const cached = swallowFor[input.code];
    if (cached === undefined) return;
    const verdict = d.onKey(input);
    if (input.type === 'up') delete swallowFor[input.code];
    if (verdict.swallow && cached) swallow(ev);
  }

  function onKey(ev: KeyboardEvent): void {
    try {
      if (disposed) return;
      const input = inputFor(ev);
      const rec = recorder();
      if (rec) {
        try {
          rec.onKey(input);
        } catch {
          /* DEFE-02 */
        }
        resetGesture();
        return;
      }
      const binding = armed();
      if (binding === null) {
        resetGesture();
        return;
      }
      if (!detector || !bindingsEqual(binding, detector.binding)) {
        resetGesture();
        detector = new GestureDetector(binding);
      }
      const d = detector;
      if (isTypingBinding(binding) && textFocus(ev)) {
        standAside(d, ev, input);
        return;
      }
      const verdict = d.onKey(input);
      if (verdict.holdDeadlineMs !== null) scheduleHold(d, input.code, verdict.holdDeadlineMs);
      if (input.type === 'up' && hold && hold.code === input.code) cancelHold();
      if (verdict.fire) fire(input.code);
      const cached = swallowFor[input.code] === true;
      if (input.type === 'up') delete swallowFor[input.code];
      if (verdict.swallow && cached) swallow(ev);
    } catch {
      /* DEFE-02 */
    }
  }

  function onBlur(): void {
    try {
      resetGesture();
    } catch {
      /* DEFE-02 */
    }
  }

  function onVisibility(): void {
    try {
      if (win.document.visibilityState === 'hidden') resetGesture();
    } catch {
      /* DEFE-02 */
    }
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    try {
      win.addEventListener('keydown', onKey, true);
      win.addEventListener('keyup', onKey, true);
      win.addEventListener('blur', onBlur);
      win.document.addEventListener('visibilitychange', onVisibility);
    } catch {
      /* DEFE-02 */
    }
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('keyup', onKey, true);
      win.removeEventListener('blur', onBlur);
      win.document.removeEventListener('visibilitychange', onVisibility);
    } catch {
      /* DEFE-02 */
    }
  }

  function rearm(): void {
    try {
      if (disposed) return;
      const binding = armed();
      if (binding !== null || recorder() !== null) attach();
      else detach();
      // A routine config refresh with an equal binding keeps a press in progress.
      if (detector && !bindingsEqual(binding, detector.binding)) {
        resetGesture();
        detector = null;
      }
    } catch {
      /* DEFE-02 */
    }
  }

  rearm();

  return {
    rearm,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        detach();
        resetGesture();
        detector = null;
      } catch {
        /* DEFE-02 */
      }
    },
  };
}
