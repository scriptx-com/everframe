// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public struct ReleaseHealthConfiguration: Equatable, Sendable {
    public enum LoadedBundleStatus: String, Sendable { case known, unknown; case notApplicable = "not_applicable" }
    public enum ValidationError: Error { case invalidBuildIdentity }
    public let nativeBuildId: String
    public let loadedBuildId: String?
    public let loadedBundleStatus: LoadedBundleStatus

    /// Supply artifact identity, and only a bundle actually loaded by the app.
    public init(nativeBuildId: String, loadedBuildId: String?, loadedBundleStatus: LoadedBundleStatus) throws {
        guard Self.validText(nativeBuildId, maximum: 200),
              loadedBuildId.map({ Self.validText($0, maximum: 200) }) ?? true,
              (loadedBundleStatus == .known) == (loadedBuildId != nil) else { throw ValidationError.invalidBuildIdentity }
        self.nativeBuildId = nativeBuildId; self.loadedBuildId = loadedBuildId; self.loadedBundleStatus = loadedBundleStatus
    }
    static func validText(_ value: String, maximum: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= maximum &&
            !value.unicodeScalars.contains { $0.value < 32 }
    }
}
