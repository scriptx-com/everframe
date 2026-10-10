// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

/**
 * The OS and native crash mechanisms one start arms. They are chosen only from the API level,
 * the process and whether the optional native-crash module is in the app; there is no per-start
 * opt-in. JVM exceptions are captured separately, on every API level and in every process.
 */
internal data class CrashCapturePlan(val processExit: Boolean, val nativeSignal: Boolean) {
    val any: Boolean get() = processExit || nativeSignal

    /**
     * Arms the signal collector before OS-exit recovery. On API 30 both run; the signal path first
     * admits the faults it recorded for ended launches, so exit recovery then finds them delivered
     * and sends no second, frameless crash. A failed signal arm never skips exit recovery.
     * Returns true when at least one selected mechanism armed.
     */
    fun arm(armSignal: () -> Boolean, armProcessExit: () -> Boolean): Boolean {
        val signal = nativeSignal && armSignal()
        val exit = processExit && armProcessExit()
        return signal || exit
    }

    companion object {
        fun select(apiLevel: Int, defaultProcess: Boolean, signalModulePresent: Boolean) = CrashCapturePlan(
            processExit = defaultProcess && apiLevel >= 30,
            nativeSignal = defaultProcess && signalModulePresent && apiLevel in 26..30,
        )
    }
}

/** One start's commands, issued in the critical section that publishes its configuration. */
internal class CrashCaptureStart(val epoch: Int, val plan: CrashCapturePlan, val exitCommand: Long, val signalCommand: Long)
