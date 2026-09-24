// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Ingest URL. Resolved from BuildConfig.INGEST_URL, which is set per-variant
// in :everframe-core's build.gradle.kts. Release variant: hardcoded prod URL.
// Debug variant: EVERFRAME_DEV_INGEST_URL env var at library build time, with
// emulator-friendly fallback (10.0.2.2 -> host machine localhost). The dev
// branch literally does not exist in the published release AAR.
package dev.everframe.config

import dev.everframe.BuildConfig

internal object IngestEndpoint {
    /**
     * A getter, not a `val`: the debug variant lets tests point the stamped
     * endpoint at a local MockWebServer. In release, `EndpointOverride.current`
     * is a `val` bound to `null` with no mutator anywhere in `src/release` —
     * so this always resolves to `BuildConfig.INGEST_URL` there, guaranteed by
     * the compiler (not by R8 or any optimization level).
     */
    val url: String get() = EndpointOverride.current ?: BuildConfig.INGEST_URL
}
