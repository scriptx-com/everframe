// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Process ownership is independent of RN module instances. State is main-only. */
internal object ReporterInstallation {
    private val state = ReporterInstallationState()

    fun schedule(context: Context) {
        val app = context.applicationContext as? Application ?: return
        if (Looper.myLooper() == Looper.getMainLooper()) ensureInstalled(app)
        else Handler(Looper.getMainLooper()).post {
            try { ensureInstalled(app) }
            catch (_: Exception) {
                // A later awaited open retries and reports the failure to its caller.
                Log.w("Everframe.reporter", "Reporter initialization failed; opening will retry")
            }
        }
    }

    fun ensureInstalled(application: Application) = state.ensureInstalled(application)
}

internal class ReporterInstallationState(
    private val installCompanion: () -> Unit = { CompanionPinPresenter.install() },
) {
    private var registeredApplication: Application? = null
    private val activitySupplier = { ActivityRegistry.activeActivity() }
    private val resolver: suspend () -> ReportResult = {
        withContext(Dispatchers.Main.immediate) {
            val activity = ActivityRegistry.activeActivity()
            if (activity == null) ReportResult.Cancelled("no_active_activity")
            else TXReporterPresenter().openReporter(activity) { ActivityRegistry.isCurrent(activity) }
        }
    }

    fun ensureInstalled(application: Application) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Reporter installation requires main thread" }
        check(registeredApplication == null || registeredApplication === application) { "Reporter application mismatch" }
        if (registeredApplication == null) {
            application.registerActivityLifecycleCallbacks(ActivityRegistry)
            registeredApplication = application
        }
        // An earlier successful registration survives a later failed step.
        installCompanion()
        // Publish readiness last, and never replace callbacks owned by another host.
        if (Everframe.__activitySupplier == null) Everframe.__activitySupplier = activitySupplier
        if (Everframe.report.__resolver == null) Everframe.report.__resolver = resolver
    }
}
