// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class DeviceLinkStoreTests: XCTestCase {
    private let ingest = URL(string: "https://ingest.example")!
    private var secure: InMemoryDeviceLinkSecureStore!
    private var store: DeviceLinkStore!

    override func setUp() {
        super.setUp()
        secure = InMemoryDeviceLinkSecureStore()
        store = DeviceLinkStore(secure: secure)
    }

    func testSaveAndReadPerOriginAndKey() {
        store.save(DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")), endpoint: ingest, sdkKey: "k1")
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k1")?.token, fixtureToken)
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k1")?.owner, .user(name: "Aurimas"))
        XCTAssertEqual(store.link(endpoint: URL(string: "https://INGEST.example:443/api")!, sdkKey: "k1")?.token, fixtureToken)
        XCTAssertNil(store.link(endpoint: ingest, sdkKey: "k2"))
        XCTAssertNil(store.link(endpoint: URL(string: "https://other.example")!, sdkKey: "k1"))
        XCTAssertNil(store.link(endpoint: URL(string: "http://ingest.example")!, sdkKey: "k1"))
        XCTAssertNil(store.link(endpoint: URL(string: "https://ingest.example:8443")!, sdkKey: "k1"))
    }

    func testSaveReplacesThePreviousLink() {
        store.save(DeviceLink(token: fixtureToken, owner: .user(name: "Jonas")), endpoint: ingest, sdkKey: "k")
        store.save(DeviceLink(token: otherToken, owner: .team), endpoint: ingest, sdkKey: "k")
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k"), DeviceLink(token: otherToken, owner: .team))
        XCTAssertEqual(secure.count, 1)
    }

    func testSaveRefusesAnInvalidToken() {
        store.save(DeviceLink(token: "evf_cap_x", owner: .team), endpoint: ingest, sdkKey: "k")
        XCTAssertNil(store.link(endpoint: ingest, sdkKey: "k"))
        XCTAssertEqual(secure.count, 0)
    }

    func testClearOnlyWhenFingerprintMatches() {
        store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k")
        XCTAssertFalse(store.clear(endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(otherToken)))
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k")?.token, fixtureToken)
        XCTAssertTrue(store.clear(endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
        XCTAssertNil(store.link(endpoint: ingest, sdkKey: "k"))
        XCTAssertFalse(store.clear(endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
    }

    func testUpdateOwnerOnlyWhenFingerprintMatches() {
        store.save(DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")), endpoint: ingest, sdkKey: "k")
        XCTAssertFalse(store.updateOwner(.team, endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(otherToken)))
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k")?.owner, .user(name: "Aurimas"))
        XCTAssertTrue(store.updateOwner(.team, endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k"), DeviceLink(token: fixtureToken, owner: .team))
    }

    func testInvalidStoredBlobReadsAsNilAndIsDeleted() throws {
        let account = try XCTUnwrap(DeviceLinkStore.account(endpoint: ingest, sdkKey: "k"))
        _ = secure.write(Data(#"{"token":"evf_cap_x","owner":{"kind":"team"}}"#.utf8), account: account)
        XCTAssertNil(store.link(endpoint: ingest, sdkKey: "k"))
        XCTAssertNil(secure.read(account: account))

        _ = secure.write(Data("not json".utf8), account: account)
        XCTAssertNil(store.link(endpoint: ingest, sdkKey: "k"))
        XCTAssertNil(secure.read(account: account))
    }

    func testAccountIsOpaque() {
        let a = DeviceLinkStore.account(endpoint: ingest, sdkKey: "txx_live_secret")!
        XCTAssertEqual(a.count, 64)
        XCTAssertFalse(a.contains("secret"))
        XCTAssertTrue(a.allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertEqual(a, DeviceLinkStore.account(endpoint: URL(string: "HTTPS://Ingest.Example:443/x")!, sdkKey: "txx_live_secret"))
        XCTAssertNotEqual(a, DeviceLinkStore.account(endpoint: ingest, sdkKey: "other"))
        XCTAssertNil(DeviceLinkStore.account(endpoint: URL(string: "file:///tmp")!, sdkKey: "k"))
        XCTAssertNil(DeviceLinkStore.account(endpoint: URL(string: "https:///nohost")!, sdkKey: "k"))
    }
}
