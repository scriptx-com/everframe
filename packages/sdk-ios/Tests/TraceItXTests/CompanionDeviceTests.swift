// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `CompanionDeviceId` / `CompanionDeviceFacts` (naming spec 2026-08-24).
//
// The hashing path (`explicit` non-empty) never touches Keychain, so those
// tests run everywhere, including the macOS unit-test host. The
// Keychain-backed path (`explicit` nil/empty) is probe-gated, mirroring
// `DeviceKeyTests.swift`: macOS unit-test targets without code-signing get
// `errSecMissingEntitlement` from `SecItemAdd`, so those tests record the
// unavailability and pass through rather than fail — full coverage lives in
// XCUITest on a real signed target.
import Testing
import Foundation
@testable import TraceItXKit

@Suite(.serialized)
struct CompanionDeviceTests {

    // MARK: - hashToUuid: determinism + RFC 4122 shape

    /// Plain character-class validator rather than a `Regex` literal — this
    /// target's minimum deployment (iOS/tvOS 15) predates `Regex`'s runtime
    /// availability (iOS/tvOS 16+), so a literal here would be a landmine
    /// the next person to raise the test target's own min-OS trips over.
    private static func isCanonicalLowercaseUuid(_ s: String) -> Bool {
        let groups = s.split(separator: "-", omittingEmptySubsequences: false)
        let expectedLengths = [8, 4, 4, 4, 12]
        guard groups.count == expectedLengths.count else { return false }
        return zip(groups, expectedLengths).allSatisfy { group, length in
            group.count == length
                && group.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) }
        }
    }

    @Test func hashToUuid_isDeterministic_forTheSameSource() {
        let a = CompanionDeviceId.hashToUuid("mdm-serial-ABC123")
        let b = CompanionDeviceId.hashToUuid("mdm-serial-ABC123")
        #expect(a == b)
    }

    @Test func hashToUuid_differsAcrossDistinctSources() {
        let a = CompanionDeviceId.hashToUuid("mdm-serial-ABC123")
        let b = CompanionDeviceId.hashToUuid("mdm-serial-XYZ789")
        #expect(a != b)
    }

    @Test func hashToUuid_producesLowercaseCanonicalUuidShape() {
        let id = CompanionDeviceId.hashToUuid("some-provisioning-serial")
        #expect(Self.isCanonicalLowercaseUuid(id))
    }

    @Test func hashToUuid_stampsVersion4Nibble() {
        // 3rd group's leading hex digit is the version nibble.
        let id = CompanionDeviceId.hashToUuid("device-a")
        let thirdGroup = id.split(separator: "-")[2]
        #expect(thirdGroup.first == "4")
    }

    @Test func hashToUuid_stampsRfc4122VariantNibble() {
        // 4th group's leading hex digit must be 8, 9, a, or b (the two
        // high bits fixed to `10`) — mirrors the web `hashToUuid`'s
        // `(bytes[8] & 0x3f) | 0x80`.
        let id = CompanionDeviceId.hashToUuid("device-b")
        let fourthGroup = id.split(separator: "-")[3]
        #expect(["8", "9", "a", "b"].contains(String(fourthGroup.first!)))
    }

    @Test func hashToUuid_knownVector() {
        // Locks the exact algorithm (not just its shape) so a future refactor
        // that silently changes byte order, slice offsets, or truncation
        // length is caught immediately rather than only via a cross-platform
        // parity bug — a bug shared by an in-file "independent" re-derivation
        // would pass that check too, so this is a literal computed
        // out-of-band (Python `hashlib.sha256` + the same nibble-stamping
        // rule, computed once and pinned here): SHA-256("traceitx-test-vector"),
        // first 16 bytes, byte 6 → `(b & 0x0f) | 0x40`, byte 8 →
        // `(b & 0x3f) | 0x80`, hex-formatted 8-4-4-4-12.
        let id = CompanionDeviceId.hashToUuid("traceitx-test-vector")
        #expect(id == "069517e3-5bd7-4012-b70c-f7a35e011fc9")
    }

    // MARK: - resolve(explicit:): hashing path never touches Keychain

    @Test func resolve_withExplicit_returnsTheHashedValue_regardlessOfKeychain() {
        let resolved = CompanionDeviceId.resolve(explicit: "vendor-serial-42")
        #expect(resolved == CompanionDeviceId.hashToUuid("vendor-serial-42"))
    }

    @Test func resolve_withExplicit_isStableAcrossCalls() {
        let a = CompanionDeviceId.resolve(explicit: "vendor-serial-42")
        let b = CompanionDeviceId.resolve(explicit: "vendor-serial-42")
        #expect(a == b)
    }

    @Test func resolve_withEmptyExplicit_fallsThroughToTheKeychainPath() {
        // "" must NOT be hashed as if it were a real explicit id — it's
        // treated the same as nil (falls through). Probe-gated because the
        // fallthrough touches Keychain.
        guard DeviceKey.probeKeychainAvailability() else { return }
        CompanionDeviceId.__resetForTests()
        let resolved = CompanionDeviceId.resolve(explicit: "")
        #expect(resolved != CompanionDeviceId.hashToUuid(""))
        #expect(resolved != nil)
    }

    // MARK: - resolve(explicit: nil): Keychain-backed random UUID (probe-gated)

    @Test func resolve_withoutExplicit_createsAndPersistsALowercaseUuid() {
        guard DeviceKey.probeKeychainAvailability() else { return }
        CompanionDeviceId.__resetForTests()

        let resolved = CompanionDeviceId.resolve(explicit: nil)

        #expect(resolved != nil)
        #expect(resolved == resolved?.lowercased())
        #expect(Self.isCanonicalLowercaseUuid(resolved!))
    }

    @Test func resolve_withoutExplicit_isStableAcrossCalls() {
        guard DeviceKey.probeKeychainAvailability() else { return }
        CompanionDeviceId.__resetForTests()

        let first = CompanionDeviceId.resolve(explicit: nil)
        let second = CompanionDeviceId.resolve(explicit: nil)

        #expect(first != nil)
        #expect(first == second, "Keychain-backed id must be stable across calls")
    }

    @Test func resetForTests_clearsTheStoredId_soANewOneIsCreated() {
        guard DeviceKey.probeKeychainAvailability() else { return }
        CompanionDeviceId.__resetForTests()
        let first = CompanionDeviceId.resolve(explicit: nil)

        CompanionDeviceId.__resetForTests()
        let second = CompanionDeviceId.resolve(explicit: nil)

        #expect(first != nil && second != nil)
        // Astronomically unlikely to collide by chance (122 random bits) —
        // this is what proves __resetForTests() actually deleted the entry
        // rather than being a no-op.
        #expect(first != second)
    }

    // MARK: - CompanionDeviceFacts.current(explicit:)

    @Test func facts_current_withExplicit_usesTheHashedIdAndNeverTouchesKeychain() async {
        let device = await CompanionDeviceFacts.current(explicit: "provisioning-serial-9")
        #expect(device?.id == CompanionDeviceId.hashToUuid("provisioning-serial-9"))
    }

    @Test func facts_current_capsModelAndOsFieldsDefensively() async {
        // Server schema caps: model ≤80, osName/osVersion ≤40
        // (announce-route.ts). Even on hosts where these read back short,
        // the cap must never be exceeded.
        let device = await CompanionDeviceFacts.current(explicit: "cap-test")
        #expect((device?.model?.count ?? 0) <= 80)
        #expect((device?.osName?.count ?? 0) <= 40)
        #expect((device?.osVersion?.count ?? 0) <= 40)
    }

    @Test func facts_current_platformIsIosOrTvos() async {
        let device = await CompanionDeviceFacts.current(explicit: "platform-test")
        #expect(device?.platform == "ios" || device?.platform == "tvos")
    }
}
