// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit) && canImport(XCTest)
import XCTest
import EverframeKit
import EverframeProtocol
@testable import EverframeRN
final class StateBridgeTests: XCTestCase {
    func testSynchronousTypedMutationAndClear() throws {
        defer { Everframe.shared.kill() }
        try Everframe.shared.start(config: EverframeConfig(sdkKey: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        XCTAssertTrue(EverframeBridge.setStateSync("enabled", valueJson: "false"))
        let captured = try XCTUnwrap(Everframe.shared.captureSessionSnapshot().state)
        if case .bool(false) = captured.current.custom["enabled"] {} else { XCTFail("boolean was coerced") }
        for json in ["null", "{}", "[]", "NaN"] { XCTAssertFalse(EverframeBridge.setStateSync("bad", valueJson: json)) }
        XCTAssertTrue(EverframeBridge.clearStateSync("enabled"))
        XCTAssertNil(Everframe.shared.captureSessionSnapshot().state?.current.custom["enabled"])
    }
}
#endif
