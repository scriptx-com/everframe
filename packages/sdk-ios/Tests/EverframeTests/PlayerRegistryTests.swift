// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class PlayerRegistryTests: XCTestCase {
    func testAReservedRegistrationIsInvisibleUntilItIsPublished() {
        let r = PlayerRegistry()
        let reg = r.reserve(FakeIntegration(), name: "a")
        XCTAssertTrue(r.live().isEmpty); XCTAssertFalse(r.isLive(reg.token))
        r.publish(reg)
        XCTAssertEqual(r.live().map(\.id), ["p1"]); XCTAssertTrue(r.isLive(reg.token))
    }
    func testMintsIdsInAttachOrderAndNeverReusesThem() {
        let r = PlayerRegistry()
        let a = r.reserve(FakeIntegration(), name: nil), b = r.reserve(FakeIntegration(), name: nil)
        r.publish(a); r.publish(b)
        _ = r.unregister(a.token)
        let c = r.reserve(FakeIntegration(), name: nil)
        XCTAssertEqual([a.id, b.id, c.id], ["p1", "p2", "p3"])
    }
    func testUnregisterIsIdempotentAndAStaleTokenCannotRemoveALaterRegistration() {
        let r = PlayerRegistry()
        let a = r.reserve(FakeIntegration(), name: nil); r.publish(a)
        XCTAssertNotNil(r.unregister(a.token)); XCTAssertNil(r.unregister(a.token))
        let b = r.reserve(FakeIntegration(), name: nil); r.publish(b)
        XCTAssertNil(r.unregister(a.token)); XCTAssertEqual(r.live().map(\.id), ["p2"])
    }
    func testClearReturnsWhatWasLiveAndKeepsTheIdCounter() {
        let r = PlayerRegistry()
        r.publish(r.reserve(FakeIntegration(), name: nil)); r.publish(r.reserve(FakeIntegration(), name: nil))
        XCTAssertEqual(r.clear().count, 2); XCTAssertTrue(r.live().isEmpty)
        XCTAssertEqual(r.reserve(FakeIntegration(), name: nil).id, "p3")
    }
    func testNameIsCutTo64Chars() {
        let r = PlayerRegistry()
        XCTAssertEqual(r.reserve(FakeIntegration(), name: String(repeating: "n", count: 100)).name?.count, 64)
    }
}
