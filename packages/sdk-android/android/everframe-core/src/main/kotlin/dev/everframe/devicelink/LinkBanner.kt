// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The matching-number banner shown while a link attempt is pending:
// "Linking to Everframe · 47" over "A teammate is linking a device. If that's
// not you, ignore this."
//
// WINDOW. A `TYPE_APPLICATION_PANEL` sub-window bound to the foreground
// Activity's window token, `FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCHABLE`, so it
// never takes keys or touches and needs no permission. Being its own window
// keeps it out of `PixelCopy` screenshots and the sensitive-view walk, both of
// which read only the Activity's window. The same mechanics as the Companion
// name badge, without depending on Companion code.
//
// LIFECYCLE. Re-attached on `onActivityResumed`, detached on
// `onActivityPaused`/`onActivityDestroyed` (before `WindowManagerGlobal` would
// force-remove it and log a leaked window). All window work runs on the main
// thread; every failure is swallowed so the banner can never crash the host.

package dev.everframe.devicelink

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import dev.everframe.Everframe
import java.lang.ref.WeakReference

internal object LinkBanner {
    /** The number on screen (or waiting for an Activity to resume), else null. Test seam. */
    @Volatile
    var visibleNumber: Int? = null
        private set

    /** Resolves the foreground Activity; falls back to the last one this class saw resume. */
    @Volatile
    internal var activityProvider: () -> Activity? = { Everframe.__activitySupplier?.invoke() }

    private val main = Handler(Looper.getMainLooper())
    private var registeredApp: Application? = null
    private var lastResumed: WeakReference<Activity>? = null
    private var attached: View? = null
    private var host: Activity? = null

    /** Test seam: the label's text while attached to an Activity window. */
    internal val attachedText: CharSequence? get() = (attached as? TextView)?.text

    private val callbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityResumed(activity: Activity) {
            lastResumed = WeakReference(activity)
            visibleNumber?.let { attach(activity, it) }
        }

        override fun onActivityPaused(activity: Activity) {
            if (host === activity) detach()
        }

        override fun onActivityDestroyed(activity: Activity) {
            if (host === activity) detach()
            if (lastResumed?.get() === activity) lastResumed = null
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    }

    /** Registers the lifecycle callbacks once per Application. */
    fun install(context: Context) {
        onMain {
            val app = context.applicationContext as? Application ?: return@onMain
            if (registeredApp === app) return@onMain
            registeredApp?.let { old -> runCatching { old.unregisterActivityLifecycleCallbacks(callbacks) } }
            registeredApp = null
            runCatching { app.registerActivityLifecycleCallbacks(callbacks) }.onSuccess { registeredApp = app }
        }
    }

    fun show(number: Int) {
        visibleNumber = number
        onMain {
            val activity = runCatching { activityProvider() }.getOrNull() ?: lastResumed?.get()
            if (activity != null) attach(activity, number)
        }
    }

    fun hide() {
        visibleNumber = null
        onMain { detach() }
    }

    private fun attach(activity: Activity, number: Int) {
        if (activity.isFinishing || activity.isDestroyed) return
        if (host === activity && attached != null) {
            (attached as? TextView)?.let { it.text = label(number); it.contentDescription = it.text }
            return
        }
        detach()
        val decor = activity.window?.decorView ?: return
        if (decor.windowToken == null) {
            // First resume: the decor view is not attached to a window yet.
            decor.post { if (visibleNumber == number && attached == null) attach(activity, number) }
            return
        }
        try {
            val view = buildLabel(activity, number)
            activity.windowManager.addView(view, buildParams(activity, decor))
            attached = view
            host = activity
        } catch (_: Throwable) {
            // Never let the banner crash the host app.
        }
    }

    private fun detach() {
        val view = attached ?: return
        val activity = host
        attached = null
        host = null
        try {
            activity?.windowManager?.removeViewImmediate(view)
        } catch (_: Throwable) {
        }
    }

    private fun label(number: Int): CharSequence {
        val title = DeviceLinkCopy.bannerTitle(number)
        return SpannableStringBuilder().apply {
            append(title)
            setSpan(StyleSpan(Typeface.BOLD), 0, title.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            append("\n")
            val start = length
            append(DeviceLinkCopy.BANNER_SUBLINE)
            setSpan(RelativeSizeSpan(0.85f), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    private fun buildLabel(activity: Activity, number: Int): TextView = TextView(activity).apply {
        text = label(number)
        contentDescription = text
        isClickable = false
        isFocusable = false
        setTextColor(Color.WHITE)
        textSize = 14f
        gravity = Gravity.CENTER_HORIZONTAL
        background = GradientDrawable().apply {
            setColor(Color.argb(217, 0, 0, 0))
            cornerRadius = dp(activity, 12).toFloat()
        }
        val h = dp(activity, 16)
        val v = dp(activity, 10)
        setPadding(h, v, h, v)
    }

    private fun buildParams(activity: Activity, decor: View): WindowManager.LayoutParams =
        WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            token = decor.windowToken
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            // Clear of the status bar on phones and of overscan on TVs.
            y = dp(activity, 32)
        }

    private fun dp(activity: Activity, value: Int): Int = (value * activity.resources.displayMetrics.density).toInt()

    private fun onMain(block: () -> Unit) {
        val guarded = { runCatching(block); Unit }
        if (Looper.myLooper() == Looper.getMainLooper()) guarded() else main.post(guarded)
    }

    /** Tests only. */
    internal fun __resetForTesting() {
        visibleNumber = null
        onMain {
            detach()
            lastResumed = null
        }
        activityProvider = { Everframe.__activitySupplier?.invoke() }
    }
}
