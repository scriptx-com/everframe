// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Single shared entry point for providing LocalReporterTheme (Android spec
// 2026-08-26, codex round-1 finding 4). Extracted out of ReporterRoot so
// every reporter surface — including ones composed outside ReporterRoot's
// own CompositionLocalProvider block, like ReporterDialog's root-external
// discard dialog — resolves and provides the SAME runtime theme instead of
// each call site re-implementing the collect/resolve/provide dance (and
// risking one of them falling out of sync or being skipped entirely).
package com.traceitx.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import com.traceitx.config.BrandingInlineTheme
import com.traceitx.config.BrandingServerConfigSignal

/**
 * Collects the branding signals, resolves the runtime theme, and provides
 * LocalReporterTheme for [content]. The single provider implementation for
 * every reporter surface — ReporterRoot's body and ReporterDialog's
 * root-external discard dialog both wrap in this so no themed surface can
 * fall outside the provider again (codex round-1 finding 4).
 */
@Composable
internal fun ProvideReporterTheme(content: @Composable () -> Unit) {
    val serverBranding by BrandingServerConfigSignal.flow.collectAsState()
    val inlineTheme by BrandingInlineTheme.flow.collectAsState()
    val theme = remember(serverBranding, inlineTheme) { ThemeResolver.resolve(serverBranding, inlineTheme) }
    CompositionLocalProvider(LocalReporterTheme provides theme) { content() }
}
