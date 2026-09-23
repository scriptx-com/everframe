// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation

/// Bounded, per-start admission for deliberate native Error captures.
/// The lock protects only identity and counters; host getters and storage run
/// after it is released.
internal final class HandledErrorAdmission: @unchecked Sendable {
    internal final class Reservation {
        fileprivate let epoch: Int
        fileprivate let identity: AnyObject?

        fileprivate init(epoch: Int, identity: AnyObject?) {
            self.epoch = epoch
            self.identity = identity
        }
    }

    private final class WeakIdentity {
        weak var value: AnyObject?

        init(_ value: AnyObject) {
            self.value = value
        }
    }

    private let lock = NSLock()
    private let currentEpoch: @Sendable () -> Int
    private var epoch: Int?
    private var accepted: [WeakIdentity] = []
    private var acceptedCount = 0
    private var pending: Reservation?

    internal init(currentEpoch: @escaping @Sendable () -> Int) {
        self.currentEpoch = currentEpoch
    }

    internal func reserve(_ error: any Error, capturedEpoch: Int) -> Reservation? {
        let liveEpoch = currentEpoch()
        guard capturedEpoch == liveEpoch else { return nil }
        let identity: AnyObject? = type(of: error) is AnyClass ? error as AnyObject : nil

        lock.lock()
        defer { lock.unlock() }
        // Start epochs only increase. If a caller paused after its live-epoch
        // read while a newer capture advanced this admission state, it must
        // not reset the successor epoch backwards.
        if let epoch, capturedEpoch < epoch { return nil }
        if epoch != capturedEpoch {
            epoch = capturedEpoch
            accepted.removeAll(keepingCapacity: true)
            acceptedCount = 0
            pending = nil
        }
        accepted.removeAll { $0.value == nil }
        guard pending == nil, acceptedCount < 10 else { return nil }
        if let identity,
           accepted.contains(where: { value in
               guard let acceptedIdentity = value.value else { return false }
               return ObjectIdentifier(acceptedIdentity) == ObjectIdentifier(identity)
           }) {
            return nil
        }
        let reservation = Reservation(epoch: capturedEpoch, identity: identity)
        pending = reservation
        return reservation
    }

    internal func settle(_ reservation: Reservation, durablyAccepted: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard pending === reservation else { return }
        pending = nil
        guard durablyAccepted, epoch == reservation.epoch,
              currentEpoch() == reservation.epoch else { return }
        if let identity = reservation.identity {
            accepted.append(WeakIdentity(identity))
        }
        acceptedCount += 1
    }
}
