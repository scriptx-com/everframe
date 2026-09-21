// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Security

enum OutboxStorageError: Error, Equatable {
    case capacityExceeded, invalidKey, keychain(OSStatus)
}

/// Dedicated encryption key. Never replace a readable key or return a generated
/// key until persistence succeeds. Keychain lock/errors fail closed.
enum OutboxEncryptionKey {
    private static let lock = NSLock()
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.traceitx.outbox-encryption-v1",
        kSecAttrAccount as String: "default",
    ] }

    static func getOrCreate() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        if let existing = try read() { return existing }
        var key = Data(count: 32)
        let status = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw OutboxStorageError.keychain(status) }
        var attributes = query
        attributes[kSecValueData as String] = key
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(attributes as CFDictionary, nil)
        if added == errSecDuplicateItem, let existing = try read() { return existing }
        guard added == errSecSuccess else { throw OutboxStorageError.keychain(added) }
        return key
    }

    private static func read() throws -> Data? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw OutboxStorageError.keychain(status) }
        guard let key = item as? Data, key.count == 32 else { throw OutboxStorageError.invalidKey }
        return key
    }
}
