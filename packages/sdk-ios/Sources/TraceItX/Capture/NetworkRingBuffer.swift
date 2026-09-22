// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Lock-protected FIFO ring buffer for captured network entries. Capacity 100
// (per CONTEXT). Append honors TraceItX.shared.captureGate (DEFE-03 kill switch).
//
// PRIV-03R hard invariant — body bytes are captured ONLY in the designated
// body-capture unit (the body path of `TXNetworkCaptureProtocol` on iOS;
// `capture/NetworkBodyTee.kt` on Android), ONLY behind the server-
// authoritative fail-closed gate, ALWAYS redacted before entering the body
// buffer. The metadata `Entry` structurally carries no body field.
//
// Concretely on iOS: NetworkLogEntry has NO request body and NO response
// body fields — this metadata buffer stays body-free by construction. The
// Codable round-trip in NetworkCaptureProtocolTests asserts the schema is
// body-free — adding a body field here would fail that test.
import Foundation

public struct NetworkLogEntry: Codable, Sendable {
    public let timestamp: Date
    public let method: String
    public let url: String
    public let status: Int?
    public let durationMs: Double?
    public let requestHeaders: [String: String]
    public let responseHeaders: [String: String]

    public init(
        timestamp: Date,
        method: String,
        url: String,
        status: Int?,
        durationMs: Double?,
        requestHeaders: [String: String],
        responseHeaders: [String: String]
    ) {
        self.timestamp = timestamp
        self.method = method
        self.url = url
        self.status = status
        self.durationMs = durationMs
        self.requestHeaders = requestHeaders
        self.responseHeaders = responseHeaders
    }
}

public final class NetworkRingBuffer: @unchecked Sendable {
    public static let shared = NetworkRingBuffer(capacity: 100)
    public let capacity: Int
    /// When true (default), `append` consults TraceItX.shared.captureGate.
    /// Set to false ONLY for unit tests that exercise capacity/eviction
    /// independently of global kill-switch state, since cross-suite parallel
    /// tests can flip the global gate mid-run.
    internal let honorsKillGate: Bool

    /// Test-only seam (PR review round 4 Finding F15) — mirrors
    /// `NetworkBodyRingBuffer.preLockHook` exactly: invoked, when set, at
    /// the point between the cheap pre-lock gate read below and
    /// `lock.lock()`. Always nil in production.
    internal var preLockHook: (() -> Void)?

    private let lock = NSLock()
    private var entries: [NetworkLogEntry] = []

    public init(capacity: Int = 100) {
        self.capacity = capacity
        self.honorsKillGate = true
    }

    /// Test-only init that bypasses the global kill-gate check.
    internal init(capacity: Int, honorsKillGate: Bool) {
        self.capacity = capacity
        self.honorsKillGate = honorsKillGate
    }

    public func append(_ e: NetworkLogEntry) {
        // Honor kill switch — capture-side responsibility per DEFE-03.
        //
        // PR review round 4 Finding F15: the check above is only a cheap
        // fast path, evaluated BEFORE the lock is acquired — a thread that
        // reads `captureGate == true` here can still be descheduled before
        // `lock.lock()`, let `kill()` run to completion elsewhere (which
        // flips `captureGate` false and THEN calls `clear()` — see
        // `TraceItX.kill()`), and only then resume and insert into a buffer
        // `clear()` just zeroized. The re-check below, taken while HOLDING
        // the lock immediately before the insert, is the authoritative one:
        // because `kill()` flips the gate strictly before calling `clear()`,
        // observing the gate still open here means `clear()` hasn't run yet
        // and will subsequently take this same lock and wipe this entry;
        // observing it closed means we simply never insert. Either way the
        // post-kill buffer ends up empty.
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        preLockHook?()
        lock.lock(); defer { lock.unlock() }
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        entries.append(e)
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
    }

    public func snapshot() -> [NetworkLogEntry] {
        lock.lock(); defer { lock.unlock() }
        return entries
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
    }
}
