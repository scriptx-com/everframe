// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Branding state + pure theme resolution (iOS spec 2026-08-26).
//
// Everything in this file is deliberately OUTSIDE any #if canImport(UIKit)
// gate so its tests run under host `swift test` (TESTING.md's false-green
// rule — the CompanionBadgeResolution precedent). Colors are UInt32 ARGB;
// EverframeReporterUI converts once via UIColor(argb:) (ResolvedPalette).
//
// Everything here is `public` on purpose: EverframeReporterUI is a separate
// SPM target and must read the box and run the resolver at presentation
// time. (The companion box stays internal because only EverframeKit reads it.)
import Combine
import Foundation

/// Watermark gate. TRUE unless the LATEST server block confirms paid
/// entitlement (`watermark == false`). Absent block (old server, feature not
/// negotiated, fresh/killed session, malformed block) ⇒ shown — fail closed
/// to watermarked. Same truth table as web and Android.
public func shouldShowWatermark(_ server: BrandingConfigWire?) -> Bool {
    server?.watermark != false
}

/// Thread-safe snapshot of the fetched server branding block. Written by
/// ReplaySession on every successful config apply (under the same
/// parked-continuation epoch re-check as the companion-badge write); cleared
/// at both Everframe session boundaries (start()'s synchronous reset, kill()'s
/// @MainActor task) so a dead session's entitlement never outlives it.
/// Structure mirrors CompanionBadgeServerConfigBox — NSLock-guarded mirror
/// for a plain synchronous getter on the apply path, CurrentValueSubject for
/// observation (currently informational: the reporter resolves once at
/// presentation time by design — iOS spec, Approach A).
public final class BrandingServerConfigBox: @unchecked Sendable {
    public static let shared = BrandingServerConfigBox()
    private let lock = NSLock()
    private let subject = CurrentValueSubject<BrandingConfigWire?, Never>(nil)
    private var _value: BrandingConfigWire?
    // Setter is internal(set) (#137 review follow-up): only EverframeKit
    // writes the box (ReplaySession's config apply, the session-boundary
    // clears); EverframeReporterUI is a reader. Tests keep writing through
    // `@testable import EverframeKit`.
    public internal(set) var value: BrandingConfigWire? {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set {
            lock.lock()
            _value = newValue
            lock.unlock()
            subject.send(newValue)
        }
    }
    public var publisher: AnyPublisher<BrandingConfigWire?, Never> {
        subject.eraseToAnyPublisher()
    }
}

/// The host's inline reporter theme (branding spec) — 8 semantic color
/// roles, #rrggbb strings only, exact web/Android names. Applies ONLY once
/// the server confirms a paid plan; per-field precedence is server theme →
/// this inline theme → BrandTokens default. Invalid values are ignored
/// per-field. Referenced by EverframeConfig.theme; the RN bridge (stacked
/// PR 3) maps its flattened theme fields onto that property.
public struct ReporterThemeOptions: Sendable, Equatable {
    public let background: String?
    public let surface: String?
    public let border: String?
    public let text: String?
    public let textMuted: String?
    public let accent: String?
    public let accentForeground: String?
    public let destructive: String?
    public init(
        background: String? = nil, surface: String? = nil, border: String? = nil,
        text: String? = nil, textMuted: String? = nil, accent: String? = nil,
        accentForeground: String? = nil, destructive: String? = nil
    ) {
        self.background = background
        self.surface = surface
        self.border = border
        self.text = text
        self.textMuted = textMuted
        self.accent = accent
        self.accentForeground = accentForeground
        self.destructive = destructive
    }
}

/// The 8 roles resolved into the 11 concrete ARGB colors the reporter UI
/// consumes (BrandTokens' members). Alpha variants stay at call sites via
/// `.withAlphaComponent`, which follows a themed base automatically — the
/// same reason Android needed no rgba token family.
public struct ReporterTheme: Sendable, Equatable {
    public let bg: UInt32
    public let bg2: UInt32
    public let bg3: UInt32
    public let hair: UInt32
    public let ink: UInt32
    public let ink2: UInt32
    public let ink3: UInt32
    public let accent: UInt32
    public let accent2: UInt32
    public let accentFg: UInt32
    public let hot: UInt32
    public init(
        bg: UInt32, bg2: UInt32, bg3: UInt32, hair: UInt32,
        ink: UInt32, ink2: UInt32, ink3: UInt32,
        accent: UInt32, accent2: UInt32, accentFg: UInt32, hot: UInt32
    ) {
        self.bg = bg
        self.bg2 = bg2
        self.bg3 = bg3
        self.hair = hair
        self.ink = ink
        self.ink2 = ink2
        self.ink3 = ink3
        self.accent = accent
        self.accent2 = accent2
        self.accentFg = accentFg
        self.hot = hot
    }
    /// The quiet-instrument palette — MUST stay byte-identical to
    /// BrandTokens.swift's UIColor literals (locked by BrandingTests on the
    /// host and BrandingPaletteParityTests on the simulator).
    public static let `default` = ReporterTheme(
        bg: 0xFF0D0F13, bg2: 0xFF15171C, bg3: 0xFF1D2126, hair: 0xFF303338,
        ink: 0xFFF1F5FC, ink2: 0xFFB6BBC3, ink3: 0xFF81868F,
        accent: 0xFFF2AF48, accent2: 0xFFF4CA84, accentFg: 0xFF0D0F13, hot: 0xFF9570FF
    )
}

/// Web-parity resolution: per-field precedence server → inline → default,
/// entitlement-gated, with hand-rolled integer sRGB mixing at the exact web
/// ratios (packages/sdk-react/src/branding/theme.ts is the reference; the
/// Android ThemeResolver is the sibling port). `surface` collapses into
/// `bg3` — the deliberate cross-platform choice documented on PR #136.
public enum ThemeResolver {
    /// Derivation anchors — must equal BrandTokens.bg/.ink (test-locked).
    static let defaultBG: UInt32 = 0x0D0F13
    static let defaultText: UInt32 = 0xF1F5FC

    public static func parseHexOrNil(_ v: String?) -> UInt32? {
        guard let v, v.count == 7, v.hasPrefix("#"),
              v.dropFirst().allSatisfy({ $0.isASCII && $0.isHexDigit })
        else { return nil }
        return UInt32(v.dropFirst(), radix: 16)
    }

    /// Channel-wise linear mix of two 0xRRGGBB ints; t=0 → a, t=1 → b.
    /// `.rounded()` rounds half away from zero — identical to JS Math.round
    /// and Kotlin roundToInt for these non-negative channel values.
    public static func mixHex(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
        func ch(_ shift: UInt32) -> UInt32 {
            let ca = Double((a >> shift) & 0xFF)
            let cb = Double((b >> shift) & 0xFF)
            let mixed = (ca + (cb - ca) * t).rounded()
            return UInt32(min(255.0, max(0.0, mixed)))
        }
        return (ch(16) << 16) | (ch(8) << 8) | ch(0)
    }

    public static func resolve(server: BrandingConfigWire?, inline: ReporterThemeOptions?) -> ReporterTheme {
        guard server?.watermark == false else { return .default }
        let st = server?.theme
        func pick(_ s: String?, _ i: String?) -> UInt32? { parseHexOrNil(s) ?? parseHexOrNil(i) }

        let bg = pick(st?.background, inline?.background)
        let surface = pick(st?.surface, inline?.surface)
        let border = pick(st?.border, inline?.border)
        let text = pick(st?.text, inline?.text)
        let textMuted = pick(st?.textMuted, inline?.textMuted)
        let accent = pick(st?.accent, inline?.accent)
        let accentFg = pick(st?.accentForeground, inline?.accentForeground)
        let destructive = pick(st?.destructive, inline?.destructive)

        if [bg, surface, border, text, textMuted, accent, accentFg, destructive].allSatisfy({ $0 == nil }) {
            return .default
        }
        let effBg = bg ?? Self.defaultBG
        let effText = text ?? Self.defaultText
        let inkAnchored = bg != nil || text != nil
        func opaque(_ rgb: UInt32) -> UInt32 { 0xFF00_0000 | rgb }

        return ReporterTheme(
            bg: bg.map(opaque) ?? ReporterTheme.default.bg,
            bg2: bg.map { opaque(mixHex($0, 0xFFFFFF, 0.035)) } ?? ReporterTheme.default.bg2,
            bg3: surface.map(opaque)
                ?? bg.map { opaque(mixHex($0, 0xFFFFFF, 0.07)) }
                ?? ReporterTheme.default.bg3,
            hair: border.map(opaque)
                ?? (inkAnchored ? opaque(mixHex(effBg, effText, 0.15)) : ReporterTheme.default.hair),
            ink: text.map(opaque) ?? ReporterTheme.default.ink,
            ink2: textMuted.map(opaque)
                ?? (inkAnchored ? opaque(mixHex(effText, effBg, 0.26)) : ReporterTheme.default.ink2),
            ink3: inkAnchored ? opaque(mixHex(effText, effBg, 0.5)) : ReporterTheme.default.ink3,
            accent: accent.map(opaque) ?? ReporterTheme.default.accent,
            accent2: accent.map { opaque(mixHex($0, 0xFFFFFF, 0.35)) } ?? ReporterTheme.default.accent2,
            accentFg: accentFg.map(opaque) ?? ReporterTheme.default.accentFg,
            hot: destructive.map(opaque) ?? ReporterTheme.default.hot
        )
    }
}
