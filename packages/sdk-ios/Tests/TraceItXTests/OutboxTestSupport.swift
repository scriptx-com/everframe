// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
@testable import TraceItXKit

extension JSONLOutbox {
    /// Real encryption with an explicit fixture key; tool-hosted XCTest has no
    /// Keychain entitlement. Production constructors never use this initializer.
    convenience init(testFileURL: URL, maxEntries: Int = 50, maxTotalBytes: Int = 64 * 1024 * 1024) {
        self.init(fileURL: testFileURL, maxEntries: maxEntries, maxTotalBytes: maxTotalBytes,
            keyProvider: { Data(repeating: 0xA7, count: 32) })
    }
}
