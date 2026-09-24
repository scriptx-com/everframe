// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RELEASE VARIANT. Deliberately a `val` bound to null, not a `var`: with no
// mutator anywhere in this source set, `current` can never be non-null at
// runtime here, so `IngestEndpoint.url` always resolves to
// `BuildConfig.INGEST_URL` in release. That guarantee comes from the
// compiler — it holds regardless of R8's optimization level or keep rules,
// which is stronger than (and does not depend on) whatever constant-folding
// R8 may or may not additionally perform.
//
// Do not "unify" this with the debug file by making it a var. The asymmetry IS
// the feature.
package dev.everframe.config

internal object EndpointOverride {
    val current: String? = null
}
