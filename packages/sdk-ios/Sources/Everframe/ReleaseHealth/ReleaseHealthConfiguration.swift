// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Turns on release health: crash-free sessions for each version of the app. The SDK reads the
/// version and build from the bundle (`CFBundleShortVersionString`, `CFBundleVersion`), so nothing
/// here names a release.
public struct ReleaseHealthConfiguration: Equatable, Sendable {
    public enum LoadedBundleStatus: String, Sendable { case known, unknown; case notApplicable = "not_applicable" }
    public enum ValidationError: Error { case invalidBuildIdentity, invalidUserIdentity }
    /// Explicit project-local opaque identity, frozen for this segment. Never inferred from setUser.
    public let userId: String?
    /// The loaded JavaScript bundle. The React Native bridge sets it from validated Hermes metadata.
    public let loadedBuildId: String?
    public let loadedBundleStatus: LoadedBundleStatus

    /// Anonymous sessions for a native app.
    public init() {
        userId = nil; loadedBuildId = nil; loadedBundleStatus = .notApplicable
    }
    /// An optional user ID must be nonblank, at most 128 UTF-16 units and free of U+0000-U+001F
    /// control characters. Supply a loaded bundle only when the app actually loaded it.
    public init(userId: String?, loadedBuildId: String? = nil, loadedBundleStatus: LoadedBundleStatus = .notApplicable) throws {
        guard loadedBuildId.map({ Self.validText($0, maximum: 200) }) ?? true,
              (loadedBundleStatus == .known) == (loadedBuildId != nil) else { throw ValidationError.invalidBuildIdentity }
        guard userId.map({ Self.validText($0, maximum: 128) }) ?? true else { throw ValidationError.invalidUserIdentity }
        self.userId = userId; self.loadedBuildId = loadedBuildId; self.loadedBundleStatus = loadedBundleStatus
    }
    // Opaque bundle and account IDs compare by wire bytes, not Swift's canonical Unicode equality.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        exact(lhs.loadedBuildId, rhs.loadedBuildId) && lhs.loadedBundleStatus == rhs.loadedBundleStatus && exact(lhs.userId, rhs.userId)
    }
    private static func exact(_ lhs: String?, _ rhs: String?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (a?, b?): return a.utf8.elementsEqual(b.utf8)
        default: return false
        }
    }
    static func validText(_ value: String, maximum: Int) -> Bool {
        !value.unicodeScalars.allSatisfy(wireWhitespace) && value.utf16.count <= maximum &&
            !value.unicodeScalars.contains { $0.value < 32 }
    }
    // Blank matches the wire contract's ECMAScript trim(): Zs, U+0009-U+000D, U+2028, U+2029 and
    // U+FEFF. Foundation's whitespace set differs: it adds U+0085 and U+200B and lacks U+FEFF.
    static func wireWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x9...0xD, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }
}
