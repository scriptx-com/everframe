// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.transport

import dev.everframe.Everframe

data class ReportAuthorizationDecision(val reportAllowed: Boolean, val replayAllowed: Boolean)
interface ReportAuthorization {
    fun evaluate(): ReportAuthorizationDecision
    /** start may only enqueue an already prepared call, never prepare or await it. */
    fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean
}

internal class LockedReportAuthorization(
    private val reportPermit: () -> Boolean,
    private val replayPermit: () -> Boolean,
) : ReportAuthorization {
    private var replayRevoked = false
    private fun decision(): ReportAuthorizationDecision {
        val report = reportPermit()
        if (!report || !replayPermit()) replayRevoked = true
        return ReportAuthorizationDecision(report, report && !replayRevoked)
    }
    override fun evaluate() = Everframe.withReportAuthorizationLock { decision() }
    override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean =
        Everframe.withReportAuthorizationLock {
            val current = decision()
            if (!current.reportAllowed || current != expected) false else { start(); true }
        }
}
