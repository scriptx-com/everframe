// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.state
import dev.everframe.capture.EvidenceSequence
import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(manifest = org.robolectric.annotation.Config.NONE)
class StateRecorderTest {
    @org.junit.Before fun setup() { dev.everframe.shared.SharedData.init(androidx.test.core.app.ApplicationProvider.getApplicationContext()) }
    private fun make(): StateRecorder = StateRecorder(now = { 1001.0 }, sequence = EvidenceSequence()).also {
        it.reset(StateSnapshot(emptyMap(), emptyMap()), 1000.0)
    }
    @Test fun sharedWireFixtureReplaysWithNativePrimitiveTypes() {
        val fixture = Json.decodeFromString(ReportState.serializer(), java.io.File("../../../protocol/__tests__/fixtures/state.v1.json").readText())
        val r = make(); r.reset(fixture.initial, fixture.startedAt)
        fixture.changes.forEach { if (it.value != null) r.set(it.key, it.value!!, it.namespace) else r.clear(it.key, it.namespace) }
        assertEquals(fixture.current, r.snapshot(fixture.capturedAt)!!.current)
    }
    @Test fun concurrentWritesAndCallerMutationCannotChangeOwnedEvidence() {
        val r = make()
        val workers = (0..<10).map { key -> Thread { repeat(30) { r.set("key$key", StateValue.DoubleValue(it.toDouble())) } }.also { it.start() } }
        workers.forEach { it.join() }
        val captured = r.snapshot(1002.0)!!
        (captured.current.custom as MutableMap).clear()
        assertEquals(10, r.snapshot(1003.0)!!.current.custom.size)
        val sequence = r.snapshot(1003.0)!!.changes.map { it.seq }
        assertTrue(sequence.zipWithNext().all { (a, b) -> a < b })
    }
    @Test fun typedValuesFreezeAndClear() {
        val r = make()
        assertTrue(r.set("plan", StateValue.StringValue("free")))
        assertFalse(r.set("plan", StateValue.StringValue("free")))
        assertTrue(r.set("enabled", StateValue.BoolValue(false)))
        assertTrue(r.set("count", StateValue.DoubleValue(0.0)))
        r.freeze(1002.0)
        r.set("plan", StateValue.StringValue("premium"))
        assertEquals(StateValue.StringValue("free"), r.takeFrozen()!!.current.custom["plan"])
        assertTrue(r.clear("plan")); assertFalse(r.clear("plan"))
        assertEquals(5, r.snapshot(1003.0)!!.changes.size)
        r.erase(); assertNull(r.snapshot(1004.0)); assertFalse(r.set("late", StateValue.BoolValue(true)))
    }
    @Test fun boundedHistoryAndDistinctKeys() {
        val r = make()
        repeat(150) { assertTrue(r.set("count", StateValue.DoubleValue(it.toDouble()))) }
        val s = r.snapshot(1003.0)!!
        assertEquals(100, s.changes.size); assertEquals(50L, s.droppedChanges)
        assertEquals(49L, s.checkpoint!!.throughSeq); assertTrue(s.initial.custom.isEmpty())
        repeat(49) { assertTrue(r.set("key$it", StateValue.BoolValue(false))) }
        assertFalse(r.set("overflow", StateValue.BoolValue(true)))
        r.clear("key0"); assertFalse(r.set("another", StateValue.BoolValue(true)))
        assertTrue(r.set("key0", StateValue.BoolValue(true)))
    }
    @Test fun validationAndPrivacy() {
        val r = make()
        listOf("", "__proto__", "bad\u0000key", "\uD800", "a".repeat(65)).forEach { assertFalse(r.set(it, StateValue.BoolValue(true))) }
        assertFalse(r.set("nan", StateValue.DoubleValue(Double.NaN)))
        assertFalse(r.set("long", StateValue.StringValue("a".repeat(257))))
        assertTrue(r.set("apiKey", StateValue.DoubleValue(123.0)))
        assertEquals(StateValue.StringValue("[REDACTED]"), r.snapshot(1003.0)!!.current.custom["apiKey"])
    }
    @Test fun sharedOrderingAndCancel() {
        val sequence = EvidenceSequence()
        val r = StateRecorder(now = { 1000.0 }, sequence = sequence)
        r.reset(StateSnapshot(emptyMap(), emptyMap()), 1000.0)
        r.set("one", StateValue.BoolValue(true)); val between = sequence.next()
        r.set("two", StateValue.BoolValue(true)); r.freeze(1001.0)
        r.set("three", StateValue.BoolValue(true)); r.discardFrozen()
        assertNull(r.takeFrozen())
        val changes = r.snapshot(1002.0)!!.changes
        assertTrue(changes[0].seq < between && changes[1].seq > between)
        assertEquals(3, changes.size)
    }
    @Test fun wireByteBudgets() {
        val r = make()
        repeat(50) { r.set("key$it", StateValue.StringValue("😀".repeat(128))) }
        assertTrue(Json.encodeToString(r.snapshot(1003.0)!!.current.custom).toByteArray().size <= 8192)
        repeat(200) { r.set("key0", StateValue.StringValue("😀".repeat(120) + it)) }
        assertTrue(Json.encodeToString(r.snapshot(1004.0)).toByteArray().size <= 32768)
    }
    // JSON.stringify expands these doubles to 21-digit integers. The remaining
    // test values contain no numeric-looking strings; native metadata numbers
    // are at least as long as their JavaScript representation.
    private inline fun <reified T> javascriptBytes(value: T): Int = Json.encodeToString(value)
        .replace("1.0E20", "100000000000000000000").toByteArray(Charsets.UTF_8).size
    @Test fun largeNumbersRespectJavascriptCustomBudget() {
        val r = make()
        repeat(20) { assertTrue(r.set("number$it", StateValue.DoubleValue(1e20))) }
        repeat(29) { r.set("label$it", StateValue.StringValue("x".repeat(255))) }
        assertTrue(javascriptBytes(r.snapshot(1003.0)!!.current.custom) <= 8192)
    }
    @Test fun numericLookingStringsDoNotConsumeNumberReserve() {
        val r = make()
        repeat(30) { assertTrue(r.set("label$it", StateValue.StringValue("1e+20 ".repeat(42)))) }
        assertEquals(30, r.snapshot(1003.0)!!.current.custom.size)
    }
    @Test fun largeNumbersRespectJavascriptInitialAndTotalBudgets() {
        val values = (0..<20).associate { "number$it" to StateValue.DoubleValue(1e20) } +
            (0..<29).associate { "label$it" to StateValue.StringValue("x".repeat(255)) }
        val r = make()
        r.reset(StateSnapshot(emptyMap(), values), 1000.0)
        assertTrue(javascriptBytes(r.snapshot(1003.0)!!.initial.custom) <= 8192)
        repeat(200) {
            r.set("number0", StateValue.DoubleValue(if (it % 2 == 0) -1e20 else 1e20))
            assertTrue(javascriptBytes(r.snapshot(1004.0)) <= 32768)
        }
    }
}
