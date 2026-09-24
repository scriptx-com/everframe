// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import java.security.MessageDigest

/** Correlates RN's immediate JVM wrapper with a JS fatal already stored on disk.
 * Unknown stacks/types fail open. No React Native dependency or raw error retention.
 */
internal class AcceptedHermesFatal(private val nanoTime: () -> Long = System::nanoTime) {
    private data class Accepted(val hash: List<Byte>, val epoch: Int, val generation: Long, val at: Long)
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
        if (frames.isEmpty() || frames.size > 256 || message.length > 4096 || type.length > 256) return
        val pattern = Regex("^at ([^@\\r\\n]+?) \\(address at ${Regex.escape(bundleName)}:1:(\\d+)\\)$")
        val stack = frames.map { raw ->
            val match = pattern.matchEntire(raw.trim()) ?: return
            "${match.groupValues[1]}@1:${match.groupValues[2]}\n"
        }.joinToString("")
        // Matches RN ExceptionsManager/JSStackTrace's fatal wrapper format.
        accepted = Accepted(hash("$type: $message, stack:\n$stack"), epoch, generation, nanoTime())
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
        if (message.length > 300_000 || hash(message) != saved.hash) return false
        accepted = null
        return true
    }

    @Synchronized fun clear() { beginAttempt() }
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).toList()
}
