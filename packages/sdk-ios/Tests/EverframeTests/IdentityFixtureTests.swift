// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Native identity Task 9 — the cross-boundary contract, Swift half.
//
// packages/identity/scripts/generate-native-fixture.mjs mints these tokens
// through @everframe/identity's REAL `mintIdentityToken` entry point — the
// same one a customer's backend calls — so claim-shape drift between the
// minter and `decodeIdentityClaims` below is what this file catches, not a
// hand-rolled JWT that merely looks like the minter's output.
//
// This decodes the fixture and proves the two natives agree with the minter.
// It does NOT prove Everframe would accept these tokens — that's the other
// half of the contract, the ingest API/__tests__/reporter/identity-native-fixture.spec.ts,
// which feeds the IDENTICAL bytes through the real `verifyIdentityToken`.
//
// fixture-sync.spec.ts (TS) guards this file's physical copy of
// identity-token-native.v1.json against drift from the canonical
// packages/protocol/__tests__/fixtures/identity-token-native.v1.json.
//
// DETERMINISM. Every fixture token's `iatMs` is the SAME fixed instant the
// generator minted it at (not read from the system clock at generation time,
// and never read from the system clock here either) — testDecodedExpMatchesFixture
// below is a pure byte comparison so it needs no clock at all, but
// testHolderServesTheTokenAtItsOwnMintInstant deliberately injects the
// fixture's own `iatMs` as `now` rather than calling `Date()`, so the
// expiry-arithmetic it exercises (cachedSubject's TTL-vs-margin check) stays
// correct indefinitely instead of quietly going stale once real time moves
// far enough past the fixture's fixed mint instant.
import XCTest
@testable import EverframeKit

final class IdentityFixtureTests: XCTestCase {

    private struct FixtureToken: Decodable {
        let name: String
        let jwt: String
        let iatMs: Double
        let expMs: Double
        let sub: String
        let projectId: String
    }

    private struct Fixture: Decodable {
        let generatedAt: Double
        let secret: String
        let tokens: [FixtureToken]
    }

    private static func loadFixture() throws -> Fixture {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "identity-token-native.v1", withExtension: "json")
        )
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    func testFixtureCoversTheRequiredBoundaries() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.tokens.count, 3)
        XCTAssertTrue(fixture.tokens.contains { $0.sub.count == 255 })
        XCTAssertTrue(fixture.tokens.contains { $0.expMs - $0.iatMs == 600_000 })
    }

    /// `decodeIdentityClaims` is a non-verifying decode — the same function
    /// `IdentityTokenHolder` uses internally — recovering exactly the `sub`
    /// and `exp` the generator recorded for each token.
    func testDecodedClaimsMatchFixture() throws {
        let fixture = try Self.loadFixture()
        for token in fixture.tokens {
            let claims = try XCTUnwrap(
                decodeIdentityClaims(token.jwt), "undecodable: \(token.name)"
            )
            XCTAssertEqual(claims.sub, token.sub, "sub mismatch: \(token.name)")
            let exp = try XCTUnwrap(claims.exp, "missing exp: \(token.name)")
            XCTAssertEqual(
                exp.timeIntervalSince1970, token.expMs / 1000, accuracy: 0.001,
                "exp mismatch: \(token.name)"
            )
        }
    }

    /// Threads each token through the real `IdentityTokenHolder`, injecting
    /// the fixture's own recorded `iatMs` as "now" rather than `Date()` — the
    /// determinism half of the contract (see file header). At its own mint
    /// instant every fixture token is far outside the 30s refresh margin (the
    /// shortest TTL here is 300s), so the holder must serve its `sub`.
    func testHolderServesTheTokenAtItsOwnMintInstant() throws {
        let fixture = try Self.loadFixture()
        for token in fixture.tokens {
            let holder = IdentityTokenHolder()
            holder.set(.token(token.jwt))
            let now = Date(timeIntervalSince1970: token.iatMs / 1000)
            XCTAssertEqual(
                holder.cachedSubject(now: now), token.sub,
                "holder did not serve \(token.name) at its own iat"
            )
        }
    }

    /// Just past `exp` (well outside the holder's own 30s refresh margin, so
    /// this is unambiguous), the SAME injected-clock discipline proves the
    /// token is dropped rather than served stale.
    func testHolderDropsTheTokenPastItsOwnExpiry() throws {
        let fixture = try Self.loadFixture()
        for token in fixture.tokens {
            let holder = IdentityTokenHolder()
            holder.set(.token(token.jwt))
            let after = Date(timeIntervalSince1970: token.expMs / 1000 + 60)
            XCTAssertNil(
                holder.cachedSubject(now: after),
                "holder still served \(token.name) after its own exp"
            )
        }
    }
}
