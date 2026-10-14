// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
/// Leaf lock shared by state and breadcrumb producers. Never reset while producers are alive.
final class EvidenceSequence: @unchecked Sendable {
    static let shared = EvidenceSequence()
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.withLock { let result = value; value += 1; return result } }
}
