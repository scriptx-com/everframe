// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The player-integration seam (spec 2026-09-02 §2). Platform-neutral so the
// native SDKs can implement the same vocabulary later. An integration adds
// ONLY what the media element cannot see (bitrate ladder, DRM, manifest and
// license timing, library errors); transport/buffer state stays with the
// element listeners in the platform adapter. Adding a player library = one
// file implementing this interface; the protocol never changes.
import type { VitalsPlayerEventType } from '@traceitx/protocol';

export type PlayerEmit = (
  type: VitalsPlayerEventType,
  data?: Record<string, unknown>,
  t?: number,
) => void;

export interface PlayerIntegrationContext {
  /** The HTMLMediaElement on web; typed loosely so sdk-core stays DOM-free. */
  element: unknown;
  emit: PlayerEmit;
  now(): number;
}

export interface PlayerSnapshot {
  bitrate?: number;
  width?: number;
  height?: number;
  bandwidthEstimate?: number;
}

export interface PlayerStartupTimings {
  manifestMs?: number;
  licenseMs?: number;
  firstFragmentMs?: number;
}

export interface PlayerIntegration {
  /** Free string ≤ 32 chars ('hls.js', 'shaka', 'video.js', …). Never an enum. */
  readonly library: string;
  readonly version?: string;
  /**
   * Subscribes to the underlying player library. Return `false` (fix wave
   * item 5) to signal that the object handed to this integration doesn't
   * look like the library it claims to be (e.g. missing the expected
   * subscribe method) — the adapter then clears the integration and falls
   * back to native, element-derived facts instead of leaving the player
   * permanently labelled with this `library` but silent. Any other return
   * value, including `void`/`undefined`, means "subscribed OK". This is for
   * an EXPECTED failure mode and must not throw for it — throwing is
   * reserved for a genuine integration bug, which the adapter also catches
   * and degrades from the same way.
   */
  attach(ctx: PlayerIntegrationContext): boolean | void;
  /** Feeds the per-tick `stats` entry. Must never throw. */
  snapshot?(): PlayerSnapshot;
  /** Merged into the `startup` event the adapter emits on the first `playing`. */
  startupTimings?(): PlayerStartupTimings;
  detach(): void;
}
