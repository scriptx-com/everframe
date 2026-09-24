// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonCoerceTest {
    @Test
    fun `primitives, maps, lists and JsonElements pass through`() {
        assertEquals(JsonPrimitive(1), JsonCoerce.toJsonElement(1))
        assertEquals(JsonPrimitive(1.5), JsonCoerce.toJsonElement(1.5))
        assertEquals(JsonPrimitive("s"), JsonCoerce.toJsonElement("s"))
        assertEquals(JsonPrimitive(true), JsonCoerce.toJsonElement(true))
        assertEquals(JsonNull, JsonCoerce.toJsonElement(null))
        val el = JsonCoerce.toJsonElement(mapOf("a" to listOf(1, "x"), "b" to mapOf("c" to null)))
        assertEquals("""{"a":[1,"x"],"b":{"c":null}}""", el.toString())
        assertEquals(JsonPrimitive(3), JsonCoerce.toJsonElement(JsonPrimitive(3)))
    }

    @Test
    fun `non-string map keys are stringified`() {
        assertEquals("""{"1":"a"}""", JsonCoerce.toJsonElement(mapOf(1 to "a")).toString())
    }

    @Test
    fun `unknown types become an unserializable marker with a bounded preview`() {
        val el = JsonCoerce.toJsonElement(Any()).jsonObject
        assertEquals("true", el["unserializable"]!!.jsonPrimitive.content)
        assertTrue(el["value"]!!.jsonPrimitive.content.startsWith("java.lang.Object@"))
        val long = JsonCoerce.toJsonElement(object { override fun toString() = "x".repeat(1000) }).jsonObject
        assertEquals(256, long["value"]!!.jsonPrimitive.content.length)
    }

    @Test
    fun `NaN and infinities become null`() {
        assertEquals(JsonNull, JsonCoerce.toJsonElement(Double.NaN))
        assertEquals(JsonNull, JsonCoerce.toJsonElement(Float.POSITIVE_INFINITY))
    }

    @Test
    fun `toJsonObject handles null and mixed-value maps`() {
        assertNull(JsonCoerce.toJsonObject(null))
        assertEquals(
            """{"a":1,"b":null,"c":["x"]}""",
            JsonCoerce.toJsonObject(mapOf("a" to 1, "b" to null, "c" to listOf("x"))).toString(),
        )
    }

    @Test
    fun `primitive arrays coerce to JsonArrays of their boxed elements`() {
        assertEquals("[1,2]", JsonCoerce.toJsonElement(intArrayOf(1, 2)).toString())
        assertEquals("[0.5]", JsonCoerce.toJsonElement(doubleArrayOf(0.5)).toString())
        assertEquals("""["a",1]""", JsonCoerce.toJsonElement(arrayOf<Any>("a", 1)).toString())
        assertEquals("[true]", JsonCoerce.toJsonElement(booleanArrayOf(true)).toString())
    }
}
