// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Native identity Task 9 — the cross-boundary contract, Kotlin half.
//
// packages/identity/scripts/generate-native-fixture.mjs mints these tokens
// through @traceitx/identity's REAL `mintIdentityToken` entry point — the
// same one a customer's backend calls — so claim-shape drift between the
// minter and [decodeIdentityClaims] below is what this file catches, not a
// hand-rolled JWT that merely looks like the minter's output.
//
// This decodes the fixture and proves the two natives agree with the minter.
// It does NOT prove TraceItX itself would accept these tokens — that's the
// other half of the contract,
// the ingest API/__tests__/reporter/identity-native-fixture.spec.ts, which feeds
// the IDENTICAL bytes through the real `verifyIdentityToken`.
//
// fixture-sync.spec.ts (TS) guards this file's physical copy of
// identity-token-native.v1.json against drift from the canonical
// packages/protocol/__tests__/fixtures/identity-token-native.v1.json.
//
// DETERMINISM. Every fixture token's `iatMs` is the SAME fixed instant the
// generator minted it at (never read from the system clock, here or there).
// testDecodedClaimsMatchFixture is a pure byte comparison and needs no clock
// at all, but testHolderServesTheTokenAtItsOwnMintInstant deliberately
// injects the fixture's own `iatMs` as `nowMs` rather than
// `System.currentTimeMillis()`, so the expiry arithmetic it exercises
// ([IdentityTokenHolder.cachedSubject]'s TTL-vs-margin check) stays correct
// indefinitely instead of quietly going stale once real time moves far
// enough past the fixture's fixed mint instant.
package com.traceitx.identity

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@Serializable
private data class FixtureToken(
    val name: String,
    val jwt: String,
    val iatMs: Long,
    val expMs: Long,
    val sub: String,
    val projectId: String,
)

@Serializable
private data class Fixture(
    val generatedAt: Long,
    val secret: String,
    val tokens: List<FixtureToken>,
)

class IdentityFixtureTest {

    private fun loadFixture(): Fixture {
        val raw = javaClass.getResourceAsStream("/identity-token-native.v1.json")!!
            .bufferedReader()
            .use { it.readText() }
        return Json { ignoreUnknownKeys = true }.decodeFromString(Fixture.serializer(), raw)
    }

    @Test
    fun fixtureCoversTheRequiredBoundaries() {
        val fixture = loadFixture()
        assertTrue(fixture.tokens.size >= 3)
        assertTrue(fixture.tokens.any { it.sub.length == 255 })
        assertTrue(fixture.tokens.any { it.expMs - it.iatMs == 600_000L })
    }

    /**
     * [decodeIdentityClaims] is a non-verifying decode — the same function
     * [IdentityTokenHolder] uses internally — recovering exactly the `sub`
     * and `exp` the generator recorded for each token.
     */
    @Test
    fun decodedClaimsMatchFixture() {
        val fixture = loadFixture()
        for (token in fixture.tokens) {
            val claims = decodeIdentityClaims(token.jwt)
            assertNotNull("undecodable: ${token.name}", claims)
            assertEquals("sub mismatch: ${token.name}", token.sub, claims!!.sub)
            assertEquals("exp mismatch: ${token.name}", token.expMs, claims.expMs)
        }
    }

    /**
     * Threads each token through the real [IdentityTokenHolder], injecting
     * the fixture's own recorded `iatMs` as `nowMs` rather than
     * `System.currentTimeMillis()` — the determinism half of the contract
     * (see file header). At its own mint instant every fixture token is far
     * outside the 30s refresh margin (the shortest TTL here is 300s), so the
     * holder must serve its `sub`.
     */
    @Test
    fun holderServesTheTokenAtItsOwnMintInstant() {
        val fixture = loadFixture()
        for (token in fixture.tokens) {
            val holder = IdentityTokenHolder()
            holder.set(IdentityTokenSource.Token(token.jwt))
            assertEquals(
                "holder did not serve ${token.name} at its own iat",
                token.sub,
                holder.cachedSubject(token.iatMs),
            )
        }
    }

    /**
     * Just past `exp` (well outside the holder's own 30s refresh margin, so
     * this is unambiguous), the SAME injected-clock discipline proves the
     * token is dropped rather than served stale.
     */
    @Test
    fun holderDropsTheTokenPastItsOwnExpiry() {
        val fixture = loadFixture()
        for (token in fixture.tokens) {
            val holder = IdentityTokenHolder()
            holder.set(IdentityTokenSource.Token(token.jwt))
            assertNull(
                "holder still served ${token.name} after its own exp",
                holder.cachedSubject(token.expMs + 60_000),
            )
        }
    }
}
