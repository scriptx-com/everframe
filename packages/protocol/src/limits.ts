// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report-size limits shared by every SDK and by ingest. Ingest registers its
// multipart `files` limit from MAX_INGEST_FILE_PARTS, so the client-side cap and
// the server-side cap cannot drift apart again (the server once accepted 6 parts
// while a 5-shot report with a replay needed 7).

/**
 * Screenshots per report. Every reporter UI enforces exactly this: web
 * `ScreenshotStrip` MAX_SCREENSHOTS, iOS `ShotListOps.maxShots`, Android
 * `ShotListOps.MAX_SHOTS`.
 */
export const MAX_REPORT_SHOTS = 5;

/**
 * Multipart file parts one report may carry: the envelope, an image AND a
 * `dom-snapshot` for every shot, and one session replay.
 */
export const MAX_INGEST_FILE_PARTS = 1 + MAX_REPORT_SHOTS * 2 + 1;
