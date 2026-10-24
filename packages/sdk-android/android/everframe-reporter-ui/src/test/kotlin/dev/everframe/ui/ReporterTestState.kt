// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Application
import dev.everframe.Everframe

/** Robolectric replaces Application between tests, but Kotlin process objects persist. */
internal fun resetReporterTestState() {
    val state = ReporterInstallation::class.java.getDeclaredField("state").apply { isAccessible = true }.get(null)
    val field = ReporterInstallationState::class.java.getDeclaredField("registeredApplication").apply { isAccessible = true }
    (field.get(state) as? Application)?.unregisterActivityLifecycleCallbacks(ActivityRegistry)
    field.set(state, null)
    ActivityRegistry.activeActivity()?.let { ActivityRegistry.onActivityPaused(it) }
    Everframe.report.__resolver = null
    Everframe.__activitySupplier = null
    TXReporterPresenter.__resetSingleFlightForTesting()
}
