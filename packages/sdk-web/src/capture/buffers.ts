// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { RingBuffer } from '../internal/ring-buffer.js';
import type { LogEntry, NetworkEntry } from '@everframe/sdk-core';

export const DEFAULT_CONSOLE_CAP = 100;
export const DEFAULT_NETWORK_CAP = 100;

/**
 * Module-singleton ring buffers — created at module evaluation but populated only after
 * installConsolePatcher / installFetchPatcher / installXHRPatcher run from inside the
 * Provider's useMemo (DEFE-01: zero side-effects at module load means we allocate the
 * buffers but do NOT patch globals here).
 *
 * NOTE: module-singleton is acceptable for v1 because Provider is a single-instance
 * pattern (CONTEXT lock: "single-init by design"). If Phase 4 surfaces multi-instance
 * need (RN multi-screen), refactor to a factory.
 */
export const consoleBuffer = new RingBuffer<LogEntry>(DEFAULT_CONSOLE_CAP);
export const networkBuffer = new RingBuffer<NetworkEntry>(DEFAULT_NETWORK_CAP);

/**
 * Codex round-3 finding 1 (P1) — THE admission gate for both raw capture
 * buffers, and the reason `logs.ts` / `network.ts` no longer touch
 * `consoleBuffer` / `networkBuffer` directly.
 *
 * The console/fetch/XHR patchers are page-global and install-once behind
 * Symbol markers: `destroy()` deliberately leaves them installed (they are
 * shared with anything else on the page and uninstalling them has its own
 * hazards — see `Everframe.destroy`'s doc and `installFetchPatcher`'s
 * FETCH_MARKER), and their writes used to be UNCONDITIONAL. So between one
 * instance's teardown and the next instance's `init()` — and, worse, after a
 * `kill()` that withdrew consent without tearing anything down — every
 * console line and every request kept landing in a buffer the next report
 * would ship.
 *
 * One boolean, consulted by the only two writers there are, is the whole fix
 * for the "keeps capturing" half. It is:
 *   - TRUE by default, because the patchers are only ever installed BY an
 *     adapter, and a spec that installs one directly (capture/logs.spec.ts,
 *     capture/network.spec.ts) has no adapter to claim the buffers;
 *   - flipped false by `adapter.onKill()` — the consent switch;
 *   - flipped true again by a live host mount claiming the adapter
 *     (`__claimCaptureBuffers` at construction, `__rebindCrumbHooks()` on a
 *     StrictMode remount), the same revive doctrine `reportingKilled` uses.
 */
let accepting = true;

/** SDK-internal — see `accepting` above. The adapter is the only caller. */
export function __setCaptureAccepting(on: boolean): void {
  accepting = on;
}

/** SDK-internal — test/diagnostic read of the admission gate. */
export function __captureAccepting(): boolean {
  return accepting;
}

/** THE console-buffer writer. Gated (see `accepting`). */
export function pushLogEntry(entry: LogEntry): void {
  if (!accepting) return;
  consoleBuffer.push(entry);
}

/** THE network-buffer writer. Gated (see `accepting`). */
export function pushNetworkEntry(entry: NetworkEntry): void {
  if (!accepting) return;
  networkBuffer.push(entry);
}

export function getLogsSnapshot(): LogEntry[] {
  return consoleBuffer.snapshot().slice();
}
export function getNetworkSnapshot(): NetworkEntry[] {
  return networkBuffer.snapshot().slice();
}

/**
 * Claim the page-global buffers for a freshly constructed adapter: resize them
 * to this config's caps, DROP whatever is in them, and re-open admission.
 *
 * Codex round-3 finding 1 (P1) — the drop is the point. This used to preserve
 * existing entries across the resize ("a resize should not lose data"), which
 * is right for a resize and wrong for a CLAIM: the only production caller is
 * `createWebPlatformAdapter`, so "existing entries" means *the previous
 * tenant's*. init tenant A, `destroy()`, init tenant B, file a report, and B's
 * envelope carried A's console lines and A's request URLs. That is a
 * cross-instance data leak, not staleness, and it is why this function was
 * renamed off `__resizeBuffersForTesting`: its production job was never
 * resizing.
 *
 * Also used by specs to reset the buffers between cases.
 */
export function __claimCaptureBuffers(consoleCap: number, networkCap: number): void {
  consoleBuffer.clear();
  networkBuffer.clear();
  // Re-create buffers with new caps via Object.assign — simpler than mutating the cap field.
  Object.assign(consoleBuffer, new RingBuffer<LogEntry>(consoleCap));
  Object.assign(networkBuffer, new RingBuffer<NetworkEntry>(networkCap));
  accepting = true;
}
