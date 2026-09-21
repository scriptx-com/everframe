// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Stable companion device identity (naming spec 2026-08-24 §1). Port of
// `packages/sdk-react/src/companion/device-id.ts` + `device-facts.ts` to the
// Keychain/UIDevice world — same resolution order, same hashing contract.
//
// Resolution chain, most-stable-first:
//   1. Explicit host config (MDM id, provisioning serial) — the host knows
//      best, and is honored on EVERY call (unlike the Keychain path there is
//      no "first call wins" memo here; `RelayWSClient` is what memoizes,
//      once, per client).
//   2. Keychain-stored random UUID, generated on first use and persisted —
//      survives app relaunch, dies on uninstall (the iOS analogue of the
//      web module's localStorage UUID; there is no TV-scoped hardware id to
//      reach for here the way Tizen/webOS have one).
//
// PRIVACY: an explicit id is HASHED (SHA-256 → UUID shape) before it ever
// reaches `AnnounceDevice.id` — the raw MDM/provisioning identifier never
// rides the wire. The Keychain-stored id is already an opaque random UUID,
// so it ships as-is (mirrors `DeviceKey`'s "already random, nothing to
// scrub" reasoning).
//
// NEVER throws. Resolves nil only when there is no explicit override AND the
// Keychain is unavailable (macOS unit-test host, or a genuinely broken
// Keychain) — callers must treat that as "omit the whole `device` block",
// exactly like `CompanionAnnounce`'s own all-failures-are-nil contract.
import CryptoKit
import Foundation
import Security
#if canImport(UIKit)
import UIKit
#endif

/// The announce `device` block (naming spec 2026-08-24). Non-personal by
/// design — `UIDevice.current.name` (the user-assigned device name, e.g.
/// "Aurimas's iPhone") is deliberately never read anywhere in this file.
public struct AnnounceDevice: Sendable, Equatable {
    /// Lowercase UUID — either hashed from an explicit source or a
    /// Keychain-stored random id. Never a raw hardware identifier.
    public let id: String
    /// `"ios"` or `"tvos"`, from `#if os(tvOS)`.
    public let platform: String
    /// Machine identifier (`utsname.machine`, e.g. `"iPhone15,2"`), or the
    /// simulator's `SIMULATOR_MODEL_IDENTIFIER` when running on one. Capped
    /// to 80 chars — matches the server schema (`announce-route.ts`).
    public let model: String?
    /// `UIDevice.current.systemName` ("iOS"/"tvOS") where UIKit exists, else
    /// a Foundation-only fallback. Capped to 40 chars.
    public let osName: String?
    /// `UIDevice.current.systemVersion` where UIKit exists, else
    /// `ProcessInfo.operatingSystemVersion` formatted `major.minor.patch`.
    /// Capped to 40 chars.
    public let osVersion: String?
    /// `#if targetEnvironment(simulator)`.
    public let emulator: Bool

    public init(
        id: String,
        platform: String,
        model: String?,
        osName: String?,
        osVersion: String?,
        emulator: Bool
    ) {
        self.id = id
        self.platform = platform
        self.model = model
        self.osName = osName
        self.osVersion = osVersion
        self.emulator = emulator
    }
}

/// Resolves the stable `device.id` — see the file header for the chain.
enum CompanionDeviceId {
    private static let SERVICE = "com.traceitx.companion-device-id"
    private static let ACCOUNT = "default"

    /// `explicit` (hashed SHA-256 → UUID shape) → Keychain-stored random
    /// UUID (created + persisted on first use) → nil (Keychain unavailable
    /// and no explicit override).
    static func resolve(explicit: String?) -> String? {
        if let explicit, !explicit.isEmpty {
            return hashToUuid(explicit)
        }
        // Reuses `DeviceKey`'s probe rather than duplicating it: same
        // failure mode (macOS unit-test targets get `errSecMissingEntitlement`
        // with no code-signing), same "skip, don't fail" answer.
        guard DeviceKey.probeKeychainAvailability() else { return nil }
        if let existing = read() { return existing }
        let fresh = UUID().uuidString.lowercased()
        write(fresh)
        return fresh
    }

    /// Test-only: deletes the stored Keychain id so a probe-gated test can
    /// observe a fresh `resolve(explicit: nil)` creating one, and so one
    /// test's persisted id can't leak into the next.
    static func __resetForTests() {
        SecItemDelete(query() as CFDictionary)
    }

    private static func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SERVICE,
            kSecAttrAccount as String: ACCOUNT,
        ]
    }

    private static func read() -> String? {
        var attrs = query()
        attrs[kSecReturnData as String] = true
        attrs[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attrs as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ value: String) {
        // Idempotent: delete-then-add, mirroring `DeviceKey.write(_:)`.
        SecItemDelete(query() as CFDictionary)
        var attrs = query()
        attrs[kSecValueData as String] = Data(value.utf8)
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemAdd(attrs as CFDictionary, nil)
    }

    /// SHA-256 the source, take the first 16 bytes, stamp the version/variant
    /// nibbles, format 8-4-4-4-12. Bit-for-bit mirror of `hashToUuid` in
    /// `packages/sdk-react/src/companion/device-id.ts` so the SAME explicit
    /// source produces the SAME device id on every SDK platform.
    static func hashToUuid(_ source: String) -> String {
        let digest = SHA256.hash(data: Data(source.utf8))
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        func slice(_ range: Range<Int>) -> String {
            let start = hex.index(hex.startIndex, offsetBy: range.lowerBound)
            let end = hex.index(hex.startIndex, offsetBy: range.upperBound)
            return String(hex[start..<end])
        }
        return "\(slice(0..<8))-\(slice(8..<12))-\(slice(12..<16))-\(slice(16..<20))-\(slice(20..<32))"
    }
}

/// Composes the full `AnnounceDevice` block: `CompanionDeviceId.resolve(_:)`
/// plus raw, non-personal facts about the host. `RelayWSClient` calls this
/// once (lazily, at first announce) and caches the result for the client's
/// lifetime — see its `resolveDeviceOnce()`.
enum CompanionDeviceFacts {
    /// `nil` only when `CompanionDeviceId.resolve(explicit:)` fails — the
    /// caller's contract is then "omit the whole `device` block", not "send
    /// one with a missing id" (the server schema requires `id`).
    ///
    /// `@MainActor`: `UIDevice.current` is main-actor isolated on the SDKs
    /// this package builds against — mirrors `DeviceMetadata.snapshot()`'s
    /// same annotation for the same reason. Safe to `await` from any
    /// background `Task`.
    @MainActor
    static func current(explicit: String? = nil) -> AnnounceDevice? {
        guard let id = CompanionDeviceId.resolve(explicit: explicit) else { return nil }
        return AnnounceDevice(
            id: id,
            platform: platform,
            model: model,
            osName: osName,
            osVersion: osVersion,
            emulator: isSimulator)
    }

    private static var platform: String {
        #if os(tvOS)
        return "tvos"
        #else
        return "ios"
        #endif
    }

    private static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    private static var model: String? {
        #if targetEnvironment(simulator)
        // The real machine identifier reads back "x86_64"/"arm64" — the
        // build architecture, not the simulated device — so a simulator run
        // uses the identifier Xcode's simulator process sets instead.
        return cap(ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], 80)
        #else
        return cap(machineIdentifier(), 80)
        #endif
    }

    /// `uname().machine`, e.g. `"iPhone15,2"`. Works on every Apple platform
    /// including the macOS test host (where it reads back an architecture
    /// string like `"arm64"`) — no `#if` needed for this part.
    private static func machineIdentifier() -> String? {
        var info = utsname()
        uname(&info)
        // Computed BEFORE the `withUnsafePointer` below, not inside its
        // closure: reading `info.machine` again from inside a closure that
        // already holds an exclusive-access pointer to that same field is a
        // Swift exclusivity violation (a compile error, not just a warning).
        let machineSize = MemoryLayout.size(ofValue: info.machine)
        let machine = withUnsafePointer(to: &info.machine) { ptr -> String in
            ptr.withMemoryRebound(to: CChar.self, capacity: machineSize) {
                String(cString: $0)
            }
        }
        return machine.isEmpty ? nil : machine
    }

    private static var osName: String? {
        #if canImport(UIKit)
        return cap(UIDevice.current.systemName, 40)
        #elseif os(tvOS)
        return "tvOS"
        #else
        return "iOS"
        #endif
    }

    private static var osVersion: String? {
        #if canImport(UIKit)
        return cap(UIDevice.current.systemVersion, 40)
        #else
        // macOS test host: no UIDevice. `operatingSystemVersion` describes
        // the HOST, not a real iOS/tvOS version — acceptable here since this
        // branch never ships (production is always `canImport(UIKit)`), it
        // only has to keep `swift build`/`swift test` compiling on macOS.
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return cap("\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", 40)
        #endif
    }

    private static func cap(_ s: String?, _ n: Int) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return String(s.prefix(n))
    }
}
