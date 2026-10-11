// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import java.security.MessageDigest

/** Correlates RN's immediate JVM wrapper with a JS fatal already stored on disk.
 * Unknown stacks/types fail open. No React Native dependency or raw error retention.
 */
internal class AcceptedHermesFatal(private val nanoTime: () -> Long = System::nanoTime) {
    private class Accepted(
        val title: List<Byte>,
        val titleLength: Int,
        /** The bridge cut the JS message, so RN's own title may continue past it. */
        val titleIsPrefix: Boolean,
        val stack: List<Byte>,
        val stackLength: Int,
        val epoch: Int,
        val generation: Long,
        val at: Long,
    )
    private var accepted: Accepted? = null
    private var attempt = 0L

    @Synchronized
    fun beginAttempt(): Long {
        accepted = null
        return ++attempt
    }

    @Synchronized
    fun remember(token: Long, type: String, message: String, frames: List<String>, bundleName: String, epoch: Int, generation: Long) {
        // A newer failed/reentrant capture must not inherit an older success.
        if (token != attempt) return
        accepted = null
        if (frames.isEmpty() || frames.size > 256 || message.length > MAX_MESSAGE || type.length > 256) return
        val pattern = Regex("^at ([^@\\r\\n]+?) \\(address at ${Regex.escape(bundleName)}:1:(\\d+)\\)$")
        val stack = StringBuilder(", stack:\n")
        var bytecodeFrames = 0
        for (raw in frames) {
            val frame = raw.trim()
            // RN's parseErrorStack drops these before it formats the wrapper.
            if (NATIVE_FRAME.matches(frame) || INTERNAL_FRAME.matches(frame) || SKIPPED_FRAMES.matches(frame)) continue
            val match = pattern.matchEntire(frame) ?: return
            stack.append(match.groupValues[1]).append("@1:").append(match.groupValues[2]).append('\n')
            bytecodeFrames++
        }
        if (bytecodeFrames == 0) return
        // Matches RN ExceptionsManager/JSStackTrace's fatal wrapper format:
        // "<name>: <message>[component stack], stack:\n<frames>". RN adds the
        // name only when the message does not already start with it.
        val title = if (message.startsWith("$type: ")) message else "$type: $message"
        accepted = Accepted(hash(title), title.length, message.length == MAX_MESSAGE,
            hash(stack.toString()), stack.length, epoch, generation, nanoTime())
    }

    @Synchronized
    fun consume(throwable: Throwable, epoch: Int, generation: Long): Boolean {
        val saved = accepted ?: return false
        if (saved.epoch != epoch || saved.generation != generation || nanoTime() - saved.at !in 0..5_000_000_000L) {
            accepted = null
            return false
        }
        if (throwable.javaClass.name != "com.facebook.react.common.JavascriptException") return false
        val top = throwable.stackTrace.firstOrNull() ?: return false
        if (top.className != "com.facebook.react.modules.core.ExceptionsManagerModule" || top.methodName != "reportException") return false
        val message = throwable.message ?: return false
        if (message.length > 300_000) return false
        val titleEnd = message.length - saved.stackLength
        if (titleEnd < 0 || hash(message.substring(titleEnd)) != saved.stack) return false
        val title = message.substring(0, titleEnd)
        val matches = if (saved.titleIsPrefix) {
            title.length >= saved.titleLength && hash(title.substring(0, saved.titleLength)) == saved.title
        } else {
            title.length == saved.titleLength && hash(title) == saved.title
        }
        if (!matches) return false
        accepted = null
        return true
    }

    @Synchronized fun clear() { beginAttempt() }
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).toList()

    private companion object {
        /** The RN bridge caps automatic JS messages at this many UTF-16 units. */
        const val MAX_MESSAGE = 4096
        val NATIVE_FRAME = Regex("^at .+ \\(native\\)?$")
        val INTERNAL_FRAME = Regex("^at .+ \\(address at InternalBytecode\\.js:\\d+:\\d+\\)$")
        val SKIPPED_FRAMES = Regex("^\\.\\.\\. skipping \\d+ frames$")
    }
}
