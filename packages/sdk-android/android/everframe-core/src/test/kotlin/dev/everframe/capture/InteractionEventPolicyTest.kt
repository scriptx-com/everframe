// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import org.junit.Assert.*
import org.junit.Test

class InteractionEventPolicyTest {
    @Test fun defaultsNeverAuthorizeValues() {
        val policy = InteractionEventPolicy.parse(null)
        assertFalse(policy.disabled)
        assertTrue(policy.valueTestIds.isEmpty())
        assertTrue(policy.launchArgumentKeys.isEmpty())
    }

    @Test fun oversizedAndMalformedListsDoNotGrantPartialPermission() {
        val ids = (0..64).joinToString(",") { "\"field$it\"" }
        assertTrue(InteractionEventPolicy.parse("""{"valueTestIds":[$ids]}""").valueTestIds.isEmpty())
        val policy = InteractionEventPolicy.parse("""{"valueTestIds":["exact","*"," padded ","a\u0000b"],"disabled":"no"}""")
        assertTrue(policy.disabled)
        assertTrue(policy.valueTestIds.isEmpty())
        assertEquals(setOf("exact"), InteractionEventPolicy.parse("""{"valueTestIds":["exact","*"," padded ","a\u0000b"]}""").valueTestIds)
        assertTrue(InteractionEventPolicy.parse("not json").disabled)
    }

    @Test fun originsMustBeExactAndPathsExplicit() {
        val policy = InteractionEventPolicy.parse("""{"urlRules":[
          {"origin":"https://example.com","queryKeys":["q"],"routes":["/watch/:id"],"literalPaths":["/home"]},
          {"origin":"https://example.com/private","queryKeys":["token"]},
          {"origin":"https://user@example.com","queryKeys":["password"]}
        ]}""")
        assertEquals(1, policy.urlRules.size)
        assertEquals(setOf("q"), policy.urlRules.single().queryKeys)
    }
}
