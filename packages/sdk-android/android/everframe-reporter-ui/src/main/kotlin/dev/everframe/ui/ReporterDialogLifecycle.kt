// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.app.Application
import android.os.Bundle
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.config.ReportResult
import java.util.Collections
import java.util.WeakHashMap
import kotlinx.coroutines.CompletableDeferred

/** Main-thread ownership of a mounted dialog, ending at cancellation or Send. */
internal class ReporterDialogLifecycle(
    private val activity: Activity,
    private val capture: FrozenReportCapture,
    private val result: CompletableDeferred<ReportResult>,
    private val dismiss: () -> Unit,
) : Application.ActivityLifecycleCallbacks {
    private var editing = true

    init { activity.application.registerActivityLifecycleCallbacks(this) }

    fun cancel(reason: String) {
        if (!editing) return
        editing = false
        try { detach() } finally {
            capture.cancel()
            result.complete(ReportResult.Cancelled(reason))
        }
    }

    /** Transfer ownership to submission before removing the view or its observer. */
    fun beginSubmit(): Boolean {
        if (!editing) return false
        editing = false
        SubmittedCaptures.add(capture)
        detach()
        return true
    }

    private fun detach() {
        activity.application.unregisterActivityLifecycleCallbacks(this)
        dismiss()
    }

    override fun onActivityDestroyed(activity: Activity) {
        if (activity === this.activity) cancel("activity_destroyed")
    }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
}

/**
 * Captures that Send handed to a running submission, which releases them when
 * it ends. Weak keys: an entry lives no longer than its capture.
 */
internal object SubmittedCaptures {
    private val sent = Collections.newSetFromMap(WeakHashMap<FrozenReportCapture, Boolean>())

    fun add(capture: FrozenReportCapture) { synchronized(sent) { sent.add(capture) } }
    operator fun contains(capture: FrozenReportCapture): Boolean = synchronized(sent) { capture in sent }
}
