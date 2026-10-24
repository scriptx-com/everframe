// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyInput } from '../../src/quickcapture/gesture-detector.js';
import { GestureRecorder } from '../../src/quickcapture/recorder.js';
import {
  installRemoteKeyListener,
  type RemoteKeyListener,
  type RemoteKeyListenerDeps,
} from '../../src/quickcapture/key-listener.js';
import {
  createRemoteKeyMap,
  DEFAULT_TV_BINDING,
  type TvGestureBinding,
} from '../../src/quickcapture/remote-keys.js';

const PP = 415;
const UP = 38;
const DOWN = 40;
const B = 66;
const SHIFT = 16;

/** A manual clock and timer queue. */
function clock() {
  let t = 0;
  let seq = 0;
  const queue = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => t,
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = ++seq;
        queue.set(id, { fn, at: t + ms });
        return id;
      },
      clear: (h: unknown) => {
        queue.delete(h as number);
      },
    },
    pending: () => queue.size,
    advance(to: number) {
      for (;;) {
        let next: [number, { fn: () => void; at: number }] | null = null;
        for (const e of queue) if (e[1].at <= to && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        queue.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = to;
    },
  };
}

/** Counts what reaches the app (a bubbling listener on document). */
function appCounter() {
  const app = { downs: 0, ups: 0, prevented: 0 };
  const onDown = (e: Event) => {
    app.downs += 1;
    if (e.defaultPrevented) app.prevented += 1;
  };
  const onUp = () => {
    app.ups += 1;
  };
  document.addEventListener('keydown', onDown);
  document.addEventListener('keyup', onUp);
  cleanups.push(() => {
    document.removeEventListener('keydown', onDown);
    document.removeEventListener('keyup', onUp);
  });
  return app;
}

function press(
  type: 'keydown' | 'keyup',
  code: number,
  opts: { key?: string; shift?: boolean; repeat?: boolean; target?: EventTarget } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    key: opts.key ?? '',
    shiftKey: opts.shift ?? false,
    repeat: opts.repeat ?? false,
  });
  Object.defineProperty(ev, 'keyCode', { get: () => code });
  Object.defineProperty(ev, 'which', { get: () => code });
  (opts.target ?? document.body).dispatchEvent(ev);
  return ev;
}

const cleanups: Array<() => void> = [];
const listeners: RemoteKeyListener[] = [];

function setup(over: Partial<RemoteKeyListenerDeps> = {}) {
  const c = clock();
  let binding: TvGestureBinding | null = DEFAULT_TV_BINDING;
  let rec: { onKey(e: KeyInput): void } | null = null;
  let swallowKeys = true;
  const onGesture = vi.fn();
  const deps: RemoteKeyListenerDeps = {
    win: window,
    keyMap: createRemoteKeyMap('webos'),
    armedBinding: () => binding,
    swallowKeys: () => swallowKeys,
    onGesture,
    recording: () => rec,
    now: c.now,
    timers: c.timers,
    ...over,
  };
  const listener = installRemoteKeyListener(deps);
  listeners.push(listener);
  return {
    c,
    listener,
    onGesture,
    setBinding(b: TvGestureBinding | null) {
      binding = b;
    },
    setRecording(r: { onKey(e: KeyInput): void } | null) {
      rec = r;
    },
    setSwallow(v: boolean) {
      swallowKeys = v;
    },
  };
}

/** down at 0, repeats every 100 ms up to `until`, up at `until + 50`. */
function hold(s: ReturnType<typeof setup>, code: number, until = 2000) {
  press('keydown', code);
  for (let t = 100; t <= until; t += 100) {
    s.c.advance(t);
    press('keydown', code, { repeat: true });
  }
  s.c.advance(until + 50);
  press('keyup', code);
}

beforeEach(() => {
  document.body.innerHTML = '<input id="field" /><div id="tile" tabindex="0"></div>';
});
afterEach(() => {
  while (listeners.length) listeners.pop()!.dispose();
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('installRemoteKeyListener', () => {
  it('no listener is attached while disarmed', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const s = setup({ armedBinding: () => null });
    expect(add.mock.calls.some(([type]) => type === 'keydown')).toBe(false);
    press('keydown', PP);
    expect(s.onGesture).not.toHaveBeenCalled();
  });

  it('attaches in the capture phase while armed', () => {
    const add = vi.spyOn(window, 'addEventListener');
    setup();
    const keydown = add.mock.calls.find(([type]) => type === 'keydown');
    expect(keydown?.[2]).toBe(true);
    expect(add.mock.calls.some(([type, , opts]) => type === 'keyup' && opts === true)).toBe(true);
  });

  it('rearm detaches the listeners when the config disarms', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const s = setup();
    s.setBinding(null);
    s.listener.rearm();
    expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
    hold(s, PP);
    expect(s.onGesture).not.toHaveBeenCalled();
    // And attaches again when it re-arms.
    s.setBinding(DEFAULT_TV_BINDING);
    s.listener.rearm();
    s.c.advance(10_000);
    press('keydown', PP);
    s.c.advance(11_600);
    expect(s.onGesture).toHaveBeenCalledTimes(1);
  });

  it('a linked TV swallows repeats after a long press fires, but delivers the first keydown and the keyup', () => {
    const s = setup();
    const app = appCounter();
    hold(s, PP);
    expect(app.downs).toBe(15); // first down + repeats before 1500 ms; none after
    expect(app.ups).toBe(1);
    expect(s.onGesture).toHaveBeenCalledTimes(1);
  });

  it('a long press without autorepeat fires from the hold timer', () => {
    const s = setup();
    const app = appCounter();
    press('keydown', PP);
    s.c.advance(1499);
    expect(s.onGesture).not.toHaveBeenCalled();
    s.c.advance(1500);
    expect(s.onGesture).toHaveBeenCalledTimes(1);
    s.c.advance(3000);
    press('keyup', PP);
    expect(app).toMatchObject({ downs: 1, ups: 1 });
    expect(s.c.pending()).toBe(0);
  });

  it('an unlinked TV delivers every event unchanged and still fires the gesture', () => {
    const s = setup();
    s.setSwallow(false);
    const app = appCounter();
    hold(s, PP);
    expect(app.downs).toBe(21);
    expect(app.prevented).toBe(0);
    expect(app.ups).toBe(1);
    expect(s.onGesture).toHaveBeenCalledTimes(1);
  });

  it('the swallow answer is read when the gesture fires and kept until that key is up', () => {
    const s = setup();
    const app = appCounter();
    press('keydown', PP);
    s.c.advance(1500); // fires: linked
    s.setSwallow(false); // e.g. unlinked mid-press
    s.c.advance(1600);
    press('keydown', PP, { repeat: true });
    expect(app.downs).toBe(1);
    press('keyup', PP);
    // The next press reads it again.
    s.c.advance(3000);
    press('keydown', PP);
    s.c.advance(4500);
    s.c.advance(4600);
    press('keydown', PP, { repeat: true });
    expect(app.downs).toBe(3);
  });

  it('a tap and a held D-pad scroll never fire or swallow', () => {
    const s = setup();
    const app = appCounter();
    for (let i = 0; i < 5; i++) {
      s.c.advance(i * 300);
      press('keydown', PP);
      s.c.advance(i * 300 + 120);
      press('keyup', PP);
    }
    s.setBinding({
      kind: 'sequence',
      keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
      windowMs: 1000,
    });
    s.listener.rearm();
    press('keydown', UP);
    for (let i = 0; i < 30; i++) press('keydown', UP, { repeat: true });
    press('keyup', UP);
    press('keydown', DOWN);
    for (let i = 0; i < 30; i++) press('keydown', DOWN, { repeat: true });
    press('keyup', DOWN);
    s.c.advance(10_000);
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(app.prevented).toBe(0);
    expect(app.downs).toBe(5 + 62);
  });

  it('a typing binding stands aside while an input has focus', () => {
    const s = setup();
    s.setBinding({ kind: 'chord', keys: ['SHIFT', 'B'] });
    s.listener.rearm();
    const app = appCounter();
    const field = document.getElementById('field') as HTMLInputElement;
    field.focus();
    press('keydown', SHIFT, { shift: true, target: field });
    press('keydown', B, { shift: true, key: 'B', target: field });
    press('keyup', B, { shift: true, key: 'B', target: field });
    press('keyup', SHIFT, { target: field });
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(app).toMatchObject({ downs: 2, ups: 2, prevented: 0 });
    // Out of the field, the chord works.
    (document.getElementById('tile') as HTMLElement).focus();
    press('keydown', B, { shift: true, key: 'B' });
    expect(s.onGesture).toHaveBeenCalledTimes(1);
    expect(app.downs).toBe(2);
  });

  it('a key that fired before a field took focus stays swallowed until its own keyup', () => {
    const s = setup();
    s.setBinding({ kind: 'chord', keys: ['SHIFT', 'B'] });
    s.listener.rearm();
    const app = appCounter();
    press('keydown', B, { shift: true, key: 'B' });
    expect(s.onGesture).toHaveBeenCalledTimes(1);
    (document.getElementById('field') as HTMLInputElement).focus();
    press('keydown', B, { shift: true, key: 'B', repeat: true });
    press('keyup', B, { shift: true, key: 'B' });
    expect(app).toMatchObject({ downs: 0, ups: 0 });
    // A new B in the field is typing.
    press('keydown', B, { shift: true, key: 'B' });
    expect(app.downs).toBe(1);
    expect(s.onGesture).toHaveBeenCalledTimes(1);
  });

  it('a typing binding stands aside while an input inside a shadow root has focus', () => {
    const s = setup();
    s.setBinding({ kind: 'chord', keys: ['SHIFT', 'B'] });
    s.listener.rearm();
    const app = appCounter();
    // The SDK's own reporter is mounted this way (createHostElement, open shadow root).
    const host = document.createElement('div');
    document.body.appendChild(host);
    const field = document.createElement('input');
    host.attachShadow({ mode: 'open' }).appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(host);
    press('keydown', SHIFT, { shift: true, target: field });
    press('keydown', B, { shift: true, key: 'B', target: field });
    press('keyup', B, { shift: true, key: 'B', target: field });
    press('keyup', SHIFT, { target: field });
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(app).toMatchObject({ downs: 2, ups: 2, prevented: 0 });
  });

  it('a typing binding stands aside for a field in a nested shadow root', () => {
    const s = setup();
    s.setBinding({ kind: 'chord', keys: ['SHIFT', 'B'] });
    s.listener.rearm();
    const outer = document.createElement('div');
    document.body.appendChild(outer);
    const inner = document.createElement('div');
    outer.attachShadow({ mode: 'open' }).appendChild(inner);
    const field = document.createElement('textarea');
    inner.attachShadow({ mode: 'open' }).appendChild(field);
    field.focus();
    const ev = press('keydown', B, { shift: true, key: 'B', target: field });
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a typing binding stands aside when the key event comes from a shadow field without focus', () => {
    const s = setup();
    s.setBinding({ kind: 'chord', keys: ['SHIFT', 'B'] });
    s.listener.rearm();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const field = document.createElement('input');
    host.attachShadow({ mode: 'open' }).appendChild(field);
    // Focus elsewhere; the event's own origin (composedPath()[0]) is the field.
    (document.getElementById('tile') as HTMLElement).focus();
    const ev = press('keydown', B, { shift: true, key: 'B', target: field });
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a pending hold of a typing key does not fire once a shadow-root field has focus', () => {
    const s = setup();
    s.setBinding({ kind: 'longPress', keys: ['B'], holdMs: 1500 });
    s.listener.rearm();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const field = document.createElement('input');
    host.attachShadow({ mode: 'open' }).appendChild(field);
    press('keydown', B, { key: 'b' });
    field.focus();
    s.c.advance(1600);
    expect(s.onGesture).not.toHaveBeenCalled();
  });

  it('key-only events (keyCode 0) keep a distinct identity per key, so a chord completes', () => {
    const s = setup();
    s.setBinding({ kind: 'chord', keys: ['PROG_RED', 'PROG_BLUE'] });
    s.listener.rearm();
    const app = appCounter();
    press('keydown', 0, { key: 'ColorF0Red' });
    const blue = press('keydown', 0, { key: 'ColorF3Blue' });
    expect(s.onGesture).toHaveBeenCalledTimes(1);
    expect(blue.defaultPrevented).toBe(true);
    // Blue's keyup is swallowed with it; Red's is the app's.
    expect(press('keyup', 0, { key: 'ColorF3Blue' }).defaultPrevented).toBe(true);
    expect(press('keyup', 0, { key: 'ColorF0Red' }).defaultPrevented).toBe(false);
    expect(app).toMatchObject({ downs: 1, ups: 1 });
  });

  it('key-only events that are not contract keys do not collide with each other', () => {
    const s = setup();
    s.setBinding({
      kind: 'sequence',
      keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
      windowMs: 1000,
    });
    s.listener.rearm();
    // An unmapped key held while ↑ is pressed must not make ↑ look like a repeat.
    press('keydown', 0, { key: 'Unidentified' });
    press('keydown', 0, { key: 'ArrowUp' });
    press('keyup', 0, { key: 'ArrowUp' });
    press('keydown', 0, { key: 'ArrowUp' });
    press('keyup', 0, { key: 'ArrowUp' });
    press('keydown', 0, { key: 'ArrowDown' });
    press('keyup', 0, { key: 'ArrowDown' });
    press('keydown', 0, { key: 'ArrowDown' });
    expect(s.onGesture).toHaveBeenCalledTimes(1);
  });

  it('a recording keeps every key-only press', () => {
    const s = setup({ armedBinding: () => null });
    const recorder = new GestureRecorder();
    s.setRecording(recorder);
    s.listener.rearm();
    press('keydown', 0, { key: 'ColorF0Red' });
    s.c.advance(100);
    press('keydown', 0, { key: 'ColorF3Blue' });
    s.c.advance(200);
    press('keyup', 0, { key: 'ColorF3Blue' });
    s.c.advance(300);
    press('keyup', 0, { key: 'ColorF0Red' });
    expect(recorder.finish(1000)).toEqual([
      { key: 'PROG_RED', downMs: 0, upMs: 300 },
      { key: 'PROG_BLUE', downMs: 100, upMs: 200 },
    ]);
  });

  it('a pending hold does not fire after the binding changes or a recording starts', () => {
    const s = setup();
    press('keydown', PP);
    s.setBinding({ kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 3000 });
    s.c.advance(1500);
    expect(s.onGesture).not.toHaveBeenCalled();
    press('keyup', PP);

    const r = setup();
    r.c.advance(100);
    press('keydown', PP);
    r.setRecording({ onKey: () => undefined });
    r.c.advance(1600);
    expect(r.onGesture).not.toHaveBeenCalled();

    const g = setup();
    press('keydown', PP);
    g.setBinding(null);
    g.c.advance(1500);
    expect(g.onGesture).not.toHaveBeenCalled();
    // s's second listener saw nothing either.
    expect(s.onGesture).not.toHaveBeenCalled();
  });

  it('a pending hold of a typing key does not fire once a text field has focus', () => {
    const s = setup();
    s.setBinding({ kind: 'longPress', keys: ['B'], holdMs: 1500 });
    s.listener.rearm();
    press('keydown', B, { key: 'b' });
    (document.getElementById('field') as HTMLInputElement).focus();
    s.c.advance(1600);
    expect(s.onGesture).not.toHaveBeenCalled();
  });

  it('while recording every key goes to the recorder and reaches the app unchanged', () => {
    const s = setup();
    const seen: KeyInput[] = [];
    s.setRecording({ onKey: (e) => seen.push(e) });
    const app = appCounter();
    hold(s, PP);
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(app).toMatchObject({ downs: 21, ups: 1, prevented: 0 });
    expect(seen).toHaveLength(22);
    expect(seen[0]).toMatchObject({ type: 'down', name: 'MEDIA_PLAY_PAUSE', code: PP, atMs: 0 });
    expect(seen[21]).toMatchObject({ type: 'up', code: PP, atMs: 2050 });
  });

  it('a recording keeps the listener attached while disarmed', () => {
    const s = setup({ armedBinding: () => null });
    const seen: KeyInput[] = [];
    s.setRecording({ onKey: (e) => seen.push(e) });
    s.listener.rearm();
    press('keydown', UP, { key: 'ArrowUp' });
    expect(seen).toHaveLength(1);
  });

  it('blur and visibilitychange to hidden cancel a pending hold', () => {
    const s = setup();
    press('keydown', PP);
    window.dispatchEvent(new Event('blur'));
    s.c.advance(1600);
    expect(s.onGesture).not.toHaveBeenCalled();
    // The held state is gone too: a late repeat does not fire.
    press('keydown', PP, { repeat: true });
    expect(s.onGesture).not.toHaveBeenCalled();
    press('keyup', PP);

    s.c.advance(5000);
    press('keydown', PP);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vis.mockRestore();
    s.c.advance(7000);
    expect(s.onGesture).not.toHaveBeenCalled();
  });

  it('a rearm with an equal binding keeps a press in progress', () => {
    const s = setup();
    press('keydown', PP);
    s.c.advance(800);
    s.setBinding({ kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 });
    s.listener.rearm();
    s.c.advance(1500);
    expect(s.onGesture).toHaveBeenCalledTimes(1);
  });

  it('dispose detaches and cancels the hold', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const s = setup();
    press('keydown', PP);
    s.listener.dispose();
    s.c.advance(2000);
    expect(s.onGesture).not.toHaveBeenCalled();
    expect(remove.mock.calls.some(([type]) => type === 'keyup')).toBe(true);
  });

  it('a throwing dependency never reaches the host', () => {
    const s = setup({
      onGesture: () => {
        throw new Error('boom');
      },
      swallowKeys: () => {
        throw new Error('boom');
      },
    });
    expect(() => hold(s, PP)).not.toThrow();
  });
});
