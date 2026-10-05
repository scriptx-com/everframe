// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.protocol.generated.CrashCauseChain
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class CrashCauseNormalizerTest {
    private fun cause(message: String = "inner", frames: JSONArray = JSONArray()) = JSONObject()
        .put("exceptionType", "Error").put("message", message).put("frames", frames).put("framesTruncated", false)
    private fun chain(vararg causes: JSONObject) = JSONObject().put("causes", JSONArray(causes.toList())).put("truncated", false)
    private fun fit(raw: Any?, redact: (String) -> String = { it }, owned: () -> Boolean = { true }): CrashCauseChain? =
        normalizeCrashCauseChain(raw, redact, owned)
    private fun wire(value: CrashCauseChain) = EnvelopeBuilder.JSON.encodeToString(value)

    @Test fun `native normalization matches shared literal fixtures`() {
        val fixtures = JSONObject(File("../../../protocol/__tests__/fixtures/crash-causes-native-parity.json").readText()).getJSONArray("cases")
        for (i in 0 until fixtures.length()) {
            val case = fixtures.getJSONObject(i)
            assertEquals(case.getString("name"), Json.parseToJsonElement(case.get("expected").toString()),
                Json.parseToJsonElement(wire(requireNotNull(fit(case.get("input"))))))
        }
    }
    @Test fun `absence stays absent and unsupported roots never stringify host values`() {
        assertNull(fit(null))
        val host = object { override fun toString(): String = error("host description") }
        for (input in listOf(JSONObject.NULL, 1, "bad", host, JSONArray())) {
            assertEquals(CrashCauseChain(emptyList(), true), fit(input))
        }
    }
    @Test fun `bounds causes and frames without inventing loss at exact limits`() {
        val frames = JSONArray((1..33).map { JSONObject().put("raw", "frame $it") })
        val fitted = requireNotNull(fit(chain(*Array(9) { cause(frames = frames) })))
        assertEquals(8, fitted.causes.size)
        assertTrue(fitted.truncated)
        assertTrue(fitted.causes.all { it.frames.size == 32 && it.framesTruncated })
        assertFalse(requireNotNull(fit(chain(*Array(8) { cause() }))).truncated)
    }
    @Test fun `repairs wire text and recaps expanding redaction without splitting pairs`() {
        val input = cause("secret")
        input.put("exceptionType", "x".repeat(255) + "😀")
        val fitted = requireNotNull(fit(chain(input), { if (it == "secret") "😀".repeat(4096) else it }))
        assertEquals("x".repeat(255), fitted.causes.single().exceptionType)
        assertEquals(4096, fitted.causes.single().message.length)
        assertTrue(fitted.truncated)
        assertEquals("a�b�", requireNotNull(fit(chain(cause("a\u0000b\uD800")))).causes.single().message)
    }
    @Test fun `byte exhaustion keeps a valid prefix in the actual encoder`() {
        val frames = JSONArray((1..32).map { JSONObject().put("raw", "\u0001".repeat(1024)).put("file", "界".repeat(1024)) })
        val fitted = requireNotNull(fit(chain(*Array(8) { cause("界".repeat(4096), frames) })))
        assertTrue(wire(fitted).toByteArray(Charsets.UTF_8).size <= 65536)
        assertTrue(fitted.truncated)
        assertTrue(fitted.causes.isNotEmpty())
        assertTrue(fitted.causes.last().framesTruncated)
    }
    @Test fun `redactor failure and ownership loss discard enrichment`() {
        assertNull(fit(chain(cause()), { error("redactor") }))
        var active = true
        assertNull(fit(chain(cause()), { active = false; it }, { active }))
        assertNull(fit(chain(cause()), owned = { false }))
    }
    @Test fun `does not retain caller arrays and does not scan past retained prefix`() {
        val input = chain(cause())
        val fitted = requireNotNull(fit(input))
        input.getJSONArray("causes").getJSONObject(0).put("message", "mutated")
        assertEquals("inner", fitted.causes.single().message)
        var maxSeen = 0
        fit(chain(cause("x".repeat(100000))), redact = { text -> maxSeen = maxOf(maxSeen, text.length); text })
        assertTrue(maxSeen <= 8192)
    }
}
