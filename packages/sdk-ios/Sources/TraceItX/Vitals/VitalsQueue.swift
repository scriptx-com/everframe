// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// One process-lifetime serial utility queue shared by the flush timer, the
// sampler tick and transport retries — the Dispatch twin of Android's
// `VitalsThread`. Serial so the sampler's pause/resume writes and its tick
// never interleave.
import Foundation

enum VitalsQueue {
    static let shared = DispatchQueue(label: "com.traceitx.vitals", qos: .utility)
}

/// Minimal lock box for cross-queue bookkeeping (shared by production and tests).
final class Locked<T>: @unchecked Sendable {
    private var v: T
    private let l = NSLock()
    init(_ v: T) { self.v = v }
    var value: T { l.lock(); defer { l.unlock() }; return v }
    func mutate(_ f: (inout T) -> Void) { l.lock(); f(&v); l.unlock() }
}
