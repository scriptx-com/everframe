// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UIKit face of ReporterTheme (iOS spec 2026-08-26): the single conversion
// site from the resolver's pure ARGB ints to UIColor. Resolved ONCE per
// reporter presentation (Approach A — no mid-open re-theme; a dashboard
// change lands at the next open) and injected down the VC tree.
#if canImport(UIKit)
import EverframeKit
import UIKit

public struct ResolvedPalette {
    public let bg: UIColor
    public let bg2: UIColor
    public let bg3: UIColor
    public let hair: UIColor
    public let ink: UIColor
    public let ink2: UIColor
    public let ink3: UIColor
    public let accent: UIColor
    public let accent2: UIColor
    public let accentFg: UIColor
    public let hot: UIColor

    public init(_ t: ReporterTheme) {
        bg = UIColor(argb: t.bg)
        bg2 = UIColor(argb: t.bg2)
        bg3 = UIColor(argb: t.bg3)
        hair = UIColor(argb: t.hair)
        ink = UIColor(argb: t.ink)
        ink2 = UIColor(argb: t.ink2)
        ink3 = UIColor(argb: t.ink3)
        accent = UIColor(argb: t.accent)
        accent2 = UIColor(argb: t.accent2)
        accentFg = UIColor(argb: t.accentFg)
        hot = UIColor(argb: t.hot)
    }

    /// The unthemed default — byte-identical to BrandTokens (parity test).
    public static let brand = ResolvedPalette(.default)
}
#endif
