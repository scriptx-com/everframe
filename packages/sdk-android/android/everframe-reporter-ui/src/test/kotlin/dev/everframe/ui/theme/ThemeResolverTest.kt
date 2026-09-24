// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui.theme

import androidx.compose.ui.graphics.Color
import dev.everframe.config.BrandingConfigWire
import dev.everframe.config.BrandingThemeWire
import dev.everframe.config.ReporterThemeOptions
import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeResolverTest {
    @Test
    fun `mixHex matches the web derivation arithmetic`() {
        // Same expectations as packages/sdk-react/__tests__/branding/theme.spec.ts.
        assertEquals(0x808080, ThemeResolver.mixHex(0x000000, 0xFFFFFF, 0.5))
        assertEquals(0x4372A1, ThemeResolver.mixHex(0x336699, 0xFFFFFF, 0.08))
        assertEquals(0x336699, ThemeResolver.mixHex(0x336699, 0xFFFFFF, 0.0))
        // Descending channel (a > b on every channel), hand-verified per-channel
        // round(a + (b-a)*t): R 241+(13-241)*0.26=181.72→182=0xB6,
        // G 245+(15-245)*0.26=185.2→185=0xB9, B 252+(19-252)*0.26=191.42→191=0xBF.
        assertEquals(0xB6B9BF, ThemeResolver.mixHex(0xF1F5FC, 0x0D0F13, 0.26))
    }

    @Test
    fun `unentitled resolves to DEFAULT even with themes present`() {
        val inline = ReporterThemeOptions(accent = "#336699")
        assertEquals(ReporterTheme.DEFAULT, ThemeResolver.resolve(null, inline))
        assertEquals(ReporterTheme.DEFAULT, ThemeResolver.resolve(BrandingConfigWire(watermark = true), inline))
        // Entitled but nothing overridden is also DEFAULT.
        assertEquals(ReporterTheme.DEFAULT, ThemeResolver.resolve(BrandingConfigWire(watermark = false), null))
    }

    @Test
    fun `DEFAULT equals BrandTokens verbatim`() {
        assertEquals(BrandTokens.Bg, ReporterTheme.DEFAULT.bg)
        assertEquals(BrandTokens.Bg2, ReporterTheme.DEFAULT.bg2)
        assertEquals(BrandTokens.Bg3, ReporterTheme.DEFAULT.bg3)
        assertEquals(BrandTokens.Hair, ReporterTheme.DEFAULT.hair)
        assertEquals(BrandTokens.Ink, ReporterTheme.DEFAULT.ink)
        assertEquals(BrandTokens.Ink2, ReporterTheme.DEFAULT.ink2)
        assertEquals(BrandTokens.Ink3, ReporterTheme.DEFAULT.ink3)
        assertEquals(BrandTokens.Accent, ReporterTheme.DEFAULT.accent)
        assertEquals(BrandTokens.Accent2, ReporterTheme.DEFAULT.accent2)
        assertEquals(BrandTokens.AccentFg, ReporterTheme.DEFAULT.accentFg)
        assertEquals(BrandTokens.Hot, ReporterTheme.DEFAULT.hot)
    }

    @Test
    fun `accent-only inline theme derives accent2 and leaves the rest default`() {
        val t = ThemeResolver.resolve(BrandingConfigWire(watermark = false), ReporterThemeOptions(accent = "#336699"))
        assertEquals(Color(0xFF336699), t.accent)
        assertEquals(Color(0xFF000000.toInt() or ThemeResolver.mixHex(0x336699, 0xFFFFFF, 0.35)), t.accent2)
        assertEquals(BrandTokens.Bg, t.bg)
        assertEquals(BrandTokens.Ink, t.ink)
        assertEquals(BrandTokens.Hot, t.hot)
    }

    @Test
    fun `server theme field beats inline per-field`() {
        val t = ThemeResolver.resolve(
            BrandingConfigWire(watermark = false, theme = BrandingThemeWire(accent = "#ff0000")),
            ReporterThemeOptions(accent = "#00ff00", accentForeground = "#111111"),
        )
        assertEquals(Color(0xFFFF0000), t.accent)      // server wins
        assertEquals(Color(0xFF111111), t.accentFg)    // inline fills the gap
    }

    @Test
    fun `background derives the tonal ramp at web ratios`() {
        val t = ThemeResolver.resolve(BrandingConfigWire(watermark = false), ReporterThemeOptions(background = "#101215"))
        assertEquals(Color(0xFF101215), t.bg)
        assertEquals(Color(0xFF000000.toInt() or ThemeResolver.mixHex(0x101215, 0xFFFFFF, 0.035)), t.bg2)
        assertEquals(Color(0xFF000000.toInt() or ThemeResolver.mixHex(0x101215, 0xFFFFFF, 0.07)), t.bg3)
        // border derives from bg↔text when unset:
        assertEquals(Color(0xFF000000.toInt() or ThemeResolver.mixHex(0x101215, 0xF1F5FC, 0.15)), t.hair)
    }

    @Test
    fun `explicit surface overrides derived bg3`() {
        val t = ThemeResolver.resolve(
            BrandingConfigWire(watermark = false),
            ReporterThemeOptions(background = "#101215", surface = "#222428"),
        )
        assertEquals(Color(0xFF222428), t.bg3)
    }

    @Test
    fun `text derives muted and faint inks at web ratios`() {
        val t = ThemeResolver.resolve(BrandingConfigWire(watermark = false), ReporterThemeOptions(text = "#e8e8f0"))
        assertEquals(Color(0xFFE8E8F0), t.ink)
        assertEquals(Color(0xFF000000.toInt() or ThemeResolver.mixHex(0xE8E8F0, 0x0D0F13, 0.26)), t.ink2)
        assertEquals(Color(0xFF000000.toInt() or ThemeResolver.mixHex(0xE8E8F0, 0x0D0F13, 0.5)), t.ink3)
    }

    @Test
    fun `explicit textMuted and border win over derivation`() {
        val t = ThemeResolver.resolve(
            BrandingConfigWire(watermark = false),
            ReporterThemeOptions(text = "#e8e8f0", textMuted = "#aabbcc", border = "#334455"),
        )
        assertEquals(Color(0xFFAABBCC), t.ink2)
        assertEquals(Color(0xFF334455), t.hair)
    }

    @Test
    fun `invalid hex is ignored per-field, never thrown on`() {
        val t = ThemeResolver.resolve(
            BrandingConfigWire(watermark = false),
            ReporterThemeOptions(accent = "red", text = "#e8e8f0"),
        )
        assertEquals(BrandTokens.Accent, t.accent)
        assertEquals(Color(0xFFE8E8F0), t.ink)
    }

    @Test
    fun `destructive maps to hot`() {
        val t = ThemeResolver.resolve(BrandingConfigWire(watermark = false), ReporterThemeOptions(destructive = "#cc3355"))
        assertEquals(Color(0xFFCC3355), t.hot)
    }

    @Test
    fun `bg-only theme derives ink2 and ink3 against the default text anchor`() {
        // text is unset, so effText falls back to DEFAULT_TEXT (0xF1F5FC) —
        // ink2/ink3 must derive from that anchor, not from bg alone.
        val t = ThemeResolver.resolve(BrandingConfigWire(watermark = false), ReporterThemeOptions(background = "#101215"))
        assertEquals(
            Color(0xFF000000.toInt() or ThemeResolver.mixHex(0xF1F5FC, 0x101215, 0.26)),
            t.ink2,
        )
        assertEquals(
            Color(0xFF000000.toInt() or ThemeResolver.mixHex(0xF1F5FC, 0x101215, 0.5)),
            t.ink3,
        )
    }

    @Test
    fun `derivation anchors are locked to BrandTokens' default bg and text`() {
        // ThemeResolver.DEFAULT_BG/DEFAULT_TEXT are private literals mirroring
        // BrandTokens.Bg/BrandTokens.Ink — this test pins those literals
        // directly so a BrandTokens repaint (bg or ink literal change) fails
        // here until DEFAULT_BG/DEFAULT_TEXT are updated to match, instead of
        // silently drifting the tonal-ramp derivation away from the palette.
        assertEquals(Color(0xFF000000.toInt() or 0x0D0F13), BrandTokens.Bg)
        assertEquals(Color(0xFF000000.toInt() or 0xF1F5FC), BrandTokens.Ink)
    }
}
