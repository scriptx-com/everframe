// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import Darwin

/// One process-wide owner. SDK restart must not sweep recordings still being
/// finalized by the previous session. A fresh process removes UUID recording
/// directories left by a crash before allocating its first recording.
@MainActor final class NativeVideoStorage {
    static let shared = NativeVideoStorage(root: FileManager.default.temporaryDirectory
        .appendingPathComponent("TraceItXReplay", isDirectory: true))
    private let root: URL
    private var prepared = false

    init(root: URL) { self.root = root }

    func makeDirectory() throws -> URL {
        let manager = FileManager.default
        if !prepared {
            try manager.createDirectory(at: root, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete])
            for child in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
                guard UUID(uuidString: child.lastPathComponent) != nil else { continue }
                try manager.removeItem(at: child)
            }
            prepared = true
        }
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.protectionKey: FileProtectionType.complete])
        return directory
    }

    /// rmdir is deliberately non-recursive: a transferred movie or an encoder
    /// still unwinding cancellation must never be deleted by directory cleanup.
    nonisolated static func removeIfEmpty(_ directory: URL) {
        directory.withUnsafeFileSystemRepresentation { path in
            if let path { _ = Darwin.rmdir(path) }
        }
    }
}
#endif
