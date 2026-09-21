// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReporterResolverInstaller — androidx.startup `Initializer` that wires
// `TraceItX.report.__resolver` so `report.open()` resolves through
// `:reporter-ui`'s `TXReporterPresenter` against the currently-resumed Activity
// (tracked by `ActivityRegistry`).
//
// Trigger detection is host-app responsibility (D-01); this installer owns
// only resolver wiring + Activity tracking.
package com.traceitx.ui

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import androidx.startup.Initializer
import com.traceitx.TraceItX

/**
 * Tracks the currently-resumed Activity so `report.open()` can route to a
 * concrete host without the customer passing one in.
 */
internal object ActivityRegistry : Application.ActivityLifecycleCallbacks {
    @Volatile
    private var current: Activity? = null

    fun activeActivity(): Activity? = current

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) {
        current = activity
        // Re-present a held attach-PIN challenge (spec 2026-08-19) — see
        // CompanionPinPresenter's own doc for why this is gated on the
        // flow's CURRENT value rather than replaying whatever landed while
        // backgrounded.
        CompanionPinPresenter.onActivityResumed()
    }
    override fun onActivityPaused(activity: Activity) {
        if (current === activity) {
            current = null
            // Dialog-vs-Activity-death guard: an AlertDialog leaks if its
            // Activity finishes underneath it. The challenge stays in the
            // flow; the next resume re-presents it.
            CompanionPinPresenter.onActivityGone()
        }
    }
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {
        if (current === activity) {
            current = null
            CompanionPinPresenter.onActivityGone()
        }
    }
}

class ReporterResolverInstaller : Initializer<Unit> {

    override fun create(context: Context) {
        val app = context.applicationContext as? Application ?: return

        // Activity tracking — installed eagerly because the cost is ~zero
        // until report.open() is actually called.
        app.registerActivityLifecycleCallbacks(ActivityRegistry)

        // Session-replay (VTREE-03): expose the foreground Activity to the
        // :traceitx-core ReplaySession walk via the __activitySupplier seam —
        // the same registry the reporter resolver uses — so core can resolve the
        // Activity to walk without a :core → :reporter-ui dep cycle.
        TraceItX.__activitySupplier = { ActivityRegistry.activeActivity() }

        // report.open() resolver — wraps presenter.openReporter for the
        // currently-resumed Activity.
        TraceItX.report.__resolver = resolver@ {
            val activity = ActivityRegistry.activeActivity()
                ?: return@resolver com.traceitx.config.ReportResult.Cancelled("no_active_activity")
            TXReporterPresenter().openReporter(activity)
        }

        // Built-in attach-PIN dialog (spec 2026-08-19). Unconditional — the
        // per-announce `supportsAttachPin` capability and any RN-bridge
        // suppression are runtime checks (TraceItX.__attachPinUiInstalled /
        // __attachPinUiSuppressed), not an install-site gate.
        CompanionPinPresenter.install()
    }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
