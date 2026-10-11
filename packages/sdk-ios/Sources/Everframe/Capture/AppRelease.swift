// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// The app version and build that releases are grouped by. One rule feeds release health and
/// every report's `context.app.version`, so errors join to the version their sessions report.
/// `debug` marks a debug build, from which the server never creates a release.
struct AppRelease: Equatable, Sendable {
    let version: String
    let build: String?
    let debug: Bool
    static let maxLength = 64
    static let unknownVersion = "0.0.0"

    /// The version is the trimmed short version when it is release text, else the trimmed bundle
    /// version when it is, else "0.0.0". The build is the trimmed bundle version when it is release text.
    static func from(shortVersion: String?, bundleVersion: String?, debug: Bool) -> AppRelease {
        let short = shortVersion.map(trimmed).flatMap { validText($0) ? $0 : nil }
        let build = bundleVersion.map(trimmed).flatMap { validText($0) ? $0 : nil }
        return AppRelease(version: short ?? build ?? unknownVersion, build: build, debug: debug)
    }
    /// `CFBundleShortVersionString` and `CFBundleVersion` of the bundle. `debugBuild` is
    /// `EverframeConfig.debugBuild`: when nil, the app's signing decides.
    static func current(bundle: Bundle = .main, debugBuild: Bool?) -> AppRelease {
        let info = bundle.infoDictionary ?? [:]
        return from(shortVersion: info["CFBundleShortVersionString"] as? String,
            bundleVersion: info["CFBundleVersion"] as? String, debug: DebugBuild.current(configured: debugBuild))
    }
    /// Release text, as on the wire: non-blank, at most 64 UTF-16 units, no U+0000-U+001F.
    static func validText(_ value: String) -> Bool { ReleaseHealthConfiguration.validText(value, maximum: maxLength) }
    /// Both fields are release text. An injected value is checked before it opens a session.
    var isValid: Bool { Self.validText(version) && (build.map(Self.validText) ?? true) }

    // Trims the same set the wire contract treats as blank (ECMAScript trim()).
    private static func trimmed(_ value: String) -> String {
        let scalars = value.unicodeScalars
        guard let first = scalars.firstIndex(where: { !ReleaseHealthConfiguration.wireWhitespace($0) }),
              let last = scalars.lastIndex(where: { !ReleaseHealthConfiguration.wireWhitespace($0) }) else { return "" }
        return String(scalars[first...last])
    }
}
