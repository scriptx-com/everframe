// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

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
                listOf(frame.replace("index.android.bundle", "other.bundle")), listOf("at apply (native)"))) {
            remember(guard, frames)
            assertFalse(guard.consume(wrapper(), 7, 2))
        }
    }

    // Smoke round 2026-10: an uncaught render error. RN's title carries the
    // component stack, exactly as the JS layer now reports the message.
    private val componentStack = "\n    at ExplodingRow (address at index.android.bundle:1:1243264)\n    at RCTView (<anonymous>)"
    private val renderFrames = listOf("at ExplodingRow (address at index.android.bundle:1:1243264)",
        "at renderWithHooks (address at index.android.bundle:1:504783)")
    private val renderStack = ", stack:\nExplodingRow@1:1243264\nrenderWithHooks@1:504783\n"

    @Test fun `render error title with its component stack matches RN's wrapper`() {
        val guard = AcceptedHermesFatal()
        val message = "smoke js-render: ExplodingRow\n\nThis error is located at:$componentStack"
        guard.remember(guard.beginAttempt(), "Error", message, renderFrames, "index.android.bundle", 7, 2)
        assertTrue(guard.consume(wrapper("Error: $message$renderStack"), 7, 2))
    }

    @Test fun `a message cut at the bridge cap matches RN's longer title by prefix only`() {
        val guard = AcceptedHermesFatal()
        val full = "deep tree\n\nThis error is located at:" + componentStack.repeat(80)
        val cut = full.take(4096)
        guard.remember(guard.beginAttempt(), "Error", cut, renderFrames, "index.android.bundle", 7, 2)
        assertFalse(guard.consume(wrapper("Error: other${full.drop(5)}$renderStack"), 7, 2))
        assertFalse(guard.consume(wrapper("Error: $full, stack:\nExplodingRow@1:1\n"), 7, 2))
        assertTrue(guard.consume(wrapper("Error: $full$renderStack"), 7, 2))
        // An uncut message must match the whole title, not just its start.
        remember(guard)
        assertFalse(guard.consume(wrapper("Error: test fatal and more, stack:\nthrowUnhandled@1:819834\n"), 7, 2))
    }

    @Test fun `native, internal and skipped frames are dropped as React Native drops them`() {
        val guard = AcceptedHermesFatal()
        remember(guard, listOf(frame, "at apply (native)", "at anonymous (address at InternalBytecode.js:1:4711)",
            "... skipping 3 frames"))
        assertTrue(guard.consume(wrapper(), 7, 2))
    }

    @Test fun `a message that already starts with the type is not prefixed twice`() {
        val guard = AcceptedHermesFatal()
        guard.remember(guard.beginAttempt(), "Error", "Error: test fatal", listOf(frame), "index.android.bundle", 7, 2)
        assertTrue(guard.consume(wrapper(), 7, 2))
    }
}
