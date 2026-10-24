// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. Its documented API stays as
// deprecated no-op stubs until the next major so apps that follow the docs
// keep compiling. The first pairing call in a process logs one warning that
// points the developer at device linking and quick capture.
import Foundation
import os

/// The single message every deprecated Companion symbol carries, and the
/// warning logged the first time a pairing entry point is called.
let companionRemovedMessage =
    "Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture."

enum CompanionDeprecation {
    private static let log = Logger(subsystem: "dev.everframe", category: "companion")
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _emittedCount = 0

    /// How many times the warning has been logged in this process: 0 or 1.
    static var emittedCount: Int { lock.withLock { _emittedCount } }

    /// Logs the removal warning once per process. Never throws, never blocks.
    static func warnOnce() {
        let first: Bool = lock.withLock {
            guard _emittedCount == 0 else { return false }
            _emittedCount = 1
            return true
        }
        guard first else { return }
        log.warning("\(companionRemovedMessage, privacy: .public)")
    }

    static func __resetForTests() {
        lock.withLock { _emittedCount = 0 }
    }
}
