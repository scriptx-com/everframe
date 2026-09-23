// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
@testable import EverframeProtocol
import Foundation

struct PayloadRoundTripTests {
    @Test func regeneratedVitalsSurviveRoundTrip() throws {
        let input = Data(#"{"vitals":[{"kind":"sample","t":100,"mem":42,"cpu":3}]}"#.utf8)
        let payload = try EverframePayload(data: input)
        let encoded = try payload.jsonData()
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let samples = try #require(json["vitals"] as? [[String: Any]])
        #expect(samples.count == 1)
        #expect(samples[0]["mem"] as? Int == 42)
        #expect(samples[0]["t"] as? Int == 100)
    }
}
