// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

enum class ReporterTrigger(val value: String) {
    Button("button"), Shake("shake"), Menu("menu"), Companion("companion"),

    /** Emulator quick capture (`adb shell am broadcast -a com.everframe.CAPTURE`); files a report with no reporter UI. */
    QuickCapture("quick_capture");

    companion object Parser {
        fun fromValue(value: String): ReporterTrigger? = entries.firstOrNull { it.value == value }
    }
}

/** Cross-module propagation keeps the existing reporter resolver signature compatible. */
class ReporterTriggerContext(val trigger: ReporterTrigger) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<ReporterTriggerContext>
}
