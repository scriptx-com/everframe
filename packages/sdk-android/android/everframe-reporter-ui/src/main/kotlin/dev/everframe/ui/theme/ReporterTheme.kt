// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Runtime reporter theme (Android spec 2026-08-26) — the branding block's
// 8 semantic roles resolved into the 11 concrete colors the reporter UI
// consumes (BrandTokens' members). Alpha variants stay at call sites via
// Color.copy(alpha=…), which follows the themed base automatically — that
// is why Android needs no rgba token family, unlike web's reporter.css.ts.
//
// ENTITLEMENT: theming applies ONLY once the server confirmed a paid plan
// (branding.watermark == false). Anything else — no config yet, block
// absent, watermark true, malformed — resolves to DEFAULT. Fail closed.
//
// Derivation parity: same integer sRGB per-channel round(a + (b-a)*t) and
// the same ratios as packages/sdk-react/src/branding/theme.ts, so one
// customer theme renders identically on web and Android. No new
// dependencies (BrandTokens header rule): the math is ~10 lines below.
package dev.everframe.ui.theme

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.Color
import dev.everframe.config.BrandingConfigWire
import dev.everframe.config.ReporterThemeOptions
import kotlin.math.roundToInt

internal data class ReporterTheme(
    val bg: Color,
    val bg2: Color,
    val bg3: Color,
    val hair: Color,
    val ink: Color,
    val ink2: Color,
    val ink3: Color,
    val accent: Color,
    val accent2: Color,
    val accentFg: Color,
    val hot: Color,
) {
    companion object {
        val DEFAULT = ReporterTheme(
            bg = BrandTokens.Bg,
            bg2 = BrandTokens.Bg2,
            bg3 = BrandTokens.Bg3,
            hair = BrandTokens.Hair,
            ink = BrandTokens.Ink,
            ink2 = BrandTokens.Ink2,
            ink3 = BrandTokens.Ink3,
            accent = BrandTokens.Accent,
            accent2 = BrandTokens.Accent2,
            accentFg = BrandTokens.AccentFg,
            hot = BrandTokens.Hot,
        )
    }
}

/** compositionLocalOf (not static): a config landing mid-open must recompose consumers. */
internal val LocalReporterTheme = compositionLocalOf { ReporterTheme.DEFAULT }

internal object ThemeResolver {
    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    /** Derivation anchors — MUST match BrandTokens.Bg / BrandTokens.Ink (locked by test). */
    private const val DEFAULT_BG = 0x0D0F13
    private const val DEFAULT_TEXT = 0xF1F5FC

    fun parseHexOrNull(v: String?): Int? =
        v?.takeIf { HEX.matches(it) }?.substring(1)?.toInt(16)

    /** Channel-wise linear mix of two 0xRRGGBB ints; t=0 → a, t=1 → b. Web's mixHex. */
    fun mixHex(a: Int, b: Int, t: Double): Int {
        fun ch(shift: Int): Int {
            val ca = (a shr shift) and 0xFF
            val cb = (b shr shift) and 0xFF
            return (ca + (cb - ca) * t).roundToInt().coerceIn(0, 255)
        }
        return (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    private fun color(rgb: Int): Color = Color(0xFF000000.toInt() or rgb)

    fun resolve(server: BrandingConfigWire?, inline: ReporterThemeOptions?): ReporterTheme {
        if (server?.watermark != false) return ReporterTheme.DEFAULT
        val st = server.theme
        fun pick(s: String?, i: String?): Int? = parseHexOrNull(s) ?: parseHexOrNull(i)

        val bg = pick(st?.background, inline?.background)
        val surface = pick(st?.surface, inline?.surface)
        val border = pick(st?.border, inline?.border)
        val text = pick(st?.text, inline?.text)
        val textMuted = pick(st?.textMuted, inline?.textMuted)
        val accent = pick(st?.accent, inline?.accent)
        val accentFg = pick(st?.accentForeground, inline?.accentForeground)
        val destructive = pick(st?.destructive, inline?.destructive)

        if (listOf(bg, surface, border, text, textMuted, accent, accentFg, destructive).all { it == null }) {
            return ReporterTheme.DEFAULT
        }
        val effBg = bg ?: DEFAULT_BG
        val effText = text ?: DEFAULT_TEXT
        val inkAnchored = bg != null || text != null

        return ReporterTheme(
            bg = bg?.let(::color) ?: BrandTokens.Bg,
            bg2 = bg?.let { color(mixHex(it, 0xFFFFFF, 0.035)) } ?: BrandTokens.Bg2,
            bg3 = surface?.let(::color)
                ?: bg?.let { color(mixHex(it, 0xFFFFFF, 0.07)) }
                ?: BrandTokens.Bg3,
            hair = border?.let(::color)
                ?: if (inkAnchored) color(mixHex(effBg, effText, 0.15)) else BrandTokens.Hair,
            ink = text?.let(::color) ?: BrandTokens.Ink,
            ink2 = textMuted?.let(::color)
                ?: if (inkAnchored) color(mixHex(effText, effBg, 0.26)) else BrandTokens.Ink2,
            ink3 = if (inkAnchored) color(mixHex(effText, effBg, 0.5)) else BrandTokens.Ink3,
            accent = accent?.let(::color) ?: BrandTokens.Accent,
            accent2 = accent?.let { color(mixHex(it, 0xFFFFFF, 0.35)) } ?: BrandTokens.Accent2,
            accentFg = accentFg?.let(::color) ?: BrandTokens.AccentFg,
            hot = destructive?.let(::color) ?: BrandTokens.Hot,
        )
    }
}
