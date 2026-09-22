// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Media sources shared by the two benches that play things: `/video` (the
// screenshot torture bench) and `/playback/*` (the Session Vitals benches).

/**
 * Both encodings of the demo clip, VP9 first.
 *
 * Two codecs because no single one plays everywhere the e2e suite runs:
 * Playwright's Firefox ships without the proprietary H.264 decoder and parks
 * the mp4 at readyState 0 forever, while WebKit is the reliable consumer of
 * the mp4. Offering both is what keeps "healthy video" genuinely healthy in
 * all three browsers — and a plate stuck at readyState 0 in one of them would
 * silently retest the stalled case instead of the decodable one.
 */
export const CLIP_SOURCES = [
  { src: '/media/field-loop.webm', type: 'video/webm' },
  { src: '/media/field-loop.mp4', type: 'video/mp4' },
] as const;

/**
 * Adaptive-streaming manifests for the `/playback` benches.
 *
 * These are PUBLIC third-party test streams, and public test streams rot —
 * they get retired, re-encoded, or moved behind a redirect that breaks CORS.
 * Each one is therefore overridable from the repo-root `.env`
 * (`gen-env-local.sh` projects the three vars below into `.env.local`), so a
 * dead URL is a one-line fix in your own env rather than a code change.
 *
 * The defaults are chosen for what they let you exercise, not for their
 * content: both the HLS VOD and the DASH manifest are multi-rendition, which
 * is what makes the level/variant pickers on those pages meaningful, and the
 * live stream is the only way to see a genuinely unbounded seekable range.
 */
export const HLS_VOD_URL =
  process.env.NEXT_PUBLIC_DEMO_HLS_URL ?? 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

// Unified Streaming's long-running live demo. Chosen over the Akamai live test
// streams (cph-p2p-msl / moctobpltc "eight") because, as of 2026-09-03, those
// still serve a master playlist but 404 on every variant — which looks like
// "readyState 0 forever" in the bench and is indistinguishable from a bug.
export const HLS_LIVE_URL =
  process.env.NEXT_PUBLIC_DEMO_HLS_LIVE_URL ??
  'https://demo.unified-streaming.com/k8s/live/stable/scte35.isml/.m3u8';

export const DASH_URL =
  process.env.NEXT_PUBLIC_DEMO_DASH_URL ??
  'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
