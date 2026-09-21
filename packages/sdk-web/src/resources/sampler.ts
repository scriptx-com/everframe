// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — periodic resource sampler
// feeding the ring in ring.ts. Skips entirely while the tab is hidden
// (backgrounded/bfcached tabs would otherwise report meaningless heap/lag
// numbers). PerformanceObserver('longtask') is unsupported in jsdom and some
// browsers — construction is try/catch guarded so its absence degrades to
// `longTaskMs: 0` rather than throwing.
//
// DELIBERATELY a standalone reimplementation, not an import of
// `vitals/resource-sampler.ts` — Session Vitals is a separate, unmodified
// feature (see this package's Global Constraints) and the two must stay
// decoupled even though the tick logic (long-task accumulation, loop-lag
// measurement, the visibilitychange/pageshow baseline reset) is the same
// shape. `vitals/resource-sampler.ts` is read-only reference material here,
// never imported.
//
// No `cpu` field, ever — there is no browser CPU API. `ResourceSampleT`
// leaves `cpu` optional so native SDKs can populate it; the web sampler must
// never even set it to `undefined` (that would still be an own-enumerable
// key on the emitted object) — it is simply omitted from the object literal.
import { safeWrap } from '@traceitx/sdk-core';
import { RESOURCE_SAMPLE_INTERVAL_MS } from '@traceitx/protocol';
import type { ResourceSampleT } from '@traceitx/protocol';

export interface ResourceSamplerDeps {
  onSample(s: ResourceSampleT): void;
  /** Defaults to RESOURCE_SAMPLE_INTERVAL_MS (2000ms) — the fixed cross-platform cadence. */
  intervalMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?(): number;
}

export function startResourceSampler(deps: ResourceSamplerDeps): () => void {
  const intervalMs = deps.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS;
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

  // Same fix as vitals/resource-sampler.ts's resetBaseline (Codex round-2
  // finding R10, reimplemented here independently): after a BFCache restore
  // or an OS/browser freeze, the first tick after resume must not compute
  // `actualElapsed` across the entire frozen gap and report that as
  // `loopLagMs`. Reset on `visibilitychange` -> visible AND on `pageshow`
  // (which fires on a BFCache restore even when `visibilitychange` does
  // not).
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

      const mem =
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? 0;
      const loopLagMs = Math.max(0, actualElapsed - intervalMs);
      const extras: Record<string, number> = { longTaskMs, loopLagMs };
      longTaskMs = 0;

      // No `cpu` key — omitted entirely, never set to undefined (web has no
      // browser CPU API; see this file's header).
      deps.onSample({ t: current, mem, extras });
    },
    { name: 'resources.sampler.tick' },
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
