// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.crash

import com.traceitx.envelope.EnvelopeBuilder
import kotlinx.serialization.json.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class RNCrashDetailsTest {
    @org.junit.Before fun initializeRedaction() {
        com.traceitx.shared.SharedData.init(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    @Test fun `wire keeps large binary64 and masks sensitive metadata`() {
        val raw = JSONObject("""{"severity":"warning","metadata":{"n":9007199254740994,"accessToken":"synthetic"}}""")
        val details = requireNotNull(normalizeRNCrashDetails(raw))
        val wire = EnvelopeBuilder.JSON.encodeToJsonElement(details).jsonObject
        assertEquals("warning", wire["severity"]!!.jsonPrimitive.content)
        assertEquals(9007199254740994.0, wire["metadata"]!!.jsonObject["n"]!!.jsonPrimitive.double, 0.0)
        assertEquals("[REDACTED]", wire["metadata"]!!.jsonObject["accessToken"]!!.jsonPrimitive.content)
    }

    private fun wire(raw: Any?): JsonObject = EnvelopeBuilder.JSON.encodeToJsonElement(requireNotNull(normalizeRNCrashDetails(raw))).jsonObject

    @Test fun `absence stays absent but invalid supplied root records loss`() {
        assertNull(normalizeRNCrashDetails(null))
        for (raw in listOf(JSONObject.NULL, false, 3, "bad", org.json.JSONArray(), mapOf("severity" to "warning"))) {
            assertEquals(Json.parseToJsonElement("""{"severity":"error","truncated":true}"""), wire(raw))
        }
        assertEquals(Json.parseToJsonElement("""{"severity":"error"}"""), wire(JSONObject("""{"future":123}""")))
    }

    @Test fun `invalid optional siblings preserve valid data and inherited loss`() {
        for (json in listOf(
            """{"severity":null,"context":"checkout","metadata":{"n":2}}""",
            """{"severity":"WARNING","context":"checkout","metadata":{"n":2}}""",
            """{"truncated":"true","context":"checkout","metadata":{"n":2}}""",
            """{"truncated":true,"context":"checkout","metadata":{"n":2}}""",
        )) {
            val w = wire(JSONObject(json))
            assertEquals("error", w["severity"]!!.jsonPrimitive.content)
            assertEquals("checkout", w["context"]!!.jsonPrimitive.content)
            assertEquals(2.0, w["metadata"]!!.jsonObject["n"]!!.jsonPrimitive.double, 0.0)
            assertTrue(w["truncated"]!!.jsonPrimitive.boolean)
        }
        for (field in listOf("context", "metadata")) {
            for (bad in listOf("null", "true", "[]", "42")) {
                val w = wire(JSONObject("""{"severity":"info","$field":$bad}"""))
                assertEquals("info", w["severity"]!!.jsonPrimitive.content)
                assertFalse(w.containsKey(field))
                assertTrue(w["truncated"]!!.jsonPrimitive.boolean)
            }
        }
        assertFalse(wire(JSONObject("""{"truncated":false}""")).containsKey("truncated"))
    }

    @Test fun `finite wire numbers retain binary64 semantics and boolean identity`() {
        val w = wire(JSONObject("""{"metadata":{"numbers":[9007199254740992,9007199254740994,-9007199254740994,1e100,1.25,0],"bool":true,"__proto__":{"value":false}}}"""))
        assertEquals(listOf(9007199254740992.0,9007199254740994.0,-9007199254740994.0,1e100,1.25,0.0),
            w["metadata"]!!.jsonObject["numbers"]!!.jsonArray.map { it.jsonPrimitive.double })
        assertEquals(true, w["metadata"]!!.jsonObject["bool"]!!.jsonPrimitive.boolean)
        assertEquals(false, w["metadata"]!!.jsonObject["__proto__"]!!.jsonObject["value"]!!.jsonPrimitive.boolean)
        assertFalse(w.containsKey("truncated"))
    }

    @Test fun `lazy views mask sensitive keys and omit huge keys before accessing values`() {
        var forbiddenReads = 0
        val metadata = object : JSONObject() {
            override fun get(name: String): Any {
                if (name == "accessToken" || name.length > 4096) { forbiddenReads++; error("must not read") }
                return super.get(name)
            }
        }.put("accessToken", "sensitive").put("k".repeat(4097), "omitted").put("safe", 1)
        val w = wire(JSONObject().put("metadata", metadata))
        assertEquals(0, forbiddenReads)
        assertEquals(setOf("accessToken", "safe"), w["metadata"]!!.jsonObject.keys)
        assertEquals("[REDACTED]", w["metadata"]!!.jsonObject["accessToken"]!!.jsonPrimitive.content)
        assertTrue(w["truncated"]!!.jsonPrimitive.boolean)
        assertFalse(wire(JSONObject("""{"metadata":{"password":"x"}}""")).containsKey("truncated"))
    }

    @Test fun `unsupported host leaves are omitted in objects and null in arrays`() {
        val bad = object { override fun toString(): String = error("no coercion") }
        val w = wire(JSONObject().put("metadata", JSONObject().put("bad", bad)
            .put("list", org.json.JSONArray().put(bad).put(JSONObject.NULL).put(true))))
        assertEquals(Json.parseToJsonElement("""{"list":[null,null,true]}"""), w["metadata"])
        assertTrue(w["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test fun `budget charges skipped children without accessing the tail`() {
        var reads = 0
        val metadata = object : JSONObject() {
            override fun get(name: String): Any { reads++; return Any() }
        }
        repeat(1000) { metadata.put("key$it", 1) }
        val w = wire(JSONObject().put("metadata", metadata))
        assertEquals(127, reads)
        assertEquals(JsonObject(emptyMap()), w["metadata"])
        assertTrue(w["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test fun `context key string depth and byte caps share inherited loss before fitting`() {
        val nested = JSONObject("""{"a":{"b":{"c":{"omitted":{"d":1}},"ok":true}}}""")
        val deep = wire(JSONObject().put("metadata", nested))
        assertTrue(deep["truncated"]!!.jsonPrimitive.boolean)
        assertFalse(deep["metadata"]!!.jsonObject["a"]!!.jsonObject["b"]!!.jsonObject["c"]!!.jsonObject.containsKey("omitted"))
        val metadata = JSONObject().put("k".repeat(200), "v".repeat(5000))
        val capped = wire(JSONObject().put("context", "c".repeat(300)).put("metadata", metadata))
        assertEquals(256, capped["context"]!!.jsonPrimitive.content.length)
        assertEquals(128, capped["metadata"]!!.jsonObject.keys.single().length)
        assertEquals(1024, capped["metadata"]!!.jsonObject.values.single().jsonPrimitive.content.length)
        val large = JSONObject()
        repeat(20) { large.put("key$it", "界".repeat(1024)) }
        val bytes = wire(JSONObject().put("metadata", large).put("truncated", true))
        assertTrue(bytes.toString().toByteArray().size <= 8192)
        assertTrue(bytes["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test fun `raw details are unread while ineligible and nested capture is refused under guard`() {
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val dir = java.nio.file.Files.createTempDirectory("rn-details-capture").toFile()
        val keys = com.traceitx.outbox.JceTestOutboxKeyProvider()
        val ops = com.traceitx.outbox.JvmOutboxFileOps()
        var reads = 0
        val raw = object : JSONObject() {
            override fun get(name: String): Any {
                reads++
                assertFalse(CrashReporter.captureHandledFactsWithDetails("Nested", "nested", emptyList(), "2026-09-15T00:00:00Z", null, JSONObject()))
                return super.get(name)
            }
        }.put("metadata", JSONObject().put("n", 2))
        fun capture() = CrashReporter.captureHandledFactsWithDetails("Outer", "outer", emptyList(), "2026-09-15T00:00:00Z", null, raw)
        com.traceitx.shared.SharedData.init(context)
        CrashReporter.__resetForTesting()
        com.traceitx.TraceItX.__setConfigForTesting(null)
        try {
            assertFalse(capture())
            assertEquals(0, reads)
            CrashReporter.configure(context)
            val cfg = com.traceitx.config.TraceItXConfig(appId = "rn-test", sdkKey = "synthetic")
            com.traceitx.TraceItX.__setConfigForTesting(cfg)
            com.traceitx.TraceItX.captureGate = true
            CrashReporter.sidecarFactory = { com.traceitx.outbox.CrashSidecar(java.io.File(dir, "crash-outbox.jsonl"), keys, ops) }
            assertTrue(capture())
            assertTrue(reads > 0)
            raw.optJSONObject("metadata")!!.put("n", 99)
            val entries = kotlinx.coroutines.runBlocking { com.traceitx.outbox.JSONLOutbox(java.io.File(dir, "outbox.jsonl"), keys, ops).hydrate() }
            val crash = Json.parseToJsonElement(String(entries.single().envelopeBytes)).jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject
            assertEquals(2.0, crash["details"]!!.jsonObject["metadata"]!!.jsonObject["n"]!!.jsonPrimitive.double, 0.0)
            assertEquals("Outer", crash["exceptionType"]!!.jsonPrimitive.content)
            com.traceitx.TraceItX.__setConfigForTesting(cfg.copy(capture = cfg.capture.copy(crash = false)))
            val before = reads
            assertFalse(capture())
            assertEquals(before, reads)
        } finally {
            com.traceitx.TraceItX.__setConfigForTesting(null)
            com.traceitx.TraceItX.captureGate = false
            CrashReporter.__resetForTesting()
            dir.deleteRecursively()
        }
    }
    @Test fun `invalid root fields never invoke host equality or coercion`() {
        val hostile = object {
            override fun equals(other: Any?): Boolean = error("host equality must not run")
            override fun hashCode(): Int = error("host hashing must not run")
            override fun toString(): String = error("host coercion must not run")
        }
        for (field in listOf("severity", "truncated")) {
            val result = wire(JSONObject().put(field, hostile).put("context", "valid"))
            assertEquals("valid", result["context"]!!.jsonPrimitive.content)
            assertEquals("error", result["severity"]!!.jsonPrimitive.content)
            assertTrue(result["truncated"]!!.jsonPrimitive.boolean)
        }
    }
}
