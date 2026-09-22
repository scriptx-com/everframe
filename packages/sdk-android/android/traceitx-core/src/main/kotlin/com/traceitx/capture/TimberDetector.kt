// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reflection-detected Timber install. Per RESEARCH Finding 11 (lines 770-786)
// and CONTEXT 05 — Timber is NOT a runtime dependency of :traceitx-core. The
// production build declares it as `compileOnly`, so the symbol exists at
// compile time but is absent from the host's runtime classpath unless the
// host independently brings it in.
//
// The two helpers here MUST be called in this order:
//
//   1. `timberOnClasspath()` — returns true only if `Class.forName("timber.log.Timber")`
//      succeeds on the *current* JVM. Wrapped in txGuard so a hostile class loader
//      that throws something exotic (LinkageError, SecurityException) yields
//      false instead of propagating.
//
//   2. `installTreeIfAvailable(tree)` — references `timber.log.Timber.Tree`
//      directly. That reference is safe ONLY because step 1 already proved
//      Timber is present. Calling step 2 without step 1 first risks
//      NoClassDefFoundError at JIT time on a Timber-less host.
//
// Teardown removes only the exact SDK-owned tree. Host trees are never enumerated or removed.
// Failed/unsupported removal leaves ownership retained and blocks replacement planting.
package com.traceitx.capture

import com.traceitx.envelope.txGuard

internal object TimberDetector {

    /**
     * Returns true iff `timber.log.Timber` resolves on the current JVM.
     * Always call this BEFORE installTreeIfAvailable — see file-header docs.
     */
    fun timberOnClasspath(): Boolean = txGuard("timber-classpath") {
        Class.forName("timber.log.Timber")
        true
    } ?: false

    /**
     * Plant a Timber Tree. Caller MUST have already validated presence via
     * timberOnClasspath(). The parameter type references `timber.log.Timber.Tree`
     * directly — that is safe because the call site is gated.
     *
     * compileOnly keeps the symbol off the production runtime classpath; the
     * Class.forName gate above prevents us from reaching the symbol-resolution
     * path on JVMs that lack Timber.
     */
    fun installTreeIfAvailable(tree: timber.log.Timber.Tree): Boolean = txGuard("timber-plant") {
        timber.log.Timber.plant(tree)
        true
    } ?: false

    /** Exact owned-tree removal. An already absent tree is settled; other failures remain uncertain. */
    fun removeTreeIfAvailable(tree: Any): Boolean = txGuard("timber-remove-owned") {
        if (!timberOnClasspath()) return@txGuard false
        try {
            timber.log.Timber.uproot(tree as timber.log.Timber.Tree)
        } catch (_: IllegalArgumentException) {
            // Timber reports this only when that exact tree is no longer planted.
        }
        true
    } ?: false
}
