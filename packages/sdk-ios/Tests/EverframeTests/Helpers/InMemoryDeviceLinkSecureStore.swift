// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
@testable import EverframeKit

/// A `DeviceLinkSecureStore` held in memory, for host tests.
final class InMemoryDeviceLinkSecureStore: DeviceLinkSecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    func read(account: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[account]
    }

    func write(_ data: Data, account: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        items[account] = data
        return true
    }

    func delete(account: String) {
        lock.lock(); defer { lock.unlock() }
        items[account] = nil
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return items.count
    }
}
