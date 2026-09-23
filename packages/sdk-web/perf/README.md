<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Vitals perf harness

Re-runs the measurement that produced [PR #169](https://github.com/scriptx-com/everframe/pull/169)'s
perf numbers (session vitals, Phase 1) as a repo script, per
`the public behavior contract` §5, so the gate
can be re-taken before each release instead of living only in a session
scratch directory.

## Run it

```sh
pnpm --filter @everframe/web build
pnpm --filter @everframe/web perf:vitals
```

The build step is required — the harness loads the **built** browser bundle
(`dist/browser/index.js`), not source. A default run takes both modes
(`off` then `on`) at 60 s each, so budget about two and a half minutes.

A third mode, `hls`, swaps the muted looping webm for a real hls.js instance
streaming an adaptive test manifest — Phase 4 added per-player listeners, an
integration event bus, and a periodic stats entry per player, so it's worth
re-measuring against a real adaptive stream rather than assuming the
webm-only numbers still hold:

```sh
MODES=off,on,hls pnpm --filter @everframe/web perf:vitals
```

This is a **manual run, not CI** — it needs outbound network access to the
default stream (`https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`, a public
Mux HLS test asset). Override it with `HLS_URL=` if that stream is
unreachable. hls.js itself retains buffered segments as normal player memory,
which can dominate the raw `hls` mode's heap delta and make it useless as a
signal on its own — add `hls-off` (same page, vitals gate off) alongside
`hls` for an honest `hls − hls-off` vitals-attributable delta:

```sh
MODES=hls,hls-off pnpm --filter @everframe/web perf:vitals
```

Env overrides:

- `RUN_MS` — window length per mode in ms (default `60000`)
- `MODES` — comma-separated list of modes to run (default `off,on`; also
  accepts `hls` and `hls-off`)
- `PERF_PORT` — static server port (default `8931`)
- `HLS_URL` — override the default hls.js test stream (`hls`/`hls-off` modes
  only)

## What it measures

Headless Chromium (Playwright's bundled build) drives `harness.html`, a
static page whose only JavaScript is the built `@everframe/web` browser
bundle's `init()` plus one muted, looping `<video>` (the example app's
`examples/react-web/public/media/field-loop.webm`). Every `/api/**` request
is answered by a Playwright route stub: `GET /api/config` returns
`vitalsEnabled: true|false` (the authoritative server gate — same flip as the
DB column), `POST /api/ingest/vitals` returns 204. No real backend is
involved.

Identical stimulus in both modes: a seek every 10 s and a pause/play every
20 s across the run window. Long tasks are read from a
`PerformanceObserver({ type: 'longtask' })` in-page **and** from a Chrome
trace (`devtools.timeline`, every `RunTask` > 50 ms attributed to its
costliest children). Heap is read via `performance.memory.usedJSHeapSize`
immediately after `HeapProfiler.collectGarbage`, at t≈5 s and t≈(5+`RUN_MS`) s,
so the delta is steady-state retention rather than pre-GC garbage.

`static-server.mjs` serves `/dist/**` from `packages/sdk-web/dist`,
`/media/**` from `examples/react-web/public/media`, `/vendor/hls.js` from
hls.js's own minified dist build (a devDependency of `@everframe/web` used
only by this harness — never a runtime dependency of the shipped SDK), and
everything else (`/harness.html`, `/harness-hls.html`) from this `perf/`
directory; `vitals-harness.mjs` starts it in-process and shuts it down (and
closes the browser) whether the run succeeds or fails.

Per-mode results are also written to `result-<mode>.json` next to this file
(gitignored — local debugging aid, not a build artifact).

## The gate

From the session-vitals spec:

- **No added long task > 50 ms.** Long-task count and every trace `RunTask` >
  50 ms must be unchanged between `off` and `on` (both are expected to be
  zero on a healthy run).
- **Vitals-attributable steady-state heap growth under 64 KB** — the `on`
  mode's post-GC heap delta minus the `off` mode's, over the run window. 64
  KB is the vitals collector's own byte cap (see `VitalsCollector` in
  `@everframe/sdk-core`), so this checks the collector isn't retaining beyond
  its own budget.

## Last run (2026-09-02)

Chromium 147.0.7727.15 (Playwright 1.59.1's bundled build), headless, on the
`feature/session-vitals-phase-3` branch, `RUN_MS=60000` (default),
`MODES=off,on` (default). Table pasted verbatim from the historical perf
command's own printed output.

| | vitals **off** | vitals **on** |
|---|---|---|
| Long tasks (> 50 ms) observed in 60 s | 0 | 0 |
| Trace `RunTask`s > 50 ms | 0 | 0 |
| JS time attributed to the SDK bundle in 60 s | 0.1 ms | 9.5 ms |
| Longest single SDK function call | 0.05 ms | 3.48 ms |
| Heap after forced GC, start → end | +13.5 KB | +48.4 KB |
| Sampled peak heap | 8.96 MB | 8.91 MB |
| Vitals POSTs seen by the stub | 0 (0 B) | 3 (4475 B) |
| **Vitals-attributable steady-state heap growth (on − off)** | — | **+35.0 KB** |

Gate: **passes** — 0 long tasks in either mode (both the in-page
`longtask` observer and the trace's `RunTask` attribution agree), and the
vitals-attributable steady-state heap growth (+35.0 KB) is comfortably under
the 64 KB collector cap.

## Last run (2026-09-03, with hls.js)

Chromium 147.0.7727.15 (Playwright 1.59.1's bundled build), headless, on the
`feature/session-vitals-phase-4` branch, `RUN_MS=60000` (default),
`MODES=off,on,hls,hls-off`. Phase 4 added per-player listeners, an
integration event bus, and a periodic stats entry per player, so this
re-measures against a real adaptive stream (the default Mux HLS test asset)
rather than assuming the phase-3 webm-only numbers still hold. `hls-off` was
added because the raw `hls` mode's heap delta is dominated by hls.js's own
buffered-segment retention (see the negative deltas below — normal player
memory churn, not an SDK leak), so `hls − hls-off` is the only reading that
isolates the SDK's own contribution. Table pasted verbatim from the historical
perf command's own printed output.

| | vitals **off** | vitals **on** | vitals **on** (hls) | vitals **off** (hls) |
|---|---|---|---|---|
| Long tasks (> 50 ms) observed in 60 s | 0 | 0 | 0 | 0 |
| Trace `RunTask`s > 50 ms | 0 | 0 | 0 | 0 |
| JS time attributed to the SDK bundle in 60 s | 0.2 ms | 11.3 ms | 7.2 ms | 1.5 ms |
| Longest single SDK function call | 0.19 ms | 2.14 ms | 1.59 ms | 0.34 ms |
| Heap after forced GC, start → end | +13.5 KB | +51.6 KB | -169.8 KB | -186.6 KB |
| Sampled peak heap | 9.16 MB | 9.24 MB | 37.04 MB | 25.42 MB |
| Vitals POSTs seen by the stub | 0 (0 B) | 3 (5895 B) | 3 (5326 B) | 0 (0 B) |
| **Vitals-attributable steady-state heap growth (on − off)** | — | **+38.2 KB** | — | — |
| **Vitals-attributable steady-state heap growth (hls − hls-off)** | — | — | **+16.8 KB** | — |

Gate: **passes**, including with a real adaptive stream. 0 long tasks in all
four modes. The webm-only vitals-attributable delta (+38.2 KB) is in line
with the phase-3 run (+35.0 KB) — the phase 4 additions (per-player
listeners, the integration event bus, periodic per-player stats) did not
move it meaningfully. The hls-specific delta (+16.8 KB) is also comfortably
under the 64 KB cap, and lower than the webm figure — plausible, since the
`hls` page tracks one player against a real adaptive stream rather than
exercising the exact same webm-loop stimulus the `on`/`off` pair uses; it is
not a like-for-like comparison across the two pairs, only within each pair.
Note the raw (non-delta) `hls`/`hls-off` heap rows are both negative and are
**not** meaningful signals about the SDK on their own — hls.js's own
buffer-eviction behavior over the 60 s window dominates them in either
direction, which is exactly why the `hls-off` baseline exists.
