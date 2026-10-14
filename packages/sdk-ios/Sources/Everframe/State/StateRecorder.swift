// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Bounded redacted evidence owned by one configured SDK session.
final class StateRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private let now: () -> Double
    private let sequence: EvidenceSequence
    private var state: EverframeReportState?
    private var frozen: EverframeReportState?
    private var customKeys: Set<String> = []
    private var automaticKeys: Set<String> = []
    init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }, sequence: EvidenceSequence = .shared) {
        self.now = now; self.sequence = sequence
    }
    private static var empty: EverframeStateSnapshot { EverframeStateSnapshot(automatic: [:], custom: [:]) }
    private static func bytes<T: Encodable>(_ value: T) -> Int {
        let encoder = EnvelopeBuilder.makeJSONEncoder()
        return (try? encoder.encode(value).count) ?? Int.max
    }
    func reset(initial: EverframeStateSnapshot, startedAt: Double) {
        lock.withLock {
            frozen = nil; customKeys = []; automaticKeys = []
            var safe = Self.empty
            for (namespace, entries) in [(EverframeStateNamespace.custom, initial.custom), (.automatic, initial.automatic)] {
                for key in entries.keys.sorted() {
                    guard StateSanitizer.validKey(key), let value = StateSanitizer.value(entries[key]!, key: key) else { continue }
                    var next = Self.applying(safe, namespace: namespace, key: key, value: value)
                    if next.custom.count > 50 || next.automatic.count > 32 || Self.bytes(next) > 8192 { next = safe }
                    safe = next
                }
            }
            customKeys = Set(safe.custom.keys); automaticKeys = Set(safe.automatic.keys)
            state = EverframeReportState(capturedAt: startedAt, changes: [], checkpoint: nil, current: safe, droppedChanges: 0, initial: safe, startedAt: startedAt)
        }
    }
    @discardableResult func set(_ key: String, value: EverframeStateValue, namespace: EverframeStateNamespace = .custom) -> Bool {
        guard StateSanitizer.validKey(key), let safe = StateSanitizer.value(value, key: key) else { return false }
        return change(key, value: safe, namespace: namespace)
    }
    @discardableResult func clear(_ key: String, namespace: EverframeStateNamespace = .custom) -> Bool {
        guard StateSanitizer.validKey(key) else { return false }
        return change(key, value: nil, namespace: namespace)
    }
    private static func applying(_ snapshot: EverframeStateSnapshot, namespace: EverframeStateNamespace, key: String, value: EverframeStateValue?) -> EverframeStateSnapshot {
        var custom = snapshot.custom; var automatic = snapshot.automatic
        if namespace == .custom { custom[key] = value } else { automatic[key] = value }
        return EverframeStateSnapshot(automatic: automatic, custom: custom)
    }
    private func change(_ key: String, value: EverframeStateValue?, namespace: EverframeStateNamespace) -> Bool {
        lock.withLock {
            guard let old = state else { return false }
            let previous = namespace == .custom ? old.current.custom[key] : old.current.automatic[key]
            if StateSanitizer.equal(previous, value) { return false }
            let known = namespace == .custom ? customKeys : automaticKeys
            if value != nil && !known.contains(key) && known.count >= (namespace == .custom ? 50 : 32) { return false }
            let current = Self.applying(old.current, namespace: namespace, key: key, value: value)
            guard Self.bytes(current.custom) <= 8192 else { return false }
            let t = now()
            let entry = EverframeStateChange(key: key, namespace: namespace, op: value == nil ? .clear : .stateOperationSet, seq: sequence.next(), t: t, value: value)
            var candidate = old.with(capturedAt: t, changes: old.changes + [entry], current: current)
            while candidate.changes.count > 100 || Self.bytes(candidate) > 32512 {
                guard let first = candidate.changes.first else { return false }
                let base = candidate.checkpoint?.values ?? candidate.initial
                let values = Self.applying(base, namespace: first.namespace, key: first.key, value: first.value)
                let checkpoint = EverframeStateCheckpoint(t: first.t, throughSeq: first.seq, values: values)
                candidate = candidate.with(changes: Array(candidate.changes.dropFirst()), checkpoint: checkpoint, droppedChanges: candidate.droppedChanges + 1)
            }
            state = candidate
            if namespace == .custom { customKeys.insert(key) } else { automaticKeys.insert(key) }
            return true
        }
    }
    func snapshot(capturedAt: Double) -> EverframeReportState? { lock.withLock { state?.with(capturedAt: capturedAt) } }
    func freeze(capturedAt: Double) { lock.withLock { if frozen == nil { frozen = state?.with(capturedAt: capturedAt) } } }
    func discardFrozen() { lock.withLock { frozen = nil } }
    func takeFrozen() -> EverframeReportState? { lock.withLock { defer { frozen = nil }; return frozen } }
    func erase() { lock.withLock { state = nil; frozen = nil; customKeys = []; automaticKeys = [] } }
}
