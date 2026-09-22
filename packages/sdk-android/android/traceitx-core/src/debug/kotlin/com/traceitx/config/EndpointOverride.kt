// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEBUG VARIANT ONLY. The release counterpart in src/release binds `current`
// to an immutable `val = null` with no mutator in that source set, so it can
// never be non-null at runtime there — a compiler-enforced guarantee, not an
// optimizer one (see build.gradle.kts's release buildType comment — this is
// the same invariant it protects for TRACEITX_DEV_INGEST_URL).
package com.traceitx.config

/**
 * Runtime override for the stamped ingest endpoint, for unit tests only.
 *
 * Android's only other redirect is the BUILD-TIME `TRACEITX_DEV_INGEST_URL`
 * env var, which a unit test cannot influence — so a test had no way to make
 * `CrashReporter` stamp a reachable endpoint, and its drain hung forever.
 *
 * Tests MUST restore this in teardown; it is process-global and leaks across
 * suites sharing a JVM worker.
 */
internal object EndpointOverride {
    var current: String? = null
}
