// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public struct ReleaseHealthConfiguration: Equatable, Sendable {
    public enum LoadedBundleStatus: String, Sendable { case known, unknown; case notApplicable = "not_applicable" }
    public enum ValidationError: Error { case invalidBuildIdentity, invalidUserIdentity }
    /// Explicit project-local opaque identity, frozen for this segment. Never inferred from setUser.
    public let userId: String?
    public let nativeBuildId: String
    public let loadedBuildId: String?
    public let loadedBundleStatus: LoadedBundleStatus

    /// Supply artifact identity, and only a bundle actually loaded by the app.
    public init(nativeBuildId: String, loadedBuildId: String?, loadedBundleStatus: LoadedBundleStatus, userId: String? = nil) throws {
        guard Self.validText(nativeBuildId, maximum: 200),
              loadedBuildId.map({ Self.validText($0, maximum: 200) }) ?? true,
              (loadedBundleStatus == .known) == (loadedBuildId != nil) else { throw ValidationError.invalidBuildIdentity }
        guard userId.map({ Self.validText($0, maximum: 128) &&
            !$0.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{feff}"))).isEmpty }) ?? true else { throw ValidationError.invalidUserIdentity }
        self.userId = userId
        self.nativeBuildId = nativeBuildId; self.loadedBuildId = loadedBuildId; self.loadedBundleStatus = loadedBundleStatus
    }
    // Opaque artifact/account IDs compare by wire bytes, not Swift's canonical Unicode equality.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        exact(lhs.nativeBuildId, rhs.nativeBuildId) && exact(lhs.loadedBuildId, rhs.loadedBuildId) &&
            lhs.loadedBundleStatus == rhs.loadedBundleStatus && exact(lhs.userId, rhs.userId)
    }
    private static func exact(_ lhs: String?, _ rhs: String?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (a?, b?): return a.utf8.elementsEqual(b.utf8)
        default: return false
        }
    }
    static func validText(_ value: String, maximum: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= maximum &&
            !value.unicodeScalars.contains { $0.value < 32 }
    }
}
