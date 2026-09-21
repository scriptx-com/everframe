// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `config.debug` diagnostic seam. The replay lifecycle and recorder are
// reachable from nothing global, so a debugger attached to a device (webOS /
// Tizen over CDP) had no way to ask why a report shipped without a replay.
// Installed only when the host opts in, and removed when the adapter is killed.
//
// Exposes counts and state names only — never frame contents.
//
// Ownership is "whoever MOUNTED", not "whoever wrote the global last": React
// StrictMode builds two adapters and commits the first while the second
// installs last, and the discarded one never receives an effect cleanup
// (provider.tsx carries the same warning — field bug 2026-07-10 shipped 0
// breadcrumbs through exactly this). `adoptReplayDebugSeam` is called from the
// mount path, so the live adapter is the one the seam reports on.
'use client';

import {
  __enableReplayTrace,
  __getReplayTrace,
  type ReplayConfig,
  type ReplayState,
  type ReplayTraceEntry,
} from '@traceitx/sdk-core';
import type { ReplayRecorderDiagnostics } from '../capture/replay/recorder.js';

export const DEBUG_GLOBAL_KEY = '__traceitxDebug';

export interface ReplayStateSnapshot {
  lifecycle: ReplayState | null;
  recorder: ReplayRecorderDiagnostics | null;
  /** The config the gates actually read — OFF until a validated 200 lands. */
  config: ReplayConfig | null;
}

export interface ReplayDebugSeam {
  replayState(): ReplayStateSnapshot;
  replayTrace(): ReplayTraceEntry[];
}

export interface ReplayDebugSources {
  lifecycleState: () => ReplayState | null;
  recorderDiagnostics: () => ReplayRecorderDiagnostics | null;
  config: () => ReplayConfig | null;
}

/** The adapter the seam reports on. Not necessarily the one that installed it. */
let liveSources: ReplayDebugSources | null = null;
/** One seam object shared by every install, reading `liveSources` on each call. */
let installedSeam: ReplayDebugSeam | null = null;

/** Install the global seam and arm the trace ring. Returns the uninstaller. */
export function installReplayDebugSeam(sources: ReplayDebugSources): () => void {
  __enableReplayTrace(true);
  // First installer wins the initial pointer so a single-adapter host works
  // before any mount; `adoptReplayDebugSeam` corrects it under StrictMode.
  if (liveSources === null) liveSources = sources;
  const seam: ReplayDebugSeam = (installedSeam ??= {
    replayState: () => ({
      lifecycle: safe(() => liveSources?.lifecycleState() ?? null, null),
      recorder: safe(() => liveSources?.recorderDiagnostics() ?? null, null),
      // A DETACHED, frozen copy. The provider's `get()` hands back its live
      // cache: returning that let a page script flip replayEnabled /
      // samplingRate / captureBodies straight onto the gate, bypassing the
      // validated-200 requirement and the remote kill switch.
      config: freezeDeep(safe(() => clone(liveSources?.config() ?? null), null)),
    }),
    replayTrace: () => __getReplayTrace(),
  });
  const host = globalThis as Record<string, unknown>;
  // DEFE-02: a page that already owns this property (non-writable, a getter)
  // must cost us diagnostics, never the SDK's construction — losing every
  // report on the page is strictly worse than having no debug seam.
  try {
    host[DEBUG_GLOBAL_KEY] = seam;
  } catch {
    /* the page owns the name; diagnostics unavailable this session */
  }
  return () => {
    // Only the adapter that actually mounted tears the seam down. A discarded
    // StrictMode twin returning here must not disarm the live one's tracing.
    if (liveSources !== sources) return;
    liveSources = null;
    installedSeam = null;
    __enableReplayTrace(false);
    try {
      if (host[DEBUG_GLOBAL_KEY] === seam) delete host[DEBUG_GLOBAL_KEY];
    } catch {
      /* non-configurable, or never ours to begin with */
    }
  };
}

/**
 * Point the seam at the adapter that MOUNTED. Called from the mount path, which
 * runs only for the committed adapter — the install order cannot tell them apart.
 */
export function adoptReplayDebugSeam(sources: ReplayDebugSources): void {
  liveSources = sources;
}

/** Test seam. */
export function __resetReplayDebugSeamForTests(): void {
  liveSources = null;
  installedSeam = null;
}

/**
 * Plain-JSON deep copy. The config is Zod-validated JSON, so a round-trip is
 * total — and `structuredClone` is Chrome 98+, past the Chrome 79 floor.
 */
function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    freezeDeep((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
