// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.crash

import com.traceitx.CaptureExceptionOptions
import com.traceitx.ErrorSeverity
import com.traceitx.envelope.EnvelopeBuilder
import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashDetailsNormalizerTest {
    @Test
    fun `projects public options into native wire details`() {
        val details = normalizeCrashDetails(CaptureExceptionOptions(
            ErrorSeverity.WARNING, "checkout",
            linkedMapOf("attempt" to 2, "accessToken" to "synthetic"),
        ), { it })
        val wire = EnvelopeBuilder.JSON.encodeToJsonElement(details).jsonObject

        assertEquals("warning", wire["severity"]!!.jsonPrimitive.content)
        assertEquals(2, wire["metadata"]!!.jsonObject["attempt"]!!.jsonPrimitive.int)
        assertEquals("[REDACTED]", wire["metadata"]!!.jsonObject["accessToken"]!!.jsonPrimitive.content)
        assertFalse(wire.containsKey("truncated"))
    }

    @Test
    fun `uses public defaults and projects supported nested native values`() {
        val metadata = linkedMapOf<String, Any?>(
            "null" to null,
            "boolean" to true,
            "byte" to 1.toByte(),
            "short" to 2.toShort(),
            "int" to 3,
            "long" to 4L,
            "float" to 1.5f,
            "double" to 2.5,
            "list" to listOf("value", false, null),
            "objectArray" to arrayOf<Any?>(5, "six"),
            "booleanArray" to booleanArrayOf(true, false),
            "byteArray" to byteArrayOf(7, 8),
            "shortArray" to shortArrayOf(9, 10),
            "intArray" to intArrayOf(11, 12),
            "longArray" to longArrayOf(13, 14),
            "floatArray" to floatArrayOf(3.5f),
            "doubleArray" to doubleArrayOf(4.5),
            "nested" to linkedMapOf("kept" to "yes"),
        )

        assertEquals("error", wire(null)["severity"]!!.jsonPrimitive.content)
        val wire = wire(CaptureExceptionOptions(metadata = metadata))

        assertEquals("error", wire["severity"]!!.jsonPrimitive.content)
        val projected = wire.metadata()
        assertEquals(JsonNull, projected["null"])
        assertTrue(projected["boolean"]!!.jsonPrimitive.booleanOrNull == true)
        assertEquals(4L, projected["long"]!!.jsonPrimitive.long)
        assertEquals(2.5, projected["double"]!!.jsonPrimitive.double, 0.0)
        assertEquals("value", projected["list"]!!.jsonArray[0].jsonPrimitive.content)
        assertEquals(5, projected["objectArray"]!!.jsonArray[0].jsonPrimitive.int)
        assertEquals(2, projected["booleanArray"]!!.jsonArray.size)
        assertEquals(8, projected["byteArray"]!!.jsonArray[1].jsonPrimitive.int)
        assertEquals(10, projected["shortArray"]!!.jsonArray[1].jsonPrimitive.int)
        assertEquals(12, projected["intArray"]!!.jsonArray[1].jsonPrimitive.int)
        assertEquals(14L, projected["longArray"]!!.jsonArray[1].jsonPrimitive.long)
        assertEquals(3.5, projected["floatArray"]!!.jsonArray[0].jsonPrimitive.double, 0.0001)
        assertEquals(4.5, projected["doubleArray"]!!.jsonArray[0].jsonPrimitive.double, 0.0)
        assertEquals("yes", projected["nested"]!!.jsonObject["kept"]!!.jsonPrimitive.content)
        assertFalse(wire.containsKey("truncated"))
    }

    @Test
    fun `rejects unsafe and nonfinite numbers without coercing arbitrary Number`() {
        val spy = SpyNumber()
        val wire = wire(CaptureExceptionOptions(metadata = linkedMapOf(
            "minimumSafe" to -9_007_199_254_740_991L,
            "maximumSafe" to 9_007_199_254_740_991L,
            "belowSafe" to -9_007_199_254_740_992L,
            "aboveSafe" to 9_007_199_254_740_992L,
            "nanFloat" to Float.NaN,
            "infiniteFloat" to Float.POSITIVE_INFINITY,
            "nanDouble" to Double.NaN,
            "infiniteDouble" to Double.NEGATIVE_INFINITY,
            "spy" to spy,
            "after" to 7,
        )))

        assertEquals(-9_007_199_254_740_991L, wire.metadata()["minimumSafe"]!!.jsonPrimitive.long)
        assertEquals(9_007_199_254_740_991L, wire.metadata()["maximumSafe"]!!.jsonPrimitive.long)
        for (key in listOf("belowSafe", "aboveSafe", "nanFloat", "infiniteFloat", "nanDouble", "infiniteDouble", "spy")) {
            assertFalse(wire.metadata().containsKey(key))
        }
        assertEquals(7, wire.metadata()["after"]!!.jsonPrimitive.int)
        assertEquals(0, spy.accesses)
        assertTrue(wire.truncated())
    }

    @Test
    fun `omits non String Java map keys without coercion and preserves siblings`() {
        val key = ToStringSpy()
        @Suppress("UNCHECKED_CAST")
        val raw = linkedMapOf<Any?, Any?>("before" to 1, key to 2, null to 3, "after" to 4) as Map<String, Any?>

        val wire = wire(CaptureExceptionOptions(metadata = raw))

        assertEquals(setOf("before", "after"), wire.metadata().keys)
        assertEquals(0, key.calls)
        assertTrue(wire.truncated())
    }

    @Test
    fun `omits unsupported containers and preserves unsupported list and array slots as null`() {
        val iterable = Iterable { listOf(1, 2).iterator() }
        val unsupportedObject = ToStringSpy()
        val wire = wire(CaptureExceptionOptions(metadata = linkedMapOf(
            "set" to linkedSetOf(1, 2),
            "iterable" to iterable,
            "character" to 'x',
            "charArray" to charArrayOf('a'),
            "list" to listOf(1, linkedSetOf(2), 3),
            "array" to arrayOf(4, unsupportedObject, 6),
            "after" to true,
        )))

        for (key in listOf("set", "iterable", "character", "charArray")) assertFalse(wire.metadata().containsKey(key))
        assertEquals(listOf(1L, null, 3L), wire.metadata()["list"]!!.jsonArray.map(::jsonScalar))
        assertEquals(listOf(4L, null, 6L), wire.metadata()["array"]!!.jsonArray.map(::jsonScalar))
        assertTrue(wire.metadata()["after"]!!.jsonPrimitive.booleanOrNull == true)
        assertEquals(0, unsupportedObject.calls)
        assertTrue(wire.truncated())
    }

    @Test
    fun `drops path cycles copies repeated references and owns the emitted snapshot`() {
        val shared = linkedMapOf<String, Any?>("value" to "before")
        val cyclic = linkedMapOf<String, Any?>("sibling" to "kept")
        cyclic["self"] = cyclic
        val list = mutableListOf<Any?>(1, 2)
        val root = linkedMapOf<String, Any?>("first" to shared, "second" to shared, "cyclic" to cyclic, "list" to list)

        val details = normalizeCrashDetails(CaptureExceptionOptions(context = "context", metadata = root), { it })
        shared["value"] = "after"
        cyclic["sibling"] = "changed"
        list += 3
        root["added"] = true
        val wire = EnvelopeBuilder.JSON.encodeToJsonElement(details).jsonObject

        assertEquals("before", wire.metadata()["first"]!!.jsonObject["value"]!!.jsonPrimitive.content)
        assertEquals("before", wire.metadata()["second"]!!.jsonObject["value"]!!.jsonPrimitive.content)
        assertEquals("kept", wire.metadata()["cyclic"]!!.jsonObject["sibling"]!!.jsonPrimitive.content)
        assertFalse(wire.metadata()["cyclic"]!!.jsonObject.containsKey("self"))
        assertEquals(listOf(1L, 2L), wire.metadata()["list"]!!.jsonArray.map(::jsonScalar))
        assertFalse(wire.metadata().containsKey("added"))
        assertNotSame(root, details.metadata)
        assertTrue(wire.truncated())
    }

    @Test
    fun `contains iterator key and value failures while preserving accepted entries`() {
        val valueReads = intArrayOf(0)
        val map = HostMap(
            sourceEntries = listOf(
                HostEntry(keyRead = { "before" }, valueRead = { 1 }),
                HostEntry(keyRead = { throw IllegalStateException("key") }, valueRead = { 2 }),
                HostEntry(keyRead = { "badValue" }, valueRead = { valueReads[0] += 1; throw IllegalStateException("value") }),
                HostEntry(keyRead = { "after" }, valueRead = { 4 }),
            ),
        )
        val wire = wire(CaptureExceptionOptions(metadata = map))

        assertEquals(setOf("before", "after"), wire.metadata().keys)
        assertEquals(1, valueReads[0])
        assertTrue(wire.truncated())

        val stopping = HostMap(
            sourceEntries = listOf(HostEntry({ "kept" }, { 1 }), HostEntry({ "unread" }, { 2 })),
            failHasNextAt = 1,
        )
        val stopped = wire(CaptureExceptionOptions(metadata = stopping))
        assertEquals(setOf("kept"), stopped.metadata().keys)
        assertTrue(stopped.truncated())

        val failingList = object : AbstractList<Any?>() {
            override val size: Int = 3
            override fun get(index: Int): Any? = when (index) {
                0 -> 1
                1 -> throw IllegalStateException("list slot")
                else -> 3
            }
        }
        val listWire = wire(CaptureExceptionOptions(metadata = mapOf("list" to failingList)))
        assertEquals(listOf(1L, null), listWire.metadata()["list"]!!.jsonArray.map(::jsonScalar))
        assertTrue(listWire.truncated())

        val inaccessible = object : AbstractMap<String, Any?>() {
            override val entries: Set<Map.Entry<String, Any?>>
                get() = throw IllegalStateException("entries")
        }
        val inaccessibleWire = wire(CaptureExceptionOptions(metadata = inaccessible))
        assertFalse(inaccessibleWire.containsKey("metadata"))
        assertTrue(inaccessibleWire.truncated())
    }

    @Test
    fun `tracks paths by identity without host equality hash or string methods`() {
        val map = IdentitySpyMap()
        map["value"] = 1
        map["self"] = map

        val wire = wire(CaptureExceptionOptions(metadata = map))

        assertEquals(1, wire.metadata()["value"]!!.jsonPrimitive.int)
        assertFalse(wire.metadata().containsKey("self"))
        assertEquals(0, map.equalityCalls)
        assertEquals(0, map.hashCalls)
        assertEquals(0, map.stringCalls)
        assertTrue(wire.truncated())
    }

    @Test
    fun `masks ASCII canonical sensitive keys before reading their values`() {
        val sensitiveReads = intArrayOf(0)
        val map = HostMap(sourceEntries = listOf(
            HostEntry({ "accessToken" }, { sensitiveReads[0] += 1; throw AssertionError("secret read") }),
            HostEntry({ "API-KEY" }, { sensitiveReads[0] += 1; throw AssertionError("api key read") }),
            HostEntry({ "apiKey" }, { "ordinary" }),
        ))

        val wire = wire(CaptureExceptionOptions(metadata = map))

        assertEquals("[REDACTED]", wire.metadata()["accessToken"]!!.jsonPrimitive.content)
        assertEquals("[REDACTED]", wire.metadata()["API-KEY"]!!.jsonPrimitive.content)
        assertEquals("ordinary", wire.metadata()["apiKey"]!!.jsonPrimitive.content)
        assertEquals(0, sensitiveReads[0])
        assertFalse(wire.containsKey("truncated"))
    }

    @Test
    fun `skips over scan limit keys without reading values`() {
        val valueReads = intArrayOf(0)
        val map = HostMap(sourceEntries = listOf(
            HostEntry({ "k".repeat(4_097) }, { valueReads[0] += 1; "exposed" }),
            HostEntry({ "after" }, { 2 }),
        ))
        val wire = wire(CaptureExceptionOptions(metadata = map))

        assertEquals(0, valueReads[0])
        assertEquals(setOf("after"), wire.metadata().keys)
        assertTrue(wire.truncated())
    }

    @Test
    fun `accepts exactly 128 nodes and does not inspect node 129`() {
        val exact = CountingMap(127)
        val exactWire = wire(CaptureExceptionOptions(metadata = exact))
        assertEquals(127, exactWire.metadata().size)
        assertEquals(127, exact.nextCalls)
        assertFalse(exactWire.containsKey("truncated"))

        val overflow = CountingMap(128)
        val overflowWire = wire(CaptureExceptionOptions(metadata = overflow))
        assertEquals(127, overflowWire.metadata().size)
        assertEquals(127, overflow.nextCalls)
        assertTrue(overflow.hasNextCalls <= 128)
        assertTrue(overflowWire.truncated())
    }

    @Test
    fun `accepts four container levels and rejects a fifth`() {
        val four = linkedMapOf<String, Any?>("second" to linkedMapOf("third" to linkedMapOf("fourth" to linkedMapOf("value" to true))))
        val five = linkedMapOf<String, Any?>("second" to linkedMapOf("third" to linkedMapOf("fourth" to linkedMapOf("fifth" to linkedMapOf("value" to true)))))

        assertTrue(wire(CaptureExceptionOptions(metadata = four)).metadata()["second"]!!.jsonObject["third"]!!.jsonObject["fourth"]!!.jsonObject["value"]!!.jsonPrimitive.booleanOrNull == true)
        val over = wire(CaptureExceptionOptions(metadata = five))
        assertEquals(JsonObject(emptyMap()), over.metadata()["second"]!!.jsonObject["third"]!!.jsonObject["fourth"]!!.jsonObject)
        assertTrue(over.truncated())
    }

    @Test
    fun `fits actual serialized details at the exact 8192 byte boundary`() {
        val atLimit = escapedMetadata(956)
        val overLimit = escapedMetadata(957)
        val atWire = wire(CaptureExceptionOptions(metadata = atLimit))
        val overWire = wire(CaptureExceptionOptions(metadata = overLimit))

        assertEquals(8_192, encodedBytes(atWire))
        assertFalse(atWire.containsKey("truncated"))
        assertEquals(8_193, encodedBytes(EnvelopeBuilder.JSON.encodeToJsonElement(
            com.traceitx.protocol.generated.CrashDetails(
                metadata = JsonObject(overLimit.mapValues { JsonPrimitive(it.value) }),
                severity = com.traceitx.protocol.generated.ErrorSeverity.Error,
            ),
        )))
        assertTrue(encodedBytes(overWire) <= 8_192)
        assertTrue(overWire.truncated())
        assertEquals("error", overWire["severity"]!!.jsonPrimitive.content)
    }

    @Test
    fun `fits JavaScript serialization when native exponent notation is shorter`() {
        val metadata = linkedMapOf<String, Any?>("number" to 1e20)
        repeat(7) { metadata["s$it"] = "x".repeat(1_024) }
        metadata["tail"] = "x".repeat(909)

        val wire = wire(CaptureExceptionOptions(metadata = metadata))
        val nativeJson = wire.toString()
        val javascriptJson = nativeJson.replace("1.0E20", "100000000000000000000")

        assertEquals(1e20, wire.metadata()["number"]!!.jsonPrimitive.double, 0.0)
        assertEquals(true, wire.truncated())
        assertTrue(encodedBytes(wire) <= 8_192)
        assertTrue(javascriptJson.toByteArray(Charsets.UTF_8).size <= 8_192)
    }

    @Test
    fun `repairs text and honors scan context key and value UTF-16 boundaries`() {
        val seen = mutableListOf<String>()
        val context = "c".repeat(255) + "😀tail"
        val key = "k".repeat(127) + "😀tail"
        val value = "v".repeat(1_023) + "😀tail"
        val scan = "s".repeat(4_095) + "😀unscanned"
        val exactScan = "e".repeat(4_094) + "😀"
        val wire = wire(CaptureExceptionOptions(
            context = context,
            metadata = linkedMapOf(
                key to value,
                "unsafe\u0000\ud800😀\udc00" to "left\u0000\ud800😀\udc00right",
                "scan" to scan,
                "exactScan" to exactScan,
            ),
        )) { input ->
            seen += input
            if (input == exactScan) "exact-scan-emitted" else input
        }

        assertEquals("c".repeat(255), wire["context"]!!.jsonPrimitive.content)
        assertEquals("v".repeat(1_023), wire.metadata()["k".repeat(127)]!!.jsonPrimitive.content)
        assertEquals("left��😀�right", wire.metadata()["unsafe��😀�"]!!.jsonPrimitive.content)
        assertEquals("s".repeat(1_024), wire.metadata()["scan"]!!.jsonPrimitive.content)
        assertEquals("exact-scan-emitted", wire.metadata()["exactScan"]!!.jsonPrimitive.content)
        assertTrue(seen.contains("s".repeat(4_095)))
        assertTrue(seen.contains(exactScan))
        assertTrue(wire.truncated())
    }

    @Test
    fun `recaps redactor expansions contains failures and keeps first collided key`() {
        val collisionPrefix = "k".repeat(128)
        val wire = wire(CaptureExceptionOptions(
            context = "drop-context",
            metadata = linkedMapOf("one" to "expand-value", "two" to 2, "bad-key" to 3, "bad-value" to "throw-value", "after" to "kept"),
        )) { value ->
            when (value) {
                "drop-context", "bad-key", "throw-value" -> throw IllegalStateException("redactor")
                "expand-value" -> "v".repeat(1_034)
                "one" -> collisionPrefix + "first-suffix"
                "two" -> collisionPrefix + "second-suffix"
                else -> value
            }
        }

        assertFalse(wire.containsKey("context"))
        assertEquals(setOf(collisionPrefix, "after"), wire.metadata().keys)
        assertEquals("v".repeat(1_024), wire.metadata()[collisionPrefix]!!.jsonPrimitive.content)
        assertEquals("kept", wire.metadata()["after"]!!.jsonPrimitive.content)
        assertTrue(wire.truncated())
    }

    @Test
    fun `shared corpus matches native projection semantics`() {
        val corpusFile = File(requireNotNull(System.getProperty("traceitxCrashDetailsCorpus")))
        assertTrue("missing shared corpus at ${corpusFile.absolutePath}", corpusFile.isFile)
        val corpus = EnvelopeBuilder.JSON.parseToJsonElement(corpusFile.readText()).jsonObject
        assertEquals(1, corpus["schemaVersion"]!!.jsonPrimitive.int)
        val cases = corpus["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        val names = cases.map { it.jsonObject["name"]!!.jsonPrimitive.content }
        assertEquals(names.size, names.toSet().size)
        assertEquals(
            setOf("default", "masked-key", "nested", "repaired-text", "bounded-loss", "prototype-keys"),
            names.toSet(),
        )

        for (fixture in cases) {
            val fixtureObject = fixture.jsonObject
            val input = fixtureObject["input"]!!.jsonObject
            val severity = when (input["severity"]?.jsonPrimitive?.contentOrNull) {
                "info" -> ErrorSeverity.INFO
                "warning" -> ErrorSeverity.WARNING
                "error", null -> ErrorSeverity.ERROR
                else -> error("unsupported corpus severity")
            }
            @Suppress("UNCHECKED_CAST")
            val metadata = input["metadata"]?.let(::jsonToNative) as Map<String, Any?>?
            val options = CaptureExceptionOptions(
                severity = severity,
                context = input["context"]?.jsonPrimitive?.contentOrNull,
                metadata = metadata,
            )
            assertEquals(
                "fixture ${fixtureObject["name"]!!.jsonPrimitive.content}",
                fixtureObject["expected"],
                EnvelopeBuilder.JSON.encodeToJsonElement(normalizeCrashDetails(options, { it })),
            )
        }
    }

    private fun wire(
        options: CaptureExceptionOptions?,
        redact: (String) -> String = { it },
    ): JsonObject = EnvelopeBuilder.JSON.encodeToJsonElement(normalizeCrashDetails(options, redact)).jsonObject

    private fun JsonObject.metadata(): JsonObject = getValue("metadata").jsonObject
    private fun JsonObject.truncated(): Boolean = getValue("truncated").jsonPrimitive.booleanOrNull == true

    private fun encodedBytes(element: JsonElement): Int = element.toString().toByteArray(Charsets.UTF_8).size

    private fun escapedMetadata(finalLength: Int): LinkedHashMap<String, String> = linkedMapOf(
        "a" to "\\".repeat(1_024),
        "b" to "\\".repeat(1_024),
        "c" to "\\".repeat(1_024),
        "d" to "x".repeat(1_024),
        "e" to "x".repeat(finalLength),
    )

    private fun jsonScalar(element: JsonElement): Any? = when (element) {
        JsonNull -> null
        is JsonPrimitive -> element.longOrNull ?: element.booleanOrNull ?: element.content
        else -> error("not scalar: $element")
    }

    private fun jsonToNative(element: JsonElement): Any? = when (element) {
        JsonNull -> null
        is JsonObject -> LinkedHashMap<String, Any?>().apply {
            for ((key, value) in element) put(key, jsonToNative(value))
        }
        is JsonArray -> element.map(::jsonToNative)
        is JsonPrimitive -> when {
            element.isString -> element.content
            element.booleanOrNull != null -> element.booleanOrNull
            element.longOrNull != null -> element.longOrNull
            else -> requireNotNull(element.doubleOrNull)
        }
    }
}

private class SpyNumber : Number() {
    var accesses = 0
    override fun toByte(): Byte { accesses += 1; return 1 }
    override fun toDouble(): Double { accesses += 1; return 1.0 }
    override fun toFloat(): Float { accesses += 1; return 1f }
    override fun toInt(): Int { accesses += 1; return 1 }
    override fun toLong(): Long { accesses += 1; return 1 }
    override fun toShort(): Short { accesses += 1; return 1 }
    override fun toString(): String { accesses += 1; return "1" }
}

private class ToStringSpy {
    var calls = 0
    override fun toString(): String { calls += 1; return "coerced" }
}

private class IdentitySpyMap : LinkedHashMap<String, Any?>() {
    var equalityCalls = 0
    var hashCalls = 0
    var stringCalls = 0

    override fun equals(other: Any?): Boolean {
        equalityCalls += 1
        return super.equals(other)
    }

    override fun hashCode(): Int {
        hashCalls += 1
        return super.hashCode()
    }

    override fun toString(): String {
        stringCalls += 1
        return super.toString()
    }
}

private class HostEntry(
    private val keyRead: () -> String,
    private val valueRead: () -> Any?,
) : Map.Entry<String, Any?> {
    override val key: String get() = keyRead()
    override val value: Any? get() = valueRead()
}

private class HostMap(
    private val sourceEntries: List<Map.Entry<String, Any?>>,
    private val failHasNextAt: Int? = null,
) : AbstractMap<String, Any?>() {
    override val entries: Set<Map.Entry<String, Any?>>
        get() = object : AbstractSet<Map.Entry<String, Any?>>() {
            override val size: Int get() = sourceEntries.size
            override fun iterator(): Iterator<Map.Entry<String, Any?>> = object : Iterator<Map.Entry<String, Any?>> {
                private var index = 0
                override fun hasNext(): Boolean {
                    if (index == failHasNextAt) throw IllegalStateException("iterator")
                    return index < sourceEntries.size
                }
                override fun next(): Map.Entry<String, Any?> = sourceEntries[index++]
            }
        }
}

private class CountingMap(private val count: Int) : AbstractMap<String, Any?>() {
    var nextCalls = 0
    var hasNextCalls = 0
    override val entries: Set<Map.Entry<String, Any?>>
        get() = object : AbstractSet<Map.Entry<String, Any?>>() {
            override val size: Int get() = count
            override fun iterator(): Iterator<Map.Entry<String, Any?>> = object : Iterator<Map.Entry<String, Any?>> {
                private var index = 0
                override fun hasNext(): Boolean {
                    hasNextCalls += 1
                    return index < count
                }
                override fun next(): Map.Entry<String, Any?> {
                    nextCalls += 1
                    val current = index++
                    return HostEntry({ "k$current" }, { current })
                }
            }
        }
}
