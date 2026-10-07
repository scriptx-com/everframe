// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.shared.SharedData
import dev.everframe.envelope.EnvelopeBuilder
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class ThrowableCauseCaptureTest {
    @Before fun setup() { SharedData.init(androidx.test.core.app.ApplicationProvider.getApplicationContext()) }
    private class Counted(val next: Throwable?) : RuntimeException("node") {
        var reads = 0
        override val cause: Throwable? get() { reads++; check(reads == 1); return next }
    }
    @Test fun `both projections read each cause only once`() {
        val tail = Counted(null)
        val inner = Counted(tail)
        val root = Counted(inner)
        val value = captureThrowableContext(root, "mapping-1") { true }
        assertEquals(listOf(1, 1, 1), listOf(root.reads, inner.reads, tail.reads))
        assertEquals(listOf("node", "node"), value.causeChain!!.causes.map { it.message })
        assertEquals(2, value.jvm.causes.size)
        assertEquals("mapping-1", value.jvm.mappingID)
    }
    @Test fun `generic byte exhaustion does not shrink JVM representation`() {
        var current: Throwable = RuntimeException("tail").apply { stackTrace = emptyArray() }
        repeat(8) { current = RuntimeException("界".repeat(4096), current).apply {
            stackTrace = Array(32) { StackTraceElement("界".repeat(1024), "method", "file.kt", 12) }
        } }
        val value = captureThrowableContext(current, "r8-map") { true }
        val generic = requireNotNull(value.causeChain)
        assertTrue(generic.truncated)
        assertTrue(EnvelopeBuilder.JSON.encodeToString(generic).toByteArray().size <= 65536)
        assertEquals(8, value.jvm.causes.size)
        assertEquals(32, value.jvm.causes.first().frames.size)
        assertFalse(value.jvm.causesTruncated)
        assertEquals("r8-map", value.jvm.mappingID)
    }
    @Test fun `a secret cut by the generic scan window is dropped rather than kept unredacted`() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9." + "A".repeat(9000) + "." + "S".repeat(43)
        val value = captureThrowableContext(RuntimeException("outer", IllegalStateException("x".repeat(4000) + " " + jwt)), null) { true }
        val generic = requireNotNull(value.causeChain)
        assertEquals("x".repeat(4000), generic.causes.single().message)
        assertTrue(generic.truncated)
        assertEquals("x".repeat(4000) + " [REDACTED:JWT]", value.jvm.causes.single().message)
    }
    @Test fun `absent causes stay absent and root getter failure marks loss`() {
        assertNull(captureThrowableContext(RuntimeException(), null) { true }.causeChain)
        val root = object : RuntimeException() { override val cause: Throwable? get() = error("host") }
        val chain = requireNotNull(captureThrowableContext(root, null) { true }.causeChain)
        assertTrue(chain.truncated)
        assertTrue(chain.causes.isEmpty())
    }
    @Test fun `message and stack failures preserve later cause and describe generic loss`() {
        val inner = object : RuntimeException("unused", RuntimeException("tail")) {
            override val message: String? get() = error("message")
            override fun getStackTrace(): Array<StackTraceElement> = error("stack")
        }
        val value = captureThrowableContext(RuntimeException("outer", inner), null) { true }
        assertEquals("tail", value.causeChain!!.causes.last().message)
        assertTrue(value.causeChain.truncated)
        assertTrue(value.causeChain.causes.first().framesTruncated)
        assertFalse(value.jvm.causesTruncated)
    }
    @Test fun `ownership loss stops before reading the next host field`() {
        var owned = true
        var forbiddenReads = 0
        val inner = object : RuntimeException() {
            override val message: String? get() { owned = false; return "changed" }
            override fun getStackTrace(): Array<StackTraceElement> { forbiddenReads++; return emptyArray() }
        }
        val result = captureThrowableContext(RuntimeException("root", inner), null) { owned }
        assertNull(result.causeChain)
        assertEquals(0, forbiddenReads)
    }
    @Test fun `cycle and ninth cause mark generic chain loss but exact eight does not`() {
        val a = RuntimeException("a"); val b = RuntimeException("b")
        a.initCause(b); b.initCause(a)
        val cyclic = requireNotNull(captureThrowableContext(a, null) { true }.causeChain)
        assertEquals(listOf("b"), cyclic.causes.map { it.message }); assertTrue(cyclic.truncated)
        fun chain(n: Int): Throwable { var result: Throwable = RuntimeException("tail"); repeat(n) { result = RuntimeException("node", result) }; return result }
        assertFalse(captureThrowableContext(chain(8), null) { true }.causeChain!!.truncated)
        assertTrue(captureThrowableContext(chain(9), null) { true }.causeChain!!.truncated)
    }
}
