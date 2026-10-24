// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Key-delivery spike page for TV engines. Logs every keydown/keyup that reaches
// the page (capture phase on window) as {type, key, code, keyCode, repeat,
// dtMs, focus}, plus the play/pause events of a playing <video>, and POSTs the
// lines to the harness server (/results). On Tizen it first dumps
// tizen.tvinputdevice.getSupportedKeys() and registers every key the quick
// capture key map can use. No SDK code runs here.
//
//   /keys.html?focus=tile   focus on a tile (default)
//   /keys.html?focus=video  focus on the playing <video>
import './polyfills.js';

interface TizenKey {
  name: string;
  code: number;
}
interface TizenInputDevice {
  getSupportedKeys?(): TizenKey[];
  registerKey?(name: string): void;
}

// Task 12's registrable Tizen names (Menu, media, color and digit keys).
const TIZEN_KEYS = [
  'MediaPlayPause',
  'MediaPlay',
  'MediaPause',
  'MediaFastForward',
  'MediaRewind',
  'ColorF0Red',
  'ColorF1Green',
  'ColorF2Yellow',
  'ColorF3Blue',
  'Menu',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
];

const params = new URLSearchParams(location.search);
const FOCUS = params.get('focus') === 'video' ? 'video' : 'tile';
const out = document.getElementById('log') as HTMLElement;
const video = document.getElementById('video') as HTMLVideoElement;
(document.getElementById('mode') as HTMLElement).textContent =
  `focus=${FOCUS} · ${navigator.userAgent}`;

let pending: unknown[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function post(body: unknown): void {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/results');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify(body));
}
function flush(): void {
  flushTimer = null;
  if (pending.length === 0) return;
  const lines = pending;
  pending = [];
  post({ kind: 'keys', ua: navigator.userAgent, focus: FOCUS, lines });
}
function record(line: Record<string, unknown>): void {
  pending.push(line);
  const text = JSON.stringify(line);
  out.textContent = `${text}\n${(out.textContent ?? '').slice(0, 4000)}`;
  if (flushTimer === null) flushTimer = setTimeout(flush, 500);
}

let t0: number | null = null;
const dt = (): number => {
  const now = performance.now();
  if (t0 === null) t0 = now;
  return Math.round(now - t0);
};

function onKey(e: KeyboardEvent): void {
  const target = document.activeElement;
  record({
    type: e.type,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    which: e.which,
    repeat: e.repeat,
    shift: e.shiftKey,
    dtMs: dt(),
    focus: target ? target.id || target.tagName : null,
  });
}
window.addEventListener('keydown', onKey, true);
window.addEventListener('keyup', onKey, true);
window.addEventListener('blur', () => record({ type: 'blur', dtMs: dt() }));
document.addEventListener('visibilitychange', () =>
  record({ type: 'visibilitychange', state: document.visibilityState, dtMs: dt() }),
);
video.addEventListener('play', () => record({ type: 'video', event: 'play', dtMs: dt() }));
video.addEventListener('pause', () => record({ type: 'video', event: 'pause', dtMs: dt() }));

// A playing video without a media file: a canvas stream (Chrome 51+).
function startVideo(): void {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d');
  const stream = (canvas as HTMLCanvasElement & { captureStream?(fps: number): MediaStream })
    .captureStream;
  if (!ctx || typeof stream !== 'function') {
    record({ type: 'video', event: 'unsupported' });
    return;
  }
  let frame = 0;
  setInterval(() => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 7) % 360}, 60%, 40%)`;
    ctx.fillRect(0, 0, 160, 90);
  }, 100);
  video.srcObject = stream.call(canvas, 10);
  const played = video.play() as Promise<void> | undefined;
  if (played && typeof played.then === 'function') {
    played.then(undefined, (err: unknown) =>
      record({ type: 'video', event: 'play-rejected', error: String(err) }),
    );
  }
}

function tizenDevice(): TizenInputDevice | null {
  try {
    const t = (window as unknown as { tizen?: { tvinputdevice?: TizenInputDevice } }).tizen;
    return t && t.tvinputdevice ? t.tvinputdevice : null;
  } catch {
    return null;
  }
}

const tv = tizenDevice();
if (tv) {
  let supported: TizenKey[] = [];
  try {
    supported = tv.getSupportedKeys ? tv.getSupportedKeys() : [];
  } catch (err) {
    post({ kind: 'tizen', error: String(err) });
  }
  const registered: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const name of TIZEN_KEYS) {
    if (!supported.some((k) => k.name === name)) continue;
    try {
      if (tv.registerKey) tv.registerKey(name);
      registered.push({ name, ok: true });
    } catch (err) {
      registered.push({ name, ok: false, error: String(err) });
    }
  }
  post({
    kind: 'tizen',
    ua: navigator.userAgent,
    supported: supported.map((k) => ({ name: k.name, code: k.code })),
    registered,
  });
}

startVideo();
const focusTarget = FOCUS === 'video' ? video : (document.getElementById('tile-1') as HTMLElement);
focusTarget.focus();
record({ type: 'ready', focus: FOCUS, dtMs: dt() });
