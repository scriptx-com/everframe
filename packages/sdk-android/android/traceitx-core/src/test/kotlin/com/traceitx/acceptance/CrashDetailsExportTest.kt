// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.acceptance

import com.traceitx.CaptureExceptionOptions
import com.traceitx.ErrorSeverity
import com.traceitx.crash.normalizeCrashDetails
import com.traceitx.envelope.EnvelopeBuilder
import com.traceitx.protocol.generated.CrashDetails
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CrashDetailsExportTest {
    @Test fun `native serialized details preserve semantics and optionally export fresh bytes`() {
        val normal = normalizeCrashDetails(CaptureExceptionOptions(ErrorSeverity.WARNING, "checkout",
            linkedMapOf("attempt" to 2, "accessToken" to "synthetic", "items" to listOf(true, null, "ok")))) { it }
        assertEquals("checkout", normal.context)
        assertEquals("[REDACTED]", normal.metadata!!["accessToken"]!!.jsonPrimitive.content)
        assertEquals(2, normal.metadata!!["attempt"]!!.jsonPrimitive.int)
        assertEquals(JsonArray(listOf(JsonPrimitive(true), JsonNull, JsonPrimitive("ok"))), normal.metadata!!["items"])
        assertNull(normal.truncated)
        val expanding = normalizeCrashDetails(CaptureExceptionOptions(ErrorSeverity.INFO, "context",
            mapOf("value" to "text"))) { if (it == "value") it else "x".repeat(5000) }
        assertEquals("x".repeat(256), expanding.context)
        assertEquals("x".repeat(1024), expanding.metadata!!["value"]!!.jsonPrimitive.content)
        assertEquals(true, expanding.truncated)
        val repaired = normalizeCrashDetails(CaptureExceptionOptions(context = "a\u0000b\uD800",
            metadata = mapOf("text" to "\uDC00\uD83D\uDE00"))) { it }
        assertEquals("a\uFFFDb\uFFFD", repaired.context)
        assertEquals("\uFFFD\uD83D\uDE00", repaired.metadata!!["text"]!!.jsonPrimitive.content)
        assertEquals(true, repaired.truncated)
        val capped = normalizeCrashDetails(CaptureExceptionOptions(context = "c".repeat(300),
            metadata = (0 until 20).associate { "item$it" to "界".repeat(1024) })) { it }
        assertEquals("c".repeat(256), capped.context)
        assertEquals(true, capped.truncated)
        assertTrue(capped.metadata!!.isNotEmpty())
        assertTrue(capped.metadata!!.size < 20)
        val prototype = normalizeCrashDetails(CaptureExceptionOptions(metadata = linkedMapOf(
            "__proto__" to mapOf("own" to true), "constructor" to "ordinary", "sibling" to 2))) { it }
        assertEquals(JsonObject(mapOf("own" to JsonPrimitive(true))), prototype.metadata!!["__proto__"])
        assertEquals("ordinary", prototype.metadata!!["constructor"]!!.jsonPrimitive.content)
        assertEquals(2, prototype.metadata!!["sibling"]!!.jsonPrimitive.int)
        val numericMetadata = linkedMapOf<String, Any?>("number" to 1e20)
        repeat(7) { numericMetadata["s$it"] = "x".repeat(1_024) }
        numericMetadata["tail"] = "x".repeat(909)
        val numericBoundary = normalizeCrashDetails(CaptureExceptionOptions(metadata = numericMetadata)) { it }
        assertEquals(1e20, numericBoundary.metadata!!["number"]!!.jsonPrimitive.double, 0.0)
        assertEquals(true, numericBoundary.truncated)
        val cases = listOf("normal" to normal, "expanding-redactor" to expanding,
            "repaired-text" to repaired, "capped" to capped, "prototype-keys" to prototype,
            "numeric-boundary" to numericBoundary).map { (name, details) ->
            val bytes = EnvelopeBuilder.JSON.encodeToString(CrashDetails.serializer(), details)
            assertTrue("$name exceeds wire cap", bytes.toByteArray(Charsets.UTF_8).size <= 8192)
            assertEquals(details, EnvelopeBuilder.JSON.decodeFromString(CrashDetails.serializer(), bytes))
            buildJsonObject { put("name", name); put("detailsJson", bytes) }
        }
        System.getProperty("traceitxCrashDetailsOutput")?.let { output ->
            val destination = Paths.get(output)
            require(destination.isAbsolute) { "traceitxCrashDetailsOutput must be absolute" }
            require(Files.isDirectory(destination.parent)) { "Export parent must exist" }
            val record = buildJsonObject { put("schemaVersion", 1); put("cases", JsonArray(cases)) }
            Files.write(destination, EnvelopeBuilder.JSON.encodeToString(record).toByteArray(Charsets.UTF_8), CREATE_NEW, WRITE)
        }
    }
}
