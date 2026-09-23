// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Security

/// Per-install device key (32 random bytes) stored in Keychain with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` ACL (AUTH-01, T-04-19).
///
/// LOCKED: ACL must remain `AfterFirstUnlockThisDeviceOnly` — never `Always`.
public enum DeviceKey {
    private static let SERVICE = "dev.everframe.device-key"
    private static let ACCOUNT = "default"
    private static let KEY_LENGTH = 32

    /// Returns the 32-byte device key, generating + persisting it on first call.
    @discardableResult
    public static func getOrCreate() -> Data {
        if let existing = read() { return existing }
        var bytes = Data(count: KEY_LENGTH)
        let status = bytes.withUnsafeMutableBytes { ptr -> Int32 in
            guard let base = ptr.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, KEY_LENGTH, base)
        }
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed (status=\(status))")
        write(bytes)
        return bytes
    }

    /// Returns true iff this process can read+write the keychain. macOS unit-test
    /// targets without code-signing return false because `SecItemAdd` rejects
    /// with `errSecMissingEntitlement`; tests use this to skip without failing.
    public static func probeKeychainAvailability() -> Bool {
        let probeService = "dev.everframe.probe.\(UUID().uuidString)"
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: probeService,
            kSecAttrAccount as String: "probe",
            kSecValueData as String: Data([0x01]),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let addStatus = SecItemAdd(attrs as CFDictionary, nil)
        if addStatus != errSecSuccess { return false }
        // Cleanup probe.
        let delQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: probeService,
            kSecAttrAccount as String: "probe",
        ]
        _ = SecItemDelete(delQuery as CFDictionary)
        return true
    }

    private static func read() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SERVICE,
            kSecAttrAccount as String: ACCOUNT,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return status == errSecSuccess ? (item as? Data) : nil
    }

    private static func write(_ data: Data) {
        // Idempotent: delete-then-add so a second call replaces a stale value.
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SERVICE,
            kSecAttrAccount as String: ACCOUNT,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var attrs = baseQuery
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemAdd(attrs as CFDictionary, nil)
    }
}
