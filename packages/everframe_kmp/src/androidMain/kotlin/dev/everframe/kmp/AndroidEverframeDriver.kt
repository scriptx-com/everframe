// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

import android.app.Activity
import android.content.Context
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import dev.everframe.config.TXUser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Local Android adapter; the framework UI capture remains a separate integration gate. */
class AndroidEverframeDriver(
    private val context: Context,
    private val currentActivity: Activity?,
) : EverframeNativeDriver {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun start(appId: String, sdkKey: String): Boolean {
        return try {
            Everframe.start(context, EverframeConfig(
                appId = appId,
                sdkKey = sdkKey,
                environment = Environment.development,
                capture = CaptureConfig(screenshot = false, crash = false),
            ), currentActivity)
            Everframe.captureGate
        } catch (_: Exception) {
            false
        }
    }

    override fun setUser(id: String?, email: String?, displayName: String?) {
        Everframe.setUser(if (id == null && email == null && displayName == null) null else TXUser(id, email, displayName))
    }

    override fun recordScreen(name: String) { Everframe.recordScreen(name) }
    override fun addBreadcrumb(message: String, kind: String?, level: String?) {
        Everframe.addBreadcrumb(message, kind, level)
    }

    override fun openReporter(completion: (EverframeReportOutcome) -> Unit) {
        scope.launch {
            try {
                val outcome = Everframe.report.open()
                completion(when (outcome) {
                    is ReportResult.Submitted -> EverframeReportOutcome("submitted", outcome.reportId.toString())
                    is ReportResult.Queued -> EverframeReportOutcome("queued", outcome.reportId.toString())
                    is ReportResult.Cancelled -> EverframeReportOutcome("cancelled", reason = outcome.reason)
                })
            } catch (error: Exception) {
                completion(EverframeReportOutcome("failed", reason = error.message))
            }
        }
    }

    override fun kill() { Everframe.kill() }
}
