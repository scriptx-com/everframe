// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-i. Two things are under test and they fail differently:
//
//   1. The DERIVATION, against the cross-SDK vector (Fixtures/install-id.v1
//      .json, drift-guarded by fixture-sync.spec.ts). A break here means this
//      platform's installs are counted as a DIFFERENT population than web's.
//   2. The SEED STORE, whose contract is "any failure yields nil, never a
//      partial or unstable value" — because the caller bakes the result into
//      the config URL, and that read is the Everframe SDK's remote kill switch.
//
// Deliberately NOT Keychain-backed, so unlike DeviceKeyTests this suite needs
// no probe-and-skip: an unsigned macOS host runs every case here for real.
import XCTest
@testable import EverframeKit

final class InstallIdentifierTests: XCTestCase {
    private struct Vector: Decodable {
        struct Case: Decodable {
            let name: String
            let seedHex: String
            let expected: String
        }
        let domainSeparator: String
        let cases: [Case]
    }

    private func loadVector() throws -> Vector {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/install-id.v1.json")
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    private static func hexToData(_ hex: String) -> Data {
        var out = Data(capacity: hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            out.append(UInt8(hex[idx..<next], radix: 16)!)
            idx = next
        }
        return out
    }

    /// A UserDefaults suite scoped to this test run, so cases never see each
    /// other's seed and never touch the host app's standard defaults.
    private func freshDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "dev.everframe.tests.installid.\(name).\(UUID().uuidString)"
        UserDefaults().removePersistentDomain(forName: suite)
        return UserDefaults(suiteName: suite)!
    }

    func test_derive_matches_every_cross_sdk_vector_case() throws {
        let vector = try loadVector()
        XCTAssertEqual(vector.domainSeparator, InstallIdentifier.domainSeparator)
        XCTAssertFalse(vector.cases.isEmpty)
        for c in vector.cases {
            XCTAssertEqual(
                InstallIdentifier.derive(seed: Self.hexToData(c.seedHex)),
                c.expected,
                "vector case: \(c.name)"
            )
        }
    }

    func test_derive_emits_only_url_safe_unpadded_characters() {
        let id = InstallIdentifier.derive(seed: Data(repeating: 0xAB, count: 16))
        XCTAssertEqual(id.count, 43)
        XCTAssertNil(id.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        XCTAssertNil(id.rangeOfCharacter(from: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_").inverted))
    }

    func test_current_is_stable_across_calls_on_the_same_store() {
        let defaults = freshDefaults()
        let first = InstallIdentifier.current(defaults: defaults)
        XCTAssertNotNil(first)
        XCTAssertEqual(first, InstallIdentifier.current(defaults: defaults))
    }

    func test_current_differs_across_two_independent_stores() {
        XCTAssertNotEqual(
            InstallIdentifier.current(defaults: freshDefaults("storeA")),
            InstallIdentifier.current(defaults: freshDefaults("storeB"))
        )
    }

    func test_seed_is_persisted_as_32_lowercase_hex_and_the_raw_seed_never_appears_in_the_id() {
        let defaults = freshDefaults()
        let id = InstallIdentifier.current(defaults: defaults)
        let stored = defaults.string(forKey: InstallIdentifier.defaultsKey)
        XCTAssertNotNil(stored)
        XCTAssertEqual(stored?.count, 32)
        XCTAssertEqual(stored, stored?.lowercased())
        XCTAssertNotNil(stored?.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
        // One-wayness is the whole point: the stored seed must not be a
        // substring of the transmitted value.
        XCTAssertFalse(id!.contains(stored!))
    }

    func test_a_malformed_stored_seed_is_discarded_and_re_minted_not_used() {
        let defaults = freshDefaults()
        defaults.set("not-hex-at-all", forKey: InstallIdentifier.defaultsKey)
        let id = InstallIdentifier.current(defaults: defaults)
        XCTAssertNotNil(id)
        let rewritten = defaults.string(forKey: InstallIdentifier.defaultsKey)
        XCTAssertNotNil(rewritten?.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
    }

    func test_an_uppercase_hex_seed_is_treated_as_malformed_so_the_shape_check_stays_exact() {
        // The shape check is the same one web uses (/^[0-9a-f]{32}$/). Keeping
        // it exact on every platform is what makes "same seed, same id"
        // meaningful; a lenient reader here would accept a value web rejects.
        let defaults = freshDefaults()
        defaults.set(String(repeating: "A", count: 32), forKey: InstallIdentifier.defaultsKey)
        _ = InstallIdentifier.current(defaults: defaults)
        let rewritten = defaults.string(forKey: InstallIdentifier.defaultsKey)
        XCTAssertNotEqual(rewritten, String(repeating: "A", count: 32))
    }
}
