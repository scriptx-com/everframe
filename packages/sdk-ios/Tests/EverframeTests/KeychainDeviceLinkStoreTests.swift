// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import XCTest
@testable import EverframeKit

/// The real Keychain. Runs in a simulator (`swift test` on the macOS host skips it).
final class KeychainDeviceLinkStoreTests: XCTestCase {
    func testKeychainRoundTripAndDelete() throws {
        try XCTSkipUnless(DeviceKey.probeKeychainAvailability(), "Keychain unavailable in this test host")
        let secure = KeychainDeviceLinkSecureStore()
        let account = "test-\(UUID().uuidString)"
        defer { secure.delete(account: account) }
        let data = Data("blob-1".utf8)

        XCTAssertNil(secure.read(account: account))
        XCTAssertTrue(secure.write(data, account: account))
        XCTAssertEqual(secure.read(account: account), data)
        XCTAssertTrue(secure.write(Data("blob-2".utf8), account: account))
        XCTAssertEqual(secure.read(account: account), Data("blob-2".utf8))
        secure.delete(account: account)
        XCTAssertNil(secure.read(account: account))
    }

    func testStoreOverKeychainRoundTrip() throws {
        try XCTSkipUnless(DeviceKey.probeKeychainAvailability(), "Keychain unavailable in this test host")
        let store = DeviceLinkStore(secure: KeychainDeviceLinkSecureStore())
        let endpoint = URL(string: "https://\(UUID().uuidString.lowercased()).example")!
        store.save(DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")), endpoint: endpoint, sdkKey: "k")
        defer { store.clear(endpoint: endpoint, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(fixtureToken)) }
        XCTAssertEqual(store.link(endpoint: endpoint, sdkKey: "k"), DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")))
    }
}
#endif
