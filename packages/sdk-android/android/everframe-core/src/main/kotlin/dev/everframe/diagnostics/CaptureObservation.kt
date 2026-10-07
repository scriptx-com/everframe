// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

/** Lives only for a synchronous capture. Holds no captured error or payload. */
internal class CaptureObservation(val owner: ReportDiagnostics.Handle?, private val path: CapturePath) {
    var outcome: CaptureOutcome = CaptureOutcome.FAILED
    fun reject(reason: CaptureOutcome): Boolean { outcome = reason; return false }
    fun accepted(value: Boolean): Boolean {
        outcome = if (value) CaptureOutcome.PERSISTED else CaptureOutcome.STORAGE_UNAVAILABLE
        return value
    }
    fun settle() { owner?.capture(path, outcome) }
}
