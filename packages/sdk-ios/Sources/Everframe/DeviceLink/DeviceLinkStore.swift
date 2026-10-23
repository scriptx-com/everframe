// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The device's link: its `evf_dev_` token and the owner it is linked to. Kept
// in the Keychain, one item per ingest origin and SDK key, so a token is only
// ever sent back to the origin and app that issued it. The Keychain account is
// an opaque hash: it names neither the origin nor the key.
//
// Clears and owner updates name the fingerprint of the token their request was
// sent with, and apply only while that same token is stored. A late reply
// about an old token never touches a newer one.
//
// SECURITY: never log the token.
import CryptoKit
import Foundation
import Security

struct DeviceLink: Codable, Equatable, Sendable {
    let token: String
    let owner: DeviceLinkOwner
}

/// Raw secure storage, injected so host tests run without a Keychain.
protocol DeviceLinkSecureStore: Sendable {
    func read(account: String) -> Data?
    func write(_ data: Data, account: String) -> Bool
    func delete(account: String)
}

/// Generic-password items under service `dev.everframe.device-link`, readable
/// after first unlock and never migrated to another device.
struct KeychainDeviceLinkSecureStore: DeviceLinkSecureStore {
    static let service = "dev.everframe.device-link"

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
    }

    func read(account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return status == errSecSuccess ? (item as? Data) : nil
    }

    func write(_ data: Data, account: String) -> Bool {
        // Delete then add, as `DeviceKey` does, so a stale value is replaced.
        let query = baseQuery(account: account)
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
    }

    func delete(account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }
}

final class DeviceLinkStore: @unchecked Sendable {
    static let shared = DeviceLinkStore(secure: KeychainDeviceLinkSecureStore())

    private let lock = NSLock()
    private let secure: DeviceLinkSecureStore

    init(secure: DeviceLinkSecureStore) {
        self.secure = secure
    }

    /// The stored link for this origin and key. A blob that fails to decode,
    /// or holds an invalid token, is deleted and reads as nil.
    func link(endpoint: URL, sdkKey: String) -> DeviceLink? {
        guard let account = Self.account(endpoint: endpoint, sdkKey: sdkKey) else { return nil }
        lock.lock(); defer { lock.unlock() }
        return readLocked(account: account)
    }

    /// Stores `link`, replacing any previous one. False when nothing was
    /// stored: an invalid token, an unusable origin, or a refused write.
    @discardableResult
    func save(_ link: DeviceLink, endpoint: URL, sdkKey: String) -> Bool {
        guard DeviceLinkToken.isValid(link.token),
              let account = Self.account(endpoint: endpoint, sdkKey: sdkKey),
              let data = try? JSONEncoder().encode(link) else { return false }
        lock.lock(); defer { lock.unlock() }
        return secure.write(data, account: account)
    }

    /// Deletes the link only while the stored token's fingerprint is `ifFingerprint`.
    @discardableResult
    func clear(endpoint: URL, sdkKey: String, ifFingerprint: String) -> Bool {
        guard let account = Self.account(endpoint: endpoint, sdkKey: sdkKey) else { return false }
        lock.lock(); defer { lock.unlock() }
        guard let current = readLocked(account: account),
              DeviceLinkToken.fingerprint(current.token) == ifFingerprint else { return false }
        secure.delete(account: account)
        return true
    }

    /// Replaces the owner only while the stored token's fingerprint is `ifFingerprint`.
    @discardableResult
    func updateOwner(_ owner: DeviceLinkOwner, endpoint: URL, sdkKey: String, ifFingerprint: String) -> Bool {
        guard let account = Self.account(endpoint: endpoint, sdkKey: sdkKey) else { return false }
        lock.lock(); defer { lock.unlock() }
        guard let current = readLocked(account: account),
              DeviceLinkToken.fingerprint(current.token) == ifFingerprint else { return false }
        if current.owner == owner { return true }
        guard let data = try? JSONEncoder().encode(DeviceLink(token: current.token, owner: owner)) else { return false }
        return secure.write(data, account: account)
    }

    /// Hex SHA-256 (64 characters) of `"<scheme>://<host>:<port>\n<sdkKey>"`,
    /// scheme and host lowercased and the default port filled in. nil for a
    /// non-http(s) URL or one without a host.
    static func account(endpoint: URL, sdkKey: String) -> String? {
        guard let components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host?.lowercased(), !host.isEmpty else { return nil }
        let port = components.port ?? (scheme == "https" ? 443 : 80)
        let material = "\(scheme)://\(host):\(port)\n\(sdkKey)"
        return SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func readLocked(account: String) -> DeviceLink? {
        guard let data = secure.read(account: account) else { return nil }
        guard let link = try? JSONDecoder().decode(DeviceLink.self, from: data),
              DeviceLinkToken.isValid(link.token) else {
            secure.delete(account: account)
            return nil
        }
        return link
    }
}
