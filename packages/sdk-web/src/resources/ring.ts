// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — the in-memory ring holding the
// last N seconds of resource samples for THIS session. Fed by
// `startResourceSampler` (sampler.ts) and read by `stampResources` (Task 9's
// stamp.ts) at report/crash time.
//
// `windowMs()` is a callback rather than a value captured at construction —
// it is read LIVE on every `snapshot()` call, so a server-config refresh
// that changes `resources.windowSec` mid-session takes effect immediately
// with no restart required. Mirrors how `replayDurationSec` is re-read live
// off the config provider rather than baked in at replay-lifecycle
// construction time.
//
// Capped at `MAX_RESOURCE_SAMPLES` independently of the window: the worst
// legal config (120s window / 2s cadence = 60 samples) is well under the
// cap, but an ill-behaved caller (a custom `now()`/interval, or the window
// growing at runtime) must never be allowed to grow the buffer without
// bound — the cap is enforced at push time, on every push, regardless of
// what the window says.
import { MAX_RESOURCE_SAMPLES } from '@traceitx/protocol';
import type { ResourceSampleT } from '@traceitx/protocol';

export interface ResourceRingDeps {
  /** Live window length in ms — re-read on every snapshot(), never cached. */
  windowMs(): number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?(): number;
}

export interface ResourceRing {
  push(s: ResourceSampleT): void;
  /** Newest-last, filtered to the CURRENT window, capped at MAX_RESOURCE_SAMPLES. */
  snapshot(): ResourceSampleT[];
  clear(): void;
}

export function createResourceRing(deps: ResourceRingDeps): ResourceRing {
  const now = deps.now ?? (() => Date.now());
  let buf: ResourceSampleT[] = [];

  return {
    push(s: ResourceSampleT): void {
      buf.push(s);
      // Push-time cap — independent of the window, which is only applied at
      // snapshot() time (a window that changes at runtime must not be able
      // to resurrect samples already evicted here).
      if (buf.length > MAX_RESOURCE_SAMPLES) {
        buf = buf.slice(-MAX_RESOURCE_SAMPLES);
      }
    },
    snapshot(): ResourceSampleT[] {
      const cutoff = now() - deps.windowMs();
      return buf.filter((s) => s.t >= cutoff);
    },
    clear(): void {
      buf = [];
    },
  };
}
