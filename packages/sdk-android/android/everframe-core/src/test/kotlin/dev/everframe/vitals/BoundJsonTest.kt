// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import dev.everframe.vitals.wire.VitalsWireCodec
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundJsonTest {
    @Test
    fun `null value is untouched`() {
        val b = boundJson(null)
        assertNull(b.data); assertFalse(b.truncated)
    }

    @Test
    fun `value within cap is returned as-is`() {
        val v = buildJsonObject { put("a", JsonPrimitive(1)) }
        val b = boundJson(v, 64)
        assertEquals(v, b.data); assertFalse(b.truncated)
    }

    @Test
    fun `over-cap collapses to truncated preview that fits the cap`() {
        val v = JsonPrimitive("x".repeat(5000))
        val b = boundJson(v, 2048)
        assertTrue(b.truncated)
        val o = b.data!!.jsonObject
        assertEquals("true", o["truncated"]!!.jsonPrimitive.content)
        assertTrue(o["preview"]!!.jsonPrimitive.content.startsWith("\"xxx"))
        assertTrue(VitalsWireCodec.utf8Length(b.data.toString()) <= 2048)
    }

    @Test
    fun `preview never splits a multibyte code point`() {
        val v = JsonPrimitive("😀".repeat(3000))
        val b = boundJson(v, 2048)
        val preview = b.data!!.jsonObject["preview"]!!.jsonPrimitive.content
        assertFalse(preview.endsWith("\uD83D")) // no dangling high surrogate
        assertTrue(VitalsWireCodec.utf8Length(b.data.toString()) <= 2048)
    }

    /** Mirrors the web suite's `fitsOrIsUndefined` helper — the contract is
     * unconditional: for ANY maxBytes >= 0, `data` either fits or is `null`. */
    private fun fitsOrIsNull(b: BoundedJson, cap: Int): Boolean =
        b.data == null || VitalsWireCodec.utf8Length(b.data.toString()) <= cap

    @Test
    fun `honours a cap just above the fixed wrapper overhead`() {
        // Mirrors bound-json.spec.ts:72-88 (maxBytes=32): the halving loop
        // must find a non-empty preview that fits, not fall through to null.
        val v = JsonPrimitive("x".repeat(100))
        val b = boundJson(v, 32)
        assertTrue(b.truncated)
        assertTrue(b.data != null)
        assertTrue(fitsOrIsNull(b, 32))
    }

    @Test
    fun `degrades to the empty-preview shell or null when the cap cannot hold the wrapper`() {
        // Mirrors bound-json.spec.ts:72-88 (maxBytes=20, "reviewer repro").
        val v = JsonPrimitive("x".repeat(100))
        val b = boundJson(v, 20)
        assertTrue(b.truncated)
        assertTrue(fitsOrIsNull(b, 20))
    }

    @Test
    fun `drops the payload entirely when maxBytes is 0`() {
        val v = JsonPrimitive("x".repeat(100))
        val b = boundJson(v, 0)
        assertEquals(BoundedJson(null, true), b)
    }

    @Test
    fun `structured - within cap returned verbatim`() {
        val v = buildJsonObject { put("message", JsonPrimitive("hi")); put("fatal", JsonPrimitive(true)) }
        val b = boundStructuredJson(v, 8192)
        assertEquals(v, b.data); assertFalse(b.truncated)
    }

    @Test
    fun `structured - scalars survive, long strings shrink, nested kept only if small`() {
        val v = buildJsonObject {
            put("message", JsonPrimitive("m".repeat(10_000)))
            put("code", JsonPrimitive(2001))
            put("fatal", JsonPrimitive(false))
            put("detail", JsonPrimitive("d".repeat(100)))
            put("nested", buildJsonObject { put("k", JsonPrimitive("v".repeat(500))) })
        }
        val b = boundStructuredJson(v, 1024)
        assertTrue(b.truncated)
        val o = b.data!!.jsonObject
        assertEquals("2001", o["code"]!!.jsonPrimitive.content)
        assertEquals("false", o["fatal"]!!.jsonPrimitive.content)
        assertEquals("d".repeat(100), o["detail"]!!.jsonPrimitive.content)   // small string kept whole
        assertTrue(o["message"]!!.jsonPrimitive.content.length < 10_000)       // boundary field truncated
        assertFalse(o.containsKey("nested"))                                   // > 256 bytes nested dropped
        assertTrue(VitalsWireCodec.utf8Length(o.toString()) <= 1024)
    }

    @Test
    fun `structured - 3 KB error payload under the 8 KB cap survives intact`() {
        val v = buildJsonObject { put("message", JsonPrimitive("e".repeat(3000))); put("code", JsonPrimitive("X")); put("fatal", JsonPrimitive(true)) }
        val b = boundStructuredJson(v, 8192)
        assertEquals(v, b.data); assertFalse(b.truncated)
    }

    @Test
    fun `structured - many small strings never exceed the cap`() {
        val v = buildJsonObject { repeat(1000) { put("k$it", JsonPrimitive("v".repeat(20))) } }
        val b = boundStructuredJson(v, 2048)
        assertTrue(b.truncated)
        assertTrue(VitalsWireCodec.utf8Length(b.data!!.toString()) <= 2048)
    }

    @Test
    fun `structured - drops the payload entirely when even the scalar fields alone do not fit`() {
        // Mirrors bound-json.spec.ts:166-170. The kept-scalars-only
        // candidate (27 bytes) still exceeds a 5-byte cap, so both the
        // drop-the-boundary-field retry and the keptOnly terminal fail,
        // landing on BoundedStructuredJson(null, true).
        val v = buildJsonObject {
            put("code", JsonPrimitive(12345))
            put("fatal", JsonPrimitive(true))
            put("message", JsonPrimitive("x".repeat(1000)))
        }
        val b = boundStructuredJson(v, 5)
        assertTrue(b.truncated)
        assertTrue(b.data == null || VitalsWireCodec.utf8Length(b.data.toString()) <= 5)
        assertNull(b.data)
    }

    @Test
    fun `structured - keeps only the scalar fields when the cap fits them but no string field`() {
        // Same shape, a cap of 30 fits the kept-scalars-only candidate (27
        // bytes) but leaves no room to shrink "message" to even one
        // character — exercises the drop-the-boundary-field retry landing
        // on the scalars-only object rather than null.
        val v = buildJsonObject {
            put("code", JsonPrimitive(12345))
            put("fatal", JsonPrimitive(true))
            put("message", JsonPrimitive("x".repeat(1000)))
        }
        val b = boundStructuredJson(v, 30)
        assertTrue(b.truncated)
        val o = b.data!!.jsonObject
        assertEquals("12345", o["code"]!!.jsonPrimitive.content)
        assertEquals("true", o["fatal"]!!.jsonPrimitive.content)
        assertFalse(o.containsKey("message"))
        assertTrue(VitalsWireCodec.utf8Length(o.toString()) <= 30)
    }
}
