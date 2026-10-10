// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Runs the smart-TV capture path on a real TV N times and reports timings and
// outcomes to the harness server (POST /results). Local fixtures only.
import './polyfills.js';
import { RENDER_META_HEADER, RENDER_PATH } from '@everframe/protocol';
import { init } from '../../src/index.js';

const params = new URLSearchParams(location.search);
const RUNS = Number(params.get('runs') ?? 3);
// `snapdom` = the TV's own on-device capture (adapter.captureScreenshot), for the
// spec's fidelity comparison against the server render of the same screen.
const MODE = params.get('mode') === 'snapdom' ? 'snapdom' : 'snapshot';
const out = document.getElementById('log')!;
const log = (m: string): void => { out.textContent += `${m}\n`; };
window.addEventListener('error', (e) => log(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${String((e as PromiseRejectionEvent).reason)}`));

// Observe the SDK's own POST /api/render (it reads `fetch` when a shot starts,
// after this wrapper is in place) so each result carries the server's render
// meta and the round-trip time. Harness-only; the SDK does not expose them.
interface RenderObservation { status: number; ms: number; meta: unknown }
let lastRender: RenderObservation | null = null;
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.indexOf(RENDER_PATH) === -1) return realFetch(input, init);
  const t0 = performance.now();
  return realFetch(input, init).then((res) => {
    let meta: unknown = null;
    try { meta = JSON.parse(res.headers.get(RENDER_META_HEADER) ?? 'null'); } catch { meta = 'unparseable'; }
    lastRender = { status: res.status, ms: Math.round(performance.now() - t0), meta };
    return res;
  });
};

const handle = init({ sdkKey: params.get('sdkKey') ?? '', appVersion: '0.0.0-device' }) as unknown as {
  open(): Promise<unknown>;
  __adapter: {
    __tvSnapshotPathActive(): boolean;
    captureScreenshot(): Promise<{ blob: Blob; width: number; height: number; degradedReason?: string }>;
    __captureShot(): Promise<{ image?: { blob: Blob; width: number; height: number }; snapshot?: { bytes: Uint8Array; byteLength: number }; degradedReason?: string }>;
  };
};
// The harness page's "Report" button files a real report through the in-app reporter.
(window as unknown as { __everframeHandle: typeof handle }).__everframeHandle = handle;

async function waitActive(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (handle.__adapter.__tvSnapshotPathActive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(b); });
}

async function run(): Promise<void> {
  log(navigator.userAgent);
  if (RUNS === 0) return;
  if (MODE === 'snapshot' && !(await waitActive())) { log('screenshotRender never became true — check /api/config'); return; }
  // Let the posters and the webfont load before the first shot.
  await new Promise((r) => setTimeout(r, 2000));
  (document.getElementById('tile-2') as HTMLElement).focus();
  for (let i = 0; i < RUNS; i++) {
    let longest = 0; let last = performance.now(); let stop = false;
    const tick = (): void => { const t = performance.now(); longest = Math.max(longest, t - last); last = t; if (!stop) setTimeout(tick, 0); };
    setTimeout(tick, 0);
    lastRender = null;
    const t0 = performance.now();
    let shot: Awaited<ReturnType<typeof handle.__adapter.__captureShot>>;
    let error: string | null = null;
    try {
      shot =
        MODE === 'snapdom'
          ? await handle.__adapter.captureScreenshot().then((image) => ({ image, degradedReason: image.degradedReason }))
          : await handle.__adapter.__captureShot();
    } catch (e) {
      shot = {};
      error = String(e);
    }
    const total = performance.now() - t0;
    stop = true;
    const result = {
      run: i, mode: MODE, ua: navigator.userAgent, secureContext: window.isSecureContext === true, totalMs: Math.round(total), longestBlockMs: Math.round(longest),
      outcome: shot.image ? 'image' : shot.snapshot ? 'snapshot' : 'unavailable', reason: shot.degradedReason ?? null, error,
      snapshotKB: shot.snapshot ? Math.round(shot.snapshot.byteLength / 102.4) / 10 : null,
      render: lastRender,
      image: shot.image ? { w: shot.image.width, h: shot.image.height, webp: await blobToBase64(shot.image.blob) } : null,
      snapshot: shot.snapshot ? await blobToBase64(new Blob([shot.snapshot.bytes as BlobPart])) : null,
    };
    log(`run ${i}: ${result.outcome} ${result.totalMs} ms, block ${result.longestBlockMs} ms, ${result.snapshotKB} KB${error ? ` ${error}` : ''}`);
    await fetch('/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    await new Promise((r) => setTimeout(r, 1500));
  }
  log('done');
}
void run();
