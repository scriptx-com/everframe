// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Testing
@testable import EverframeKit

struct InteractionEventPolicyTests {
    @Test func policyUsesTheSameUnambiguousOriginBoundary() throws {
        for host in ambiguousInteractionHosts {
            let origin = "nocturne://" + host
            if let components = URLComponents(string: origin) { #expect(interactionOrigin(components) == nil) }
            let json = String(decoding: try JSONSerialization.data(withJSONObject: ["urlRules": [["origin": origin, "queryKeys": ["token"]]]]), as: UTF8.self)
            #expect(InteractionEventPolicy.parse(json).urlRules.isEmpty)
        }
        let policy = InteractionEventPolicy.parse(#"{"urlRules":[{"origin":"nocturne://title"},{"origin":"https://[2001:db8::1]:8443"}]}"#)
        #expect(policy.urlRules.map(\.origin) == ["nocturne://title", "https://[2001:db8::1]:8443"])
    }
    @Test func defaultsNeverAuthorizeValues() {
        let policy = InteractionEventPolicy.parse(nil)
        #expect(!policy.disabled); #expect(policy.valueTestIds.isEmpty); #expect(policy.launchArgumentKeys.isEmpty)
    }
    @Test func invalidAndOversizedListsFailClosed() {
        let ids = (0...64).map { "\"field\($0)\"" }.joined(separator: ",")
        #expect(InteractionEventPolicy.parse("{\"valueTestIds\":[\(ids)]}").valueTestIds.isEmpty)
        #expect(InteractionEventPolicy.parse("not json").disabled)
        #expect(InteractionEventPolicy.parse(#"{"disabled":"no","valueTestIds":["search"]}"#).disabled)
        #expect(InteractionEventPolicy.parse(#"{"valueTestIds":["search","*"," padded ","search\u0000"]}"#).valueTestIds == ["search"])
    }
    @Test func originsMustBeExactAndPathsExplicit() {
        let policy = InteractionEventPolicy.parse(#"{"urlRules":[{"origin":"https://example.com","queryKeys":["q"],"routes":["/watch/:id"]},{"origin":"https://example.com/private","queryKeys":["token"]},{"origin":"https://user@example.com","queryKeys":["password"]}]}"#)
        #expect(policy.urlRules.count == 1)
        #expect(policy.urlRules.first?.queryKeys == ["q"])
    }
}
