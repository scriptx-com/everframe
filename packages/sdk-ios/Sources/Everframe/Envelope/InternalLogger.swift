// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Process-wide ring buffer for safeWrap failures. EnvelopeBuilder drains this
// into `captureControl.degradedReason` so the receiver knows the Everframe SDK degraded
// and can flag the report. Public `os.Logger` line is also emitted at
// `.error` so customer-app crash console shows the failure path.
import Foundation
import os

enum InternalLogger {
    /// Logger + NSLock are Sendable in modern Foundation/os — let-bindings need
    /// no isolation modifier. `failures` is mutable global state, protected by
    /// `lock`; `nonisolated(unsafe)` stays only on the var.
    private static let log = Logger(subsystem: "dev.everframe", category: "internal")
    private static let lock = NSLock()
    nonisolated(unsafe) private static var failures: [Failure] = []
    private static let maxBuffered = 50

    struct Failure: Sendable {
        let label: String
        let message: String
        let at: Date
    }

    static func recordSafeWrapFailure(label: StaticString, error: Error) {
        lock.lock(); defer { lock.unlock() }
        let entry = Failure(label: "\(label)", message: "\(error)", at: Date())
        failures.append(entry)
        if failures.count > maxBuffered {
            failures.removeFirst(failures.count - maxBuffered)
        }
        log.error("safeWrap failed: \(entry.label, privacy: .public) — \(entry.message, privacy: .private)")
    }

    /// Drained by EnvelopeBuilder into `captureControl.degradedReason`. After
    /// drain the buffer is cleared so each report only carries new failures.
    @discardableResult
    static func drainFailures() -> [Failure] {
        lock.lock(); defer { lock.unlock() }
        let out = failures
        failures.removeAll()
        return out
    }
}
