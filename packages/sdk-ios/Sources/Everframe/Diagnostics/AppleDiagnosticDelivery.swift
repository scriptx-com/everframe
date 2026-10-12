// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Leaf authority map: transport never opens journals or queries SDK state.
/// Eligible values are exact immutable entries, including frozen destinations.
enum AppleDiagnosticDelivery {
    private struct Permit {
        let owner: UUID
        let entry: OutboxEntry
        let settled: @Sendable () -> Void
    }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var permits: [UUID: Permit] = [:]
    static func isApple(_ entry: OutboxEntry) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: entry.envelopeBytes)) as? [String: Any],
              let payload = object["payload"] as? [String: Any] else { return false }
        return payload["appleDiagnostic"] != nil
    }
    static func allows(_ entry: OutboxEntry, now: Date = Date()) -> Bool {
        lock.withLock {
            guard let permit = permits[entry.reportId], permit.entry == entry else { return false }
            return now >= entry.createdAt && now.timeIntervalSince(entry.createdAt) < AppleDiagnosticStore.lifetime
        }
    }
    static func publish(owner: UUID, entry: OutboxEntry, settled: @escaping @Sendable () -> Void) {
        lock.withLock { permits[entry.reportId] = Permit(owner: owner, entry: entry, settled: settled) }
    }
    static func prune(owner: UUID, now: Date) {
        lock.withLock {
            permits = permits.filter { _, permit in
                permit.owner != owner || (now >= permit.entry.createdAt && now.timeIntervalSince(permit.entry.createdAt) < AppleDiagnosticStore.lifetime)
            }
        }
    }
    static func remove(owner: UUID) { lock.withLock { permits = permits.filter { $0.value.owner != owner } } }
    static func settle(_ entry: OutboxEntry) {
        let callback = lock.withLock { () -> (@Sendable () -> Void)? in
            guard permits[entry.reportId]?.entry == entry else { return nil }
            return permits.removeValue(forKey: entry.reportId)?.settled
        }
        callback?()
    }
}
