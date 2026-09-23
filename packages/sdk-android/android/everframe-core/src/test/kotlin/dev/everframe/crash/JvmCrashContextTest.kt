// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.shared.SharedData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class JvmCrashContextTest {

    @Before
    fun setUp() {
        SharedData.init(ApplicationProvider.getApplicationContext<Context>())
    }

    @Test
    fun `a throwable without a cause produces complete empty JVM context`() {
        val context = captureJvmContext(RuntimeException("outer"), null)

        assertEquals(emptyList<Any>(), context.causes)
        assertFalse(context.causesTruncated)
        assertNull(context.mappingID)
    }

    @Test
    fun `eight causes are retained completely and a ninth is truncated`() {
        val exact = causeChain(8)
        val exactContext = captureJvmContext(exact, null)
        assertEquals(8, exactContext.causes.size)
        assertEquals("cause-1", exactContext.causes.first().message)
        assertEquals("cause-8", exactContext.causes.last().message)
        assertFalse(exactContext.causesTruncated)

        val over = causeChain(9)
        val overContext = captureJvmContext(over, null)
        assertEquals(8, overContext.causes.size)
        assertEquals("cause-8", overContext.causes.last().message)
        assertTrue(overContext.causesTruncated)
    }

    @Test
    fun `thirty two cause frames are complete and a thirty third is truncated`() {
        val exactCause = IllegalStateException("exact").apply { stackTrace = frames(32) }
        val exact = captureJvmContext(RuntimeException("outer", exactCause), null).causes.single()
        assertEquals(32, exact.frames.size)
        assertFalse(exact.framesTruncated)

        val overCause = IllegalStateException("over").apply { stackTrace = frames(33) }
        val over = captureJvmContext(RuntimeException("outer", overCause), null).causes.single()
        assertEquals(32, over.frames.size)
        assertEquals(31L, over.frames.last().line)
        assertTrue(over.framesTruncated)
    }

    @Test
    fun `cycles are detected by Throwable identity`() {
        val first = IdentityThrowable("first")
        val second = IdentityThrowable("second")
        first.initCause(second)
        second.initCause(first)

        val context = captureJvmContext(RuntimeException("outer", first), null)

        assertEquals(listOf("first", "second"), context.causes.map { it.message })
        assertTrue(context.causesTruncated)
    }

    @Test
    fun `a failed root cause read returns truncated optional context`() {
        val context = captureJvmContext(HostileCauseThrowable("outer"), null)

        assertTrue(context.causes.isEmpty())
        assertTrue(context.causesTruncated)
    }

    @Test
    fun `a cause with hostile message and stack keeps its header and later cause`() {
        val tail = IllegalArgumentException("tail").apply { stackTrace = frames(1) }
        val hostile = HostileMessageAndStackThrowable(tail)

        val context = captureJvmContext(RuntimeException("outer", hostile), null)

        assertEquals(2, context.causes.size)
        assertEquals(HostileMessageAndStackThrowable::class.java.name, context.causes[0].message)
        assertTrue(context.causes[0].frames.isEmpty())
        assertTrue(context.causes[0].framesTruncated)
        assertEquals("tail", context.causes[1].message)
        assertFalse(context.causesTruncated)
    }

    @Test
    fun `a failed next cause read preserves the captured node and marks chain truncated`() {
        val hostile = HostileNextCauseThrowable("available").apply { stackTrace = frames(1) }

        val context = captureJvmContext(RootWithCause(hostile), null)

        assertEquals(listOf("available"), context.causes.map { it.message })
        assertTrue(context.causesTruncated)
    }

    @Test
    fun `cause accessors are read once per throwable`() {
        val tail = CountingCauseThrowable("tail", null)
        val first = CountingCauseThrowable("first", tail)
        val root = CountingCauseThrowable("root", first)

        val context = captureJvmContext(root, null)

        assertEquals(listOf("first", "tail"), context.causes.map { it.message })
        assertEquals(1, root.causeReads)
        assertEquals(1, first.causeReads)
        assertEquals(1, tail.causeReads)
    }

    @Test
    fun `new cause text is redacted and capped after expansion`() {
        val ssn = "123-45-6789"
        val cause = IllegalStateException("m".repeat(4096 - ssn.length - 1) + " " + ssn).apply {
            stackTrace = arrayOf(
                StackTraceElement(
                    "sample.$ssn." + "c".repeat(1100),
                    "$ssn-" + "f".repeat(600),
                    "$ssn-" + "k".repeat(1100),
                    -1,
                ),
            )
        }

        val captured = captureJvmContext(RuntimeException("outer", cause), null).causes.single()
        val frame = captured.frames.single()

        assertEquals(4096, captured.message.length)
        assertFalse(captured.message.contains(ssn))
        assertEquals(1024, frame.raw.length)
        assertFalse(frame.raw.contains(ssn))
        assertEquals(1024, frame.file!!.length)
        assertFalse(frame.file!!.contains(ssn))
        assertEquals(512, frame.function!!.length)
        assertFalse(frame.function!!.contains(ssn))
        assertNull(frame.line)
        assertNull(frame.col)
    }

    @Test
    fun `optional cause text replaces JSONB-unsafe code units and preserves supplementary characters`() {
        val cause = IllegalStateException("inner\u0000\uD800😀\uDC00tail").apply {
            stackTrace = arrayOf(
                StackTraceElement(
                    "sample.Type",
                    "run\u0000\uD800😀",
                    "File\uDC00\u0000😀.kt",
                    7,
                ),
            )
        }

        val captured = captureJvmContext(RuntimeException("outer", cause), null).causes.single()
        val frame = captured.frames.single()

        assertEquals("inner��😀�tail", captured.message)
        assertEquals("run��😀", frame.function)
        assertEquals("File��😀.kt", frame.file)
        assertTrue(frame.raw.contains("run��😀"))
        assertTrue(frame.raw.contains("File��😀.kt"))
    }

    @Test
    fun `optional cause text remains well formed when its cap splits a surrogate pair`() {
        val cause = IllegalStateException("m".repeat(4095) + "😀")

        val captured = captureJvmContext(RuntimeException("outer", cause), null).causes.single()

        assertEquals(4096, captured.message.length)
        assertEquals("m".repeat(4095) + "�", captured.message)
    }

    @Test
    fun `overlong cause type is redacted before its exact post-redaction cap`() {
        val token = "4111111111111111"
        val cause = `4111111111111111`.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAException()
        assertTrue(cause.javaClass.name.length > 256)
        assertTrue(cause.javaClass.name.contains(token))

        val context = captureJvmContext(
            RuntimeException("outer", cause),
            null,
        )

        val capturedType = context.causes.single().exceptionType
        assertEquals(256, capturedType.length)
        assertTrue(capturedType.contains("[REDACTED:CC]"))
        assertFalse(capturedType.contains(token))
    }

    @Test
    fun `mapping identity accepts exact grammar and omits invalid values`() {
        val valid = "A" + "a._-9".repeat(25) + "bc"
        assertEquals(128, valid.length)
        assertEquals(valid, captureJvmContext(RuntimeException("outer"), valid).mappingID)

        val invalid = listOf("", " leading", "trailing ", "a/b", "a".repeat(129))
        for (id in invalid) {
            assertNull("invalid ID must be omitted exactly: '$id'", captureJvmContext(RuntimeException("outer"), id).mappingID)
        }
    }

    private fun causeChain(count: Int): Throwable {
        var current: Throwable? = null
        for (index in count downTo 1) {
            current = RuntimeException("cause-$index", current).apply { stackTrace = frames(1) }
        }
        return RuntimeException("outer", current)
    }

    private fun frames(count: Int) = Array(count) { index ->
        StackTraceElement("sample.Type$index", "run$index", "File$index.kt", index)
    }

    private class IdentityThrowable(message: String) : Throwable(message) {
        override fun equals(other: Any?) = other is IdentityThrowable
        override fun hashCode() = 1
    }

    private class HostileCauseThrowable(message: String) : Throwable(message) {
        override val cause: Throwable
            get() = error("cause unavailable")
    }

    private class HostileMessageAndStackThrowable(private val next: Throwable) : Throwable() {
        override val message: String
            get() = error("message unavailable")
        override val cause: Throwable
            get() = next
        override fun getStackTrace(): Array<StackTraceElement> = error("stack unavailable")
    }

    private class HostileNextCauseThrowable(message: String) : Throwable(message) {
        override val cause: Throwable
            get() = error("next cause unavailable")
    }

    private class RootWithCause(private val next: Throwable) : Throwable("root") {
        override val cause: Throwable
            get() = next
    }

    private class CountingCauseThrowable(
        message: String,
        private val next: Throwable?,
    ) : Throwable(message) {
        var causeReads = 0
            private set

        override val cause: Throwable?
            get() {
                causeReads += 1
                return next
            }
    }

    private class `4111111111111111` {
        class AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAException : Throwable()
    }
}
