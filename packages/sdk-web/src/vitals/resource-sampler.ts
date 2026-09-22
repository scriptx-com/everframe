// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Periodic resource sampler for Session Vitals (web). Feeds
// VitalsCollector.recordSample with heap usage, accumulated long-task time,
// and event-loop lag observed since the previous tick. Skips entirely while
// the tab is hidden (backgrounded/bfcached tabs would otherwise report
// meaningless heap/lag numbers). PerformanceObserver('longtask') is
// unsupported in jsdom and some browsers — construction is try/catch guarded
// so its absence degrades to `longTaskMs: 0` rather than throwing.
import { safeWrap } from '@traceitx/sdk-core';

export interface ResourceSample {
  t: number;
  mem: number;
  extras: Record<string, number>;
}

export interface ResourceSamplerDeps {
  onSample(s: ResourceSample): void;
  intervalMs?: number; // default 20_000
  now?(): number; // default Date.now
}

const DEFAULT_INTERVAL_MS = 20_000;

export function startResourceSampler(deps: ResourceSamplerDeps): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());

  let longTaskMs = 0;
  let observer: PerformanceObserver | undefined;
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskMs += entry.duration;
        }
      });
      observer.observe({ type: 'longtask', buffered: false });
    }
  } catch {
    observer = undefined;
  }

  let lastTick = now();

  // Codex round-2 finding R10 — after a BFCache restore or a browser/OS
  // freeze (tab backgrounded long enough to be suspended, then resumed),
  // `lastTick` is still whatever it was before the freeze: the FIRST tick
  // after resume would compute `actualElapsed` across the entire frozen
  // gap, reporting that whole gap as `loopLagMs` — a meaningless number, not
  // actual event-loop lag. Resetting the baseline on the signals that mark
  // "the page just came back" (`visibilitychange` -> visible, and
  // `pageshow` — which fires on a BFCache restore even when
  // `visibilitychange` does not) makes the next tick measure lag over its
  // own normal interval instead of the freeze.
  function resetBaseline(): void {
    lastTick = now();
    longTaskMs = 0;
  }

  function onVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      resetBaseline();
    }
  }

  function onPageShow(): void {
    resetBaseline();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', onPageShow);
  }

  const tick = safeWrap(
    () => {
      const current = now();
      const actualElapsed = current - lastTick;
      lastTick = current;

      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        longTaskMs = 0;
        return;
      }

      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? 0;
      const loopLagMs = Math.max(0, actualElapsed - intervalMs);
      const extras: Record<string, number> = { longTaskMs, loopLagMs };
      longTaskMs = 0;

      deps.onSample({ t: current, mem, extras });
    },
    { name: 'vitals.resourceSampler.tick' },
  );

  const timer = setInterval(tick, intervalMs);

  return () => {
    clearInterval(timer);
    observer?.disconnect();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', onPageShow);
    }
  };
}
