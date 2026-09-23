// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BrandTokens — quiet-instrument charcoal/amber palette (Task 11, native
// report-window parity). Mirrors packages/sdk-react/src/reporter-ui/
// reporter.css.ts (--txx-*), which itself mirrors the admin "Quiet
// instrument" pass (Phase 15) + the amber accent override in
// the ingest service/admin/src/index.css.
//
// Replaces the earlier bento-duo-blue deep palette (verbatim port of
// branding-explorations/bento-duo-blue/brand.css [data-palette="deep"]) —
// same token NAMES, new values, so the restyle propagates to every call
// site automatically. `accent3`/`violet` (bento-duo-blue-only tokens, never
// referenced outside this file) are retired; `hot` now carries the
// destructive violet the web tokens call `--txx-destructive`.
//
// We ship literal ARGB ints here so the reporter UI has zero runtime
// color-math dependency (Phase 13 CONTEXT D6: "No new dependencies"). If a
// token visually mismatches the web reporter rendering, update the single
// offending hex literal against reporter.css.ts's `--txx-*` value — do NOT
// introduce a runtime OKLCH/color library.

#if canImport(UIKit)
import UIKit

public enum BrandTokens {
    // Surfaces (deepest → shallowest)
    public static let bg      = UIColor(argb: 0xFF0D0F13)  // --txx-bg
    public static let bg2     = UIColor(argb: 0xFF15171C)  // --txx-bg-2 (modal surface)
    public static let bg3     = UIColor(argb: 0xFF1D2126)  // --txx-bg-3 (chips, bars)
    // Hairline
    public static let hair    = UIColor(argb: 0xFF303338)  // --txx-border
    // Text (highest → lowest contrast)
    public static let ink     = UIColor(argb: 0xFFF1F5FC)  // --txx-text
    public static let ink2    = UIColor(argb: 0xFFB6BBC3)  // --txx-text-muted
    public static let ink3    = UIColor(argb: 0xFF81868F)  // --txx-text-faint
    // Accent — amber/gold
    public static let accent    = UIColor(argb: 0xFFF2AF48)  // --txx-accent
    public static let accent2   = UIColor(argb: 0xFFF4CA84)  // --txx-accent-2 (lighter gold)
    public static let accentFg  = UIColor(argb: 0xFF0D0F13)  // --txx-accent-fg (dark text on amber)
    // Destructive
    public static let hot     = UIColor(argb: 0xFF9570FF)  // --txx-destructive (Discard/Clear)
    // Editor constants (theming constraint — no literals in views): the
    // stroke-color swatch palette is the annotation model's own constant,
    // re-exposed here so views reach it via BrandTokens like every other
    // token instead of importing AnnotationConstants directly.
    public static let annotationPalette = AnnotationConstants.penColors
}

public extension UIColor {
    /// 0xAARRGGBB → UIColor. The annotation model stores ARGB ints (it is
    /// UI-framework-free); views and bake convert here.
    convenience init(argb: UInt32) {
        self.init(
            red: CGFloat((argb >> 16) & 0xFF) / 255,
            green: CGFloat((argb >> 8) & 0xFF) / 255,
            blue: CGFloat(argb & 0xFF) / 255,
            alpha: CGFloat((argb >> 24) & 0xFF) / 255
        )
    }
}
#endif
