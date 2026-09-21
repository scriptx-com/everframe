// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TXScreen() — the framework-agnostic Compose navigation marker (spec
// 2026-07-14). One line per screen composable; works with NavHost,
// state-based `when(route)` navigation, Voyager, Decompose — anything that
// composes the visible screen. Feeds TraceItX.recordScreen(), which shares
// the global from→to chain with the Activity-level auto-capture.
//
// This is deliberately the ONLY production @Composable in :traceitx-core
// (amended Compose-isolation contract — see build.gradle.kts). It uses only
// compose.runtime APIs: no Material, no new dependencies.
package com.traceitx

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect

/**
 * Mark a screen as visible whenever this enters composition, [name] changes,
 * or [active] flips to true.
 *
 * [active] covers pagers / keep-alive containers where off-screen pages stay
 * composed — pass the page's "is selected" state. The adapter's `A → A`
 * suppression absorbs redundant re-emits, so recomposition is safe.
 *
 * [name] should be a route identifier, never user content (PII).
 */
@Composable
public fun TXScreen(name: String, active: Boolean = true) {
    LaunchedEffect(name, active) {
        if (active) TraceItX.recordScreen(name)
    }
}
