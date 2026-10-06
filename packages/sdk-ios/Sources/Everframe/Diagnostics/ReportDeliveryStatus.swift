// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Best-effort process-local observations, not a per-report delivery guarantee.
public struct ReportDeliveryStatus: Encodable, Sendable {
    public let schemaVersion = 1
    public internal(set) var status = "not-started"
    public internal(set) var reason = "no-start"
    public let scope = "native-runtime-observations"
    public let coverage = "best-effort"
    public internal(set) var revision = 0
    public internal(set) var capture = ReportCaptureStatus()
    public internal(set) var queue = ReportQueueStatus()
    public internal(set) var transport = Dictionary(uniqueKeysWithValues: ReportTransportOrigin.allCases.map { ($0.rawValue, ReportTransportStatus()) })

    public func toJSON() throws -> String {
        String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
    }
}

public struct ReportCaptureStatus: Encodable, Sendable {
    public internal(set) var enabled = false
    public internal(set) var paths = Dictionary(uniqueKeysWithValues: ReportCapturePath.allCases.map {
        ($0.rawValue, ReportCapturePathStatus(supported: $0 != .jvmUncaught))
    })
}
public struct ReportCapturePathStatus: Encodable, Sendable {
    public let supported: Bool
    public internal(set) var settledAttempts = 0
    public internal(set) var outcomes = Dictionary(uniqueKeysWithValues: ReportCaptureOutcome.allCases.map { ($0.rawValue, 0) })
    public internal(set) var lastOutcome: String?
}
public struct ReportQueueStatus: Encodable, Sendable {
    public let scope = "sdk-report-outbox"
    public internal(set) var observation = "not-observed"
    public internal(set) var quality = "unknown"
    public internal(set) var pendingCount: Int?
    public let capacityPolicy = "evict-oldest"
    public let terminalHttpPolicy = "attempt-remove"
    public internal(set) var operations = Dictionary(uniqueKeysWithValues: ReportQueueOperation.allCases.map { ($0.rawValue, 0) })
    public internal(set) var lastFailure: String?
    public internal(set) var migration = "not-observed"
}
public struct ReportTransportStatus: Encodable, Sendable {
    public internal(set) var settledAttempts = 0
    public internal(set) var outcomes = Dictionary(uniqueKeysWithValues: ReportTransportOutcome.allCases.map { ($0.rawValue, 0) })
    public internal(set) var lastOutcome: String?
    public internal(set) var lastHttpStatus: Int?
}

enum ReportCapturePath: String, CaseIterable { case nativeHandled = "native-handled", bridgeHandled = "bridge-handled", bridgeAutomatic = "bridge-automatic", jvmUncaught = "jvm-uncaught" }
enum ReportCaptureOutcome: String, CaseIterable { case persisted, disabled, admissionSuppressed = "admission-suppressed", reentrant, invalidInput = "invalid-input", ownershipLost = "ownership-lost", storageUnavailable = "storage-unavailable", failed }
enum ReportQueueQuality: String { case complete, partial, unknown }
enum ReportQueueOperation: String, CaseIterable { case enqueueCommitted = "enqueue-committed", enqueueFailed = "enqueue-failed", capacityEvicted = "capacity-evicted", removedAfterAcceptance = "removed-after-acceptance", removedAfterTerminal = "removed-after-terminal", removalFailed = "removal-failed", readFailed = "read-failed" }
enum ReportStorageFailure: String { case capacity, keyUnavailable = "key-unavailable", corrupt, io, revoked, invalidEntry = "invalid-entry", busy, unknown, unsupportedFormat = "unsupported-format" }
enum ReportTransportOrigin: String, CaseIterable { case liveSubmit = "live-submit", outboxDrain = "outbox-drain" }
enum ReportTransportOutcome: String, CaseIterable { case serverAccepted = "server-accepted", retryableHTTP = "retryable-http", terminalHTTP = "terminal-http", networkFailure = "network-failure", authorizationCancelled = "authorization-cancelled", cancelled, failed }
