// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.app.Application
import dev.everframe.Everframe
import kotlinx.coroutines.Job

/** Robolectric changes Application between tests; reporter process objects survive. */
internal fun resetBridgeReporterState() {
    val installation = Class.forName("dev.everframe.ui.ReporterInstallation")
    val state = installation.getDeclaredField("state").apply { isAccessible = true }.get(null)
    val application = state.javaClass.getDeclaredField("registeredApplication").apply { isAccessible = true }
    val registry = Class.forName("dev.everframe.ui.ActivityRegistry").getField("INSTANCE").get(null)
    (application.get(state) as? Application)?.unregisterActivityLifecycleCallbacks(registry as Application.ActivityLifecycleCallbacks)
    application.set(state, null)
    registry.javaClass.getDeclaredField("current").apply { isAccessible = true }
        .set(null, java.lang.ref.WeakReference<android.app.Activity>(null))
    val presenter = Class.forName("dev.everframe.ui.CompanionPinPresenter")
    val collector = presenter.getDeclaredField("collector").apply { isAccessible = true }
    (collector.get(null) as? Job)?.cancel()
    collector.set(null, null)
    Everframe.report.__resolver = null
    Everframe.__activitySupplier = null
    Everframe.__attachPinUiInstalled = false
}
