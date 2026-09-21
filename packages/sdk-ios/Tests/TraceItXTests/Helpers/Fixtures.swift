// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

enum Fixtures {
    static func canonicalMinimalEnvelopeData() throws -> Data {
        let url = Bundle.module.url(forResource: "minimal-envelope", withExtension: "json")!
        return try Data(contentsOf: url)
    }
}
