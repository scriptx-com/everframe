// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DeviceMetadata snapshot — required-fields populated, Codable round-trips.
import Testing
import Foundation
@testable import TraceItXKit

@MainActor
struct DeviceMetadataTests {
    @Test func snapshotReturnsAllRequiredFields() {
        let m = DeviceMetadata.snapshot()
        #expect(!m.model.isEmpty)
        #expect(!m.osName.isEmpty)
        #expect(!m.osVersion.isEmpty)
        #expect(!m.locale.isEmpty)
        #expect(!m.timezone.isEmpty)
    }

    @Test func snapshotCodableRoundTrip() throws {
        let m = DeviceMetadata.snapshot()
        let data = try JSONEncoder().encode(m)
        let decoded = try JSONDecoder().decode(DeviceMetadata.self, from: data)
        #expect(decoded.model == m.model)
        #expect(decoded.osName == m.osName)
        #expect(decoded.osVersion == m.osVersion)
        #expect(decoded.locale == m.locale)
        #expect(decoded.timezone == m.timezone)
    }
}
