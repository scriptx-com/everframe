// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vitals perf harness — reruns the measurement that produced PR #169's perf
// numbers (see `the public behavior contract`
// §5) as a repo script, so the gate can be re-taken before each release
// instead of living only in a session scratch directory.
//
// Drives a static page (`harness.html`) that loads the BUILT
// `@traceitx/web` browser bundle and plays a looping muted `<video>` in
// headless Chromium, once with the server-driven vitals gate reporting
// `vitalsEnabled: false` and once `true`. Every `/api/**` call is answered by
// a Playwright route stub — no real backend involved. See README.md for the
// full method and the gate this guards.
//
// A third mode, `hls`, swaps the stimulus page for `harness-hls.html`: a
// real hls.js instance streaming an adaptive test manifest, tracked via
// `trackPlayer()` — Phase 4 added per-player listeners, an integration event
// bus, and a periodic stats entry per player, so this re-measures against a
// real adaptive stream rather than assuming the phase-3 numbers still hold.
// `hls-off` is the same page with the vitals gate off, for an honest
// vitals-attributable delta if the raw `hls` heap number looks high (hls.js
// itself retains buffered segments — that's normal player memory, not an
// SDK leak, and only a hls-vs-hls-off comparison can tell them apart).
//
// Usage: `pnpm --filter @traceitx/web build && pnpm --filter @traceitx/web perf:vitals`
// Env: RUN_MS (default 60000), MODES (default "off,on"), PERF_PORT (default 8931),
//      HLS_URL (default a public Mux HLS test stream; used by `hls`/`hls-off`).
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PERF_PORT ?? 8931);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_MS = Number(process.env.RUN_MS ?? 60_000);
const MODES = (process.env.MODES ?? 'off,on').split(',').map((m) => m.trim()).filter(Boolean);
const MODE_LABEL = {
  off: 'vitals **off**',
  on: 'vitals **on**',
  hls: 'vitals **on** (hls)',
  'hls-off': 'vitals **off** (hls)',
};
// Modes whose page is the hls.js stimulus (harness-hls.html) rather than the
// looping-webm stimulus (harness.html).
const HLS_MODES = new Set(['hls', 'hls-off']);
// Modes that report the server-driven vitals gate as enabled.
const VITALS_ON_MODES = new Set(['on', 'hls']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

async function runMode(mode) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'],
  });
  try {
    const page = await browser.newPage();
    const api = { config: 0, vitalsPosts: 0, vitalsBytes: 0, other: [] };
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (url.pathname.endsWith('/api/config')) {
        api.config++;
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            vitalsEnabled: VITALS_ON_MODES.has(mode),
            vitalsSampleRate: 1,
          }),
        });
      }
      if (url.pathname.endsWith('/api/ingest/vitals')) {
        api.vitalsPosts++;
        api.vitalsBytes += req.postDataBuffer()?.length ?? 0;
        return route.fulfill({ status: 204, headers: CORS });
      }
      api.other.push(`${req.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' });
    });
    await page.addInitScript(() => {
      window.__lt = [];
      window.__mem = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lt.push({ s: Math.round(e.startTime), d: Math.round(e.duration) });
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        // longtask PerformanceObserver unsupported — long-task count stays 0,
        // the trace-based RunTask attribution below still covers the gate.
      }
      setInterval(() => {
        const m = performance.memory;
        if (m) window.__mem.push({ t: Math.round(performance.now()), used: m.usedJSHeapSize });
      }, 5000);
    });
    if (HLS_MODES.has(mode) && process.env.HLS_URL) {
      await page.addInitScript((url) => {
        window.__HLS_URL = url;
      }, process.env.HLS_URL);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const gcHeap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await sleep(300);
      return page.evaluate(() => performance.memory.usedJSHeapSize);
    };

    await browser.startTracing(page, {
      categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute'],
    });
    const harnessFile = HLS_MODES.has(mode) ? 'harness-hls.html' : 'harness.html';
    await page.goto(`${BASE}/${harnessFile}`);
    await page.waitForFunction(
      () => {
        const v = document.getElementById('v');
        return v && !v.paused && v.readyState >= 3;
      },
      null,
      { timeout: 30_000 },
    );
    await sleep(5000);
    const heapStart = await gcHeap();
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < RUN_MS) {
      await sleep(10_000);
      i++;
      // Light, identical stimulus in both modes: a seek every 10s, a
      // pause/play every 20s — enough to keep the page's own JS graph busy
      // without that activity swamping the SDK's own contribution.
      await page.evaluate((i) => {
        const v = document.getElementById('v');
        v.currentTime = (i * 1.7) % Math.max(1, v.duration || 1);
        if (i % 2 === 0) {
          v.pause();
          setTimeout(() => v.play().catch(() => {}), 500);
        }
      }, i);
    }
    const heapEnd = await gcHeap();
    const trace = JSON.parse((await browser.stopTracing()).toString());
    const lt = await page.evaluate(() => window.__lt);
    const mem = await page.evaluate(() => window.__mem);

    // Attribute long RunTasks (> 50 ms) from the trace to their costliest
    // children, the same way #169's numbers were read off.
    const ev = trace.traceEvents.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
    const tasks = ev.filter((e) => e.name === 'RunTask' && e.dur / 1000 > 50);
    const attributed = tasks.map((t) => {
      const kids = ev
        .filter(
          (k) =>
            k !== t &&
            k.pid === t.pid &&
            k.tid === t.tid &&
            k.ts >= t.ts &&
            k.ts + k.dur <= t.ts + t.dur &&
            ['FunctionCall', 'TimerFire', 'EventDispatch', 'EvaluateScript', 'v8.compile', 'MajorGC', 'MinorGC', 'ParseHTML', 'UpdateLayoutTree', 'Layout', 'Paint'].includes(k.name),
        )
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 4)
        .map((k) => ({ name: k.name, ms: +(k.dur / 1000).toFixed(1), url: k.args?.data?.url ?? k.args?.data?.type ?? '' }));
      return { ms: +(t.dur / 1000).toFixed(1), kids };
    });
    const sdkFn = ev.filter((k) => k.name === 'FunctionCall' && String(k.args?.data?.url ?? '').includes('/dist/'));
    const sdkMs = sdkFn.reduce((a, k) => a + k.dur / 1000, 0);
    const sdkMax = sdkFn.reduce((a, k) => Math.max(a, k.dur / 1000), 0);
    const peak = Math.max(0, ...mem.map((m) => m.used));
    const out = {
      mode,
      runMs: RUN_MS,
      api,
      longTasks: { count: lt.length, maxMs: Math.max(0, ...lt.map((e) => e.d)), totalMs: lt.reduce((a, e) => a + e.d, 0), entries: lt },
      traceTasksOver50: attributed,
      sdkFunctionCalls: { count: sdkFn.length, totalMs: +sdkMs.toFixed(1), maxMs: +sdkMax.toFixed(2) },
      heap: { afterGcStart: heapStart, afterGcEnd: heapEnd, steadyDelta: heapEnd - heapStart, sampledPeak: peak, samples: mem.length },
    };
    // Gitignored (see .gitignore's `packages/sdk-web/perf/result-*.json`) —
    // kept for local debugging of a single run, not a build artifact.
    await writeFile(`${HERE}/result-${mode}.json`, JSON.stringify(out, null, 2));
    return out;
  } finally {
    await browser.close();
  }
}

function fmtHeap(bytes) {
  return `${bytes >= 0 ? '+' : ''}${(bytes / 1024).toFixed(1)} KB`;
}

function printTable(results) {
  const seconds = Math.round(RUN_MS / 1000);
  const modes = MODES.filter((m) => results[m]);
  const header = `| | ${modes.map((m) => MODE_LABEL[m] ?? `vitals **${m}**`).join(' | ')} |`;
  const sep = `|---|${modes.map(() => '---').join('|')}|`;
  const row = (label, fn) => `| ${label} | ${modes.map((m) => fn(results[m])).join(' | ')} |`;

  const lines = [
    header,
    sep,
    row(`Long tasks (> 50 ms) observed in ${seconds} s`, (r) => r.longTasks.count),
    row('Trace `RunTask`s > 50 ms', (r) => r.traceTasksOver50.length),
    row(`JS time attributed to the SDK bundle in ${seconds} s`, (r) => `${r.sdkFunctionCalls.totalMs} ms`),
    row('Longest single SDK function call', (r) => `${r.sdkFunctionCalls.maxMs} ms`),
    row('Heap after forced GC, start → end', (r) => fmtHeap(r.heap.steadyDelta)),
    row('Sampled peak heap', (r) => `${(r.heap.sampledPeak / 1024 / 1024).toFixed(2)} MB`),
    row('Vitals POSTs seen by the stub', (r) => `${r.api.vitalsPosts} (${r.api.vitalsBytes} B)`),
  ];

  // Vitals-attributable steady-state heap growth: an on/off pair, so the
  // delta isolates the SDK's own retention from whatever the stimulus page
  // (looping webm, or hls.js buffering segments) retains on its own.
  const pairs = [
    ['on', 'off', 'on − off'],
    ['hls', 'hls-off', 'hls − hls-off'],
  ];
  for (const [onMode, offMode, label] of pairs) {
    if (!results[onMode] || !results[offMode]) continue;
    const delta = results[onMode].heap.steadyDelta - results[offMode].heap.steadyDelta;
    const cells = modes.map((m) => (m === onMode ? `**${fmtHeap(delta)}**` : '—'));
    lines.push(`| **Vitals-attributable steady-state heap growth (${label})** | ${cells.join(' | ')} |`);
  }

  return lines.join('\n');
}

const results = {};
try {
  const server = await startServer(PORT);
  try {
    for (const mode of MODES) {
      console.log(`--- running mode "${mode}" for ${RUN_MS}ms ---`);
      results[mode] = await runMode(mode);
      console.log(JSON.stringify({ ...results[mode], longTasks: { ...results[mode].longTasks, entries: undefined } }, null, 1));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} catch (err) {
  console.error('perf harness run failed:', err);
  process.exitCode = 1;
}

if (Object.keys(results).length > 0) {
  console.log('\n' + printTable(results) + '\n');
}
