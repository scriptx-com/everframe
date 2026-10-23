// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.app.Application
import android.os.Bundle

internal object ActivityRegistry : Application.ActivityLifecycleCallbacks {
    @Volatile private var current = java.lang.ref.WeakReference<Activity>(null)

    fun activeActivity(): Activity? = current.get()?.takeUnless { it.isFinishing || it.isDestroyed }

    fun isCurrent(activity: Activity): Boolean = activeActivity() === activity

    fun seed(application: Application, activity: Activity?): Boolean {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        if (activity == null || activity.application !== application || activity.isFinishing || activity.isDestroyed) return false
        if (current.get() !== activity) onActivityResumed(activity)
        return true
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityResumed(activity: Activity) {
        current = java.lang.ref.WeakReference(activity)
    }
    override fun onActivityPaused(activity: Activity) {
        if (current.get() === activity) current.clear()
    }
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {
        if (current.get() === activity) current.clear()
    }
}
