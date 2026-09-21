// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.crash

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AcceptedHermesFatalTest {
    private val frame = "at throwUnhandled (address at index.android.bundle:1:819834)"
    private fun wrapper(message: String = "Error: test fatal, stack:\nthrowUnhandled@1:819834\n") =
        com.facebook.react.common.JavascriptException(message).apply {
            stackTrace = arrayOf(StackTraceElement("com.facebook.react.modules.core.ExceptionsManagerModule",
                "reportException", "ExceptionsManagerModule.kt", 52))
        }
    private fun remember(guard: AcceptedHermesFatal, frames: List<String> = listOf(frame)) =
        guard.remember(guard.beginAttempt(), "Error", "test fatal", frames, "index.android.bundle", 7, 2)

    @Test fun `older in-flight success cannot replace newer failed attempt`() {
        val guard = AcceptedHermesFatal()
        val first = guard.beginAttempt()
        guard.beginAttempt()
        guard.remember(first, "Error", "test fatal", listOf(frame), "index.android.bundle", 7, 2)
        assertFalse(guard.consume(wrapper(), 7, 2))
    }

    @Test fun `matching marker is consumed only once`() {
        val guard = AcceptedHermesFatal(); remember(guard)
        assertTrue(guard.consume(wrapper(), 7, 2))
        assertFalse(guard.consume(wrapper(), 7, 2))
    }
    @Test fun `expired or different session never suppresses`() {
        var time = 0L
        val guard = AcceptedHermesFatal { time }
        remember(guard); time = 5_000_000_001L
        assertFalse(guard.consume(wrapper(), 7, 2))
        remember(guard); assertFalse(guard.consume(wrapper(), 8, 2))
        remember(guard); assertFalse(guard.consume(wrapper(), 7, 3))
    }
    @Test fun `different message offset class and call site fail open`() {
        val guard = AcceptedHermesFatal(); remember(guard)
        assertFalse(guard.consume(wrapper("Error: another, stack:\nthrowUnhandled@1:819834\n"), 7, 2))
        assertFalse(guard.consume(wrapper("Error: test fatal, stack:\nthrowUnhandled@1:9\n"), 7, 2))
        assertFalse(guard.consume(IllegalStateException(wrapper().message), 7, 2))
        assertFalse(guard.consume(wrapper().apply { stackTrace = emptyArray() }, 7, 2))
        assertTrue(guard.consume(wrapper(), 7, 2))
    }
    @Test fun `unknown or incomplete JS stacks never suppress`() {
        val guard = AcceptedHermesFatal()
        for (frames in listOf(emptyList(), listOf("native"), listOf(frame, "native"),
                listOf(frame.replace("index.android.bundle", "other.bundle")))) {
            remember(guard, frames)
            assertFalse(guard.consume(wrapper(), 7, 2))
        }
    }
}
