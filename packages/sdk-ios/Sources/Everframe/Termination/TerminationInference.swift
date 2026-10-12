// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Pure next-launch rules for a previous process that left no crash report. iOS and tvOS deliver
/// jetsam and watchdog kills as SIGKILL, which no in-process handler observes, so the SDK infers
/// them from the run record. The caller has already established that the run left no crash report.
enum TerminationInference {
    enum Skip: String, Equatable, Sendable { case cleanExit, debugger, notArmed, appChanged, osChanged, rebooted, notForeground, stale }
    enum Cause: String, Equatable, Sendable {
        case lowMemory = "low_memory", unresponsive, unexplained
        var exceptionType: String {
            switch self {
            case .lowMemory: return "Low memory kill"
            case .unresponsive: return "Unresponsive termination"
            case .unexplained: return "Abnormal foreground termination"
            }
        }
        /// sha256("<exceptionType>|apple_inferred_<cause>")[:16]; never Android's OS-confirmed group.
        var fingerprint: String {
            switch self {
            case .lowMemory: return "165254e7d389a4b6"
            case .unresponsive: return "a96ea84123b3e05f"
            case .unexplained: return "07f0b3e86836c84e"
            }
        }
    }
    enum Verdict: Equatable, Sendable { case skip(Skip), inferred(Cause) }
    struct Context: Sendable { let current: TerminationIdentity; let now: Date }

    static let mechanism = "apple-termination-inference"
    static let stallThresholdMs: UInt64 = 5_000
    static let memoryWindow: TimeInterval = 60
    static let rebootJitter: Int64 = 30
    static let maximumAge: TimeInterval = 14 * 86_400
    static let futureSkew: TimeInterval = 300

    /// Rules 2-9 of the spec, in order; the first failure skips inference.
    static func evaluate(_ record: TerminationRunRecord, current: TerminationIdentity, now: Date) -> Verdict {
        if record.exitCalled || record.terminateNotified { return .skip(.cleanExit) }
        if record.debuggerSeen { return .skip(.debugger) }
        guard record.armed, record.contextID != nil else { return .skip(.notArmed) }
        guard record.identity.appVersion == current.appVersion, record.identity.appBuild == current.appBuild,
              let executable = record.identity.executableUUID, executable == current.executableUUID else { return .skip(.appChanged) }
        guard record.identity.osVersion == current.osVersion else { return .skip(.osChanged) }
        guard record.identity.bootTime > 0, current.bootTime > 0,
              abs(current.bootTime - record.identity.bootTime) <= rebootJitter else { return .skip(.rebooted) }
        // A hung main thread cannot deliver willResignActive, so a stalled process's state may be stale.
        let stalled = record.mainStallMs >= stallThresholdMs
        let foreground = record.appState == .active || (stalled && (record.appState == .inactive || record.appState == .launching))
        guard foreground else { return .skip(.notForeground) }
        let lastSeen = record.lastSeenAt
        guard lastSeen.timeIntervalSince(now) <= futureSkew, now.timeIntervalSince(lastSeen) <= maximumAge else { return .skip(.stale) }
        // A jetsam kill is instant whatever the main thread is doing, so memory evidence wins.
        if memoryEvidence(record) { return .inferred(.lowMemory) }
        return .inferred(stalled ? .unresponsive : .unexplained)
    }

    /// A memory warning or critical pressure within 60 s before last seen, or headroom at most 20 %.
    static func memoryEvidence(_ record: TerminationRunRecord) -> Bool {
        let lastSeen = record.lastSeenAt
        if let warned = record.lastWarningAt, lastSeen.timeIntervalSince(warned) <= memoryWindow { return true }
        if record.pressure == .critical, let changed = record.pressureChangedAt, lastSeen.timeIntervalSince(changed) <= memoryWindow { return true }
        guard let footprint = record.footprintBytes, let available = record.availableBytes else { return false }
        // available / (footprint + available) <= 1/5, exactly.
        let (scaled, scaledOverflow) = available.multipliedReportingOverflow(by: 5)
        let (limit, limitOverflow) = footprint.addingReportingOverflow(available)
        return !scaledOverflow && !limitOverflow && limit > 0 && scaled <= limit
    }

    static func message(_ cause: Cause, _ record: TerminationRunRecord) -> String {
        var facts = ["inferred"]
        if let footprint = record.footprintBytes { facts.append("footprint \(footprint / 1024) KiB") }
        if let available = record.availableBytes { facts.append("\(available / 1024) KiB available") }
        if record.memoryWarnings > 0 { facts.append("\(record.memoryWarnings) memory warning" + (record.memoryWarnings == 1 ? "" : "s")) }
        let detail = " (" + facts.joined(separator: ", ") + ")"
        switch cause {
        case .lowMemory: return "Killed for low memory while in the foreground" + detail
        case .unresponsive: return "Terminated after the main thread stopped responding for \(record.mainStallMs / 1000) s in the foreground" + detail
        case .unexplained: return "Terminated in the foreground without a crash report" + detail
        }
    }

    /// `exposure` is the run's frozen release-health pointer; it is attached only when it names this process.
    static func evidence(record: TerminationRunRecord, cause: Cause, evidenceID: String, lastSeen: Date, collectedAt: Date,
                         exposure: EverframeNativeExposure?) -> EverframeInferredTerminationEvidence {
        let launch = record.launchID.uuidString.lowercased()
        let kib = { (bytes: UInt64?) in bytes.map { Int(min($0 / 1024, 1_000_000_000)) } }
        let canonical = { (date: Date?) in date.map(ReleaseHealthDate.canonical) }
        let state: EverframeInferredTerminationAppState
        switch record.appState {
        case .active: state = .active
        case .launching: state = .launching
        case .inactive, .background, .unknown: state = .inactive
        }
        let pressure: EverframeInferredTerminationPressure
        switch record.pressure {
        case .normal: pressure = .normal
        case .warning: pressure = .warning
        case .critical: pressure = .critical
        }
        let thermals: [EverframeInferredTerminationThermalState] = [.nominal, .fair, .serious, .critical]
        let thermal = thermals[min(max(record.thermalState, 0), 3)]
        let causeValue: EverframeInferredTerminationCause
        switch cause {
        case .lowMemory: causeValue = .lowMemory
        case .unresponsive: causeValue = .unresponsive
        case .unexplained: causeValue = .unexplained
        }
        let apple = EverframeInferredTerminationApple(appState: state, availableKB: kib(record.availableBytes),
            footprintKB: kib(record.footprintBytes), lastMemoryWarningAt: canonical(record.lastWarningAt),
            mainThreadStallMS: record.mainStallMs > 0 ? Int(min(record.mainStallMs, 86_400_000)) : nil,
            memoryPressure: pressure, memorySampledAt: canonical(record.sampledAt),
            memoryWarnings: min(record.memoryWarnings, 1_000_000), thermalState: thermal)
        return EverframeInferredTerminationEvidence(apple: apple,
            attribution: EverframeInferredTerminationAttribution(process: .sdkRunRecord, release: .frozen,
                session: .unavailable, webExposure: .unavailable),
            cause: causeValue, collectedAt: collectedAt, evidenceID: evidenceID, kind: .processExit, lastSeenAt: lastSeen,
            nativeExposure: exposure?.processLaunchID == launch ? exposure : nil, outcome: .terminated, processLaunchID: launch,
            provenance: .appleNextLaunchInference, rules: .appleForegroundV1, scope: .osProcess, version: 1)
    }
}
