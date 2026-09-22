// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Lock-protected FIFO ring buffer for captured log lines. Capacity 100 (memory-
// bounded to the last 100; matches web + Android). Append honors
// TraceItX.shared.captureGate (DEFE-03).
//
// Per RESEARCH Finding 5 — OSLogStore is sim-only on App Store builds, so we
// run our OWN ring buffer fed by stderr/stdout `dup2` intercept. Redaction is
// applied at append time by StderrIntercept (PRIV-03).
import Foundation

public struct LogEntry: Codable, Sendable {
    public let timestamp: Date
    public let level: String  // "default" | "info" | "error" | "fault"
    public let message: String  // already redaction-applied at append time

    public init(timestamp: Date, level: String, message: String) {
        self.timestamp = timestamp
        self.level = level
        self.message = message
    }
}

public final class LogRingBuffer: @unchecked Sendable {
    public static let shared = LogRingBuffer(capacity: 100)
    public let capacity: Int
    /// See NetworkRingBuffer.honorsKillGate — same rationale.
    internal let honorsKillGate: Bool
    private let lock = NSLock()
    private var entries: [LogEntry] = []

    public init(capacity: Int = 100) {
        self.capacity = capacity
        self.honorsKillGate = true
    }

    /// Test-only init that bypasses the global kill-gate check.
    internal init(capacity: Int, honorsKillGate: Bool) {
        self.capacity = capacity
        self.honorsKillGate = honorsKillGate
    }

    public func append(_ e: LogEntry) {
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        lock.lock(); defer { lock.unlock() }
        entries.append(e)
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
    }

    public func snapshot() -> [LogEntry] {
        lock.lock(); defer { lock.unlock() }
        return entries
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
    }
}
