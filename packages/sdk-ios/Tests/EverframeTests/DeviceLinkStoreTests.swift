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

    func testSaveReportsWhetherTheLinkWasStored() {
        XCTAssertTrue(store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k"))
        XCTAssertFalse(store.save(DeviceLink(token: "evf_cap_x", owner: .team), endpoint: ingest, sdkKey: "k"))
        XCTAssertFalse(store.save(DeviceLink(token: fixtureToken, owner: .team),
                                  endpoint: URL(string: "ftp://ingest.example")!, sdkKey: "k"))
        final class Refusing: DeviceLinkSecureStore, @unchecked Sendable {
            func read(account: String) -> Data? { nil }
            func write(_ data: Data, account: String) -> Bool { false }
            func delete(account: String) {}
        }
        XCTAssertFalse(DeviceLinkStore(secure: Refusing())
            .save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k"))
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

/// The Keychain replace: an existing item is updated in place, so a failed
/// write never leaves the device without its previous link.
final class KeychainDeviceLinkReplaceTests: XCTestCase {
    func testReplacingUpdatesInPlaceWithoutDeleting() {
        let keychain = FakeKeychain()
        let secure = KeychainDeviceLinkSecureStore(calls: keychain.calls)
        XCTAssertTrue(secure.write(Data("old".utf8), account: "a"))
        keychain.failAdd = true
        XCTAssertTrue(secure.write(Data("new".utf8), account: "a"))
        XCTAssertEqual(secure.read(account: "a"), Data("new".utf8))
        XCTAssertFalse(keychain.log.contains("delete"))
        XCTAssertTrue(keychain.updatedWithAccessibility)
    }

    func testAFailedReplaceKeepsTheOldItem() {
        let keychain = FakeKeychain()
        let secure = KeychainDeviceLinkSecureStore(calls: keychain.calls)
        XCTAssertTrue(secure.write(Data("old".utf8), account: "a"))
        keychain.failAdd = true
        keychain.failUpdate = true
        XCTAssertFalse(secure.write(Data("new".utf8), account: "a"))
        XCTAssertEqual(secure.read(account: "a"), Data("old".utf8))
    }

    func testAFirstWriteAdds() {
        let keychain = FakeKeychain()
        let secure = KeychainDeviceLinkSecureStore(calls: keychain.calls)
        XCTAssertTrue(secure.write(Data("v".utf8), account: "a"))
        XCTAssertEqual(secure.read(account: "a"), Data("v".utf8))
        XCTAssertFalse(keychain.log.contains("delete"))
        secure.delete(account: "a")
        XCTAssertNil(secure.read(account: "a"))
    }
}

/// An in-memory stand-in for the Security item calls, keyed by account.
private final class FakeKeychain: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var entries: [String] = []
    private var updatedAccessible = false
    var failAdd = false
    var failUpdate = false

    var log: [String] { lock.lock(); defer { lock.unlock() }; return entries }
    var updatedWithAccessibility: Bool { lock.lock(); defer { lock.unlock() }; return updatedAccessible }

    var calls: KeychainDeviceLinkSecureStore.Calls {
        KeychainDeviceLinkSecureStore.Calls(
            copyMatching: { [self] query, out in copy(query, out) },
            add: { [self] attrs, _ in add(attrs) },
            update: { [self] query, attrs in update(query, attrs) },
            delete: { [self] query in delete(query) })
    }

    private func account(_ dictionary: CFDictionary) -> String {
        (dictionary as NSDictionary)[kSecAttrAccount as String] as? String ?? ""
    }

    private func copy(_ query: CFDictionary, _ out: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        guard let data = items[account(query)] else { return errSecItemNotFound }
        out?.pointee = data as CFData
        return errSecSuccess
    }

    private func add(_ attrs: CFDictionary) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        entries.append("add")
        if failAdd { return errSecIO }
        let key = account(attrs)
        guard items[key] == nil else { return errSecDuplicateItem }
        items[key] = (attrs as NSDictionary)[kSecValueData as String] as? Data
        return errSecSuccess
    }

    private func update(_ query: CFDictionary, _ attrs: CFDictionary) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        entries.append("update")
        let key = account(query)
        guard items[key] != nil else { return errSecItemNotFound }
        if failUpdate { return errSecIO }
        let changes = attrs as NSDictionary
        items[key] = changes[kSecValueData as String] as? Data
        updatedAccessible = (changes[kSecAttrAccessible as String] as? String)
            == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        return errSecSuccess
    }

    private func delete(_ query: CFDictionary) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        entries.append("delete")
        return items.removeValue(forKey: account(query)) == nil ? errSecItemNotFound : errSecSuccess
    }
}
