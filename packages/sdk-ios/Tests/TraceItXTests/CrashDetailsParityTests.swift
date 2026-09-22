// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import XCTest
@testable import TraceItXKit

final class CrashDetailsParityTests: XCTestCase {
    func testAllSixSharedCasesPreserveCompleteSemantics() throws {
        let fixtures = try CrashDetailsFixtureSupport.sharedFixtures()
        XCTAssertEqual(Set(fixtures.map(\.name)),
                       ["default", "masked-key", "nested", "repaired-text", "bounded-loss", "prototype-keys"])
        XCTAssertEqual(fixtures.count, 6)
        for fixture in fixtures {
            let actual = try CrashDetailsFixtureSupport.object(fixture.options)
            XCTAssertEqual(actual as NSDictionary, fixture.expected, fixture.name)
        }
        XCTAssertEqual(try CrashDetailsFixtureSupport.object(nil) as NSDictionary, ["severity": "error"])
    }
}
