// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.app.Application
import android.content.Context
import androidx.startup.Initializer
import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** AndroidX Startup calls create(Context); the React Native bridge opens through openForActivity. */
class ReporterResolverInstaller : Initializer<Unit> {
    override fun create(context: Context) = ReporterInstallation.schedule(context)

    /** Bridge entry: select the already-resumed host before opening. */
    suspend fun openForActivity(context: Context, activity: Activity?): ReportResult =
        withContext(Dispatchers.Main.immediate) {
            val app = context.applicationContext as? Application
                ?: return@withContext ReportResult.Cancelled("no_active_activity")
            ReporterInstallation.ensureInstalled(app)
            if (!ActivityRegistry.seed(app, activity)) {
                return@withContext ReportResult.Cancelled("no_active_activity")
            }
            // Respect a successor resolver; installation never takes ownership back.
            Everframe.report.open()
        }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
