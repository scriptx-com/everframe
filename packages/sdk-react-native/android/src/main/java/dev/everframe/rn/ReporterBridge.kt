// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Reflection preserves compatibility with separately built native reporter artifacts. */
internal class ReporterBridge(
    private val resolveInstaller: () -> Class<*> = { Class.forName("dev.everframe.ui.ReporterResolverInstaller") },
) {
    fun scheduleInstall(context: Context) {
        val application = context.applicationContext
        val install = Runnable {
            try {
                val type = installerType()
                invoke(type.getMethod("create", Context::class.java), type.getDeclaredConstructor().newInstance(), application)
            } catch (_: Throwable) {
                Log.w("Everframe.rn", "Reporter initialization deferred; opening will retry")
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) install.run()
        else Handler(Looper.getMainLooper()).post(install)
    }

    suspend fun open(context: ReactApplicationContext): ReportResult = withContext(Dispatchers.Main.immediate) {
        val activity = context.currentActivity
        if (context.lifecycleState != LifecycleState.RESUMED || activity == null ||
            activity.isFinishing || activity.isDestroyed || activity.application !== context.applicationContext) {
            return@withContext ReportResult.Cancelled("no_active_activity")
        }
        try {
            val type = installerType()
            val instance = type.getDeclaredConstructor().newInstance()
            val method = try {
                type.getMethod("openForActivity", Context::class.java, Activity::class.java, Continuation::class.java)
            } catch (_: NoSuchMethodException) { null }
            if (method == null) {
                // Absence is the only legacy fallback. A present method's failure is final.
                invoke(type.getMethod("create", Context::class.java), instance, context.applicationContext)
                Everframe.report.open()
            } else {
                suspendCoroutineUninterceptedOrReturn<ReportResult> { continuation ->
                    invoke(method, instance, context.applicationContext, activity, continuation)
                }
            }
        } catch (failure: Throwable) {
            when (failure) {
                is CancellationException -> throw failure
                is ReporterBridgeFailure -> throw failure
                is NoSuchMethodException -> throw ReporterBridgeFailure("Reporter UI is incompatible; update the native reporter dependency")
                else -> throw ReporterBridgeFailure("Reporter initialization or opening failed")
            }
        }
    }

    private fun installerType(): Class<*> = try { resolveInstaller() }
    catch (_: ClassNotFoundException) {
        throw ReporterBridgeFailure("Reporter UI dependency is missing; add dev.everframe:reporter-ui")
    }

    private fun invoke(method: Method, instance: Any, vararg arguments: Any?): Any? =
        try { method.invoke(instance, *arguments) }
        catch (failure: InvocationTargetException) { throw failure.targetException }

    // No host exception/cause is forwarded to JS or diagnostic logs.
    private class ReporterBridgeFailure(message: String) : IllegalStateException(message)
}
