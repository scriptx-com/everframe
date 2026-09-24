// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BrandTokens — quiet-instrument palette as Compose Color constants.
// Mirrors packages/sdk-react/src/reporter-ui/reporter.css.ts (--txx-*) and
// the iOS BrandTokens.swift literals (one source of truth: offline
// OKLCH→sRGB, verified with culori@4; accent family is gamut-clamped to
// sRGB).
//
// We ship ARGB hex literals here so the reporter UI has zero runtime
// color-math dependency (Phase 13 CONTEXT D6: "No new dependencies").
//
// Wave-3 (plan 13-07) migrated every reporter call-site off the old iOS-mirror
// ReporterColors palette and deleted that file. BrandTokens is now the single
// source of color truth for the Android reporter UI.
//
// Task 10 (native report-window parity, Android): swapped the bento-duo-blue
// deep palette for the admin "Quiet instrument" pass (Phase 15) — flat
// surfaces, tonal depth, amber/gold accent, no glow/lift. `Accent3`/`Violet`
// (unreferenced outside this file) were dropped rather than remapped.

package dev.everframe.ui.theme

import androidx.compose.ui.graphics.Color
import dev.everframe.ui.annotation.AnnotationConstants

internal object BrandTokens {
    // Surfaces
    val Bg: Color = Color(0xFF0D0F13)        // --txx-bg
    val Bg2: Color = Color(0xFF15171C)       // --txx-bg-2 (modal surface)
    val Bg3: Color = Color(0xFF1D2126)       // --txx-bg-3 (chips, bars)
    // Hairline
    val Hair: Color = Color(0xFF303338)      // --txx-border
    // Text
    val Ink: Color = Color(0xFFF1F5FC)       // --txx-text
    val Ink2: Color = Color(0xFFB6BBC3)      // --txx-text-muted
    val Ink3: Color = Color(0xFF81868F)      // --txx-text-faint
    // Accents
    val Accent: Color = Color(0xFFF2AF48)    // --txx-accent (amber/gold)
    val Accent2: Color = Color(0xFFF4CA84)   // --txx-accent-2
    val AccentFg: Color = Color(0xFF0D0F13)  // --txx-accent-fg (dark text on amber)
    val Hot: Color = Color(0xFF9570FF)       // --txx-destructive (Discard/Clear)
    /** Editor palette re-exposed for views (theming constraint — model owns the ints). */
    val AnnotationPalette: List<Color> = AnnotationConstants.PEN_COLORS.map { Color(it) }
}
