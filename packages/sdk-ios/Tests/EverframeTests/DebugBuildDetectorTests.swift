// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class DebugBuildDetectorTests: XCTestCase {
    /// A provisioning profile is a DER-encoded CMS container that stores its plist as plain bytes.
    /// The fixtures wrap the plist in fake binary bytes on both sides, as a real profile does.
    private func profile(_ plist: String) -> Data {
        var data = Data([0x30, 0x82, 0x2f, 0x1a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0xa0, 0x82, 0x2f, 0x0b])
        data.append(Data(plist.utf8))
        data.append(Data([0xa0, 0x82, 0x0b, 0x2d, 0x30, 0x82, 0x04, 0x00, 0x31, 0x00]))
        return data
    }
    private func plist(entitlements: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>AppIDName</key>
            <string>Everframe Proof</string>
            <key>Entitlements</key>
            <dict>
                <key>application-identifier</key>
                <string>ABCDE12345.dev.everframe.proof</string>
                \(entitlements)
            </dict>
            <key>Name</key>
            <string>iOS Team Provisioning Profile: dev.everframe.proof</string>
        </dict>
        </plist>
        """
    }

    func testDevelopmentProfileIsDebug() {
        let data = profile(plist(entitlements: "<key>get-task-allow</key>\n<true/>"))
        XCTAssertTrue(DebugBuildDetector.isDebugBuild(profile: data, isSimulator: false))
    }
    /// Ad hoc and enterprise profiles set get-task-allow to false.
    func testAdHocOrEnterpriseProfileIsRelease() {
        let data = profile(plist(entitlements: "<key>get-task-allow</key>\n<false/>"))
        XCTAssertFalse(DebugBuildDetector.isDebugBuild(profile: data, isSimulator: false))
    }
    func testProfileWithoutGetTaskAllowIsRelease() {
        XCTAssertFalse(DebugBuildDetector.isDebugBuild(profile: profile(plist(entitlements: "")), isSimulator: false))
    }
    /// App Store and TestFlight builds ship no embedded profile.
    func testMissingProfileIsRelease() {
        XCTAssertFalse(DebugBuildDetector.isDebugBuild(profile: nil, isSimulator: false))
    }
    /// A profile that can't be read counts as a release build, even if get-task-allow appears in it.
    func testMalformedProfileIsRelease() {
        let unknownTag = profile(plist(entitlements: "<key>get-task-allow</key>\n<true/>\n<key>beta</key>\n<maybe/>"))
        let truncated = profile(String(plist(entitlements: "<key>get-task-allow</key>\n<true/>").dropLast("</plist>".count)))
        let notAPlist = Data([0x30, 0x82, 0x01, 0x00, 0xff, 0xfe, 0x00])
        let entitlementsNotADictionary = profile(#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Entitlements</key><true/></dict></plist>"#)
        for (name, data) in [("unknown tag", unknownTag), ("truncated", truncated), ("not a plist", notAPlist),
                             ("entitlements not a dictionary", entitlementsNotADictionary)] {
            XCTAssertFalse(DebugBuildDetector.isDebugBuild(profile: data, isSimulator: false), name)
        }
    }
    func testSimulatorIsDebugWhateverTheProfile() {
        XCTAssertTrue(DebugBuildDetector.isDebugBuild(profile: nil, isSimulator: true))
        let release = profile(plist(entitlements: "<key>get-task-allow</key>\n<false/>"))
        XCTAssertTrue(DebugBuildDetector.isDebugBuild(profile: release, isSimulator: true))
    }
    func testExtractsExactlyThePlistBetweenTheMarkers() throws {
        let xml = plist(entitlements: "<key>get-task-allow</key>\n<true/>")
        let extracted = try XCTUnwrap(DebugBuildDetector.embeddedPlist(in: profile(xml)))
        XCTAssertEqual(String(decoding: extracted, as: UTF8.self), xml)
    }
}
