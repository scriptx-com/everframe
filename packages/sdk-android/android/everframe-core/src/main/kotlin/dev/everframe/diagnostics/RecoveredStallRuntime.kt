// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.capture.DeviceMetadata
import dev.everframe.config.IngestEndpoint
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal object RecoveredStallRuntime {
    private val owner = RecoveredStallOwner()
    private val budget = RecoveredStallBudget()
    // start reserves an epoch before customer teardown, then publishes its config.
    // An opt-in in that gap must not bind the old key to the newly reserved epoch.
    private val publishedEpoch = AtomicInteger(-1)
    fun request(epoch: Int, enabled: Boolean): Long = owner.request(epoch, enabled && publishedEpoch.get() == epoch)
    fun boundary() { publishedEpoch.set(-1); owner.invalidate() }
    fun startPublished(epoch: Int) { publishedEpoch.set(epoch) }
    fun ready(epoch: Int): Boolean = publishedEpoch.get() == epoch && owner.ready(epoch)

    /** Called off main, before the probe timer exists. No identity/session is captured. */
    fun enable(context: Context, captured: TXCapturedSession, outbox: JSONLOutbox, request: Long): Boolean {
        val config = captured.config ?: return false
        if (Build.VERSION.SDK_INT < 26 || !captured.captureConsent || !config.capture.crash) return false
        val epoch = captured.user.startEpoch
        return owner.enable(request, epoch, {
            publishedEpoch.get() == epoch && Everframe.captureGate && Everframe.currentStartEpochVolatile() == epoch
        }) { allowed ->
            val device = DeviceMetadata.collect(context)
            val encoded = EnvelopeBuilder(vitalsStamp = { null }).buildEncoded(
                reportId = UUID.randomUUID(), sdkVersion = Everframe.SDK_VERSION,
                formFactor = DeviceMetadata.formFactor(device), appName = context.packageName,
                appVersion = device["appVersion"] as? String ?: "0.0.0",
                appBuild = device["appBuild"]?.toString(), deviceModel = device["model"] as? String,
                deviceOsVersion = device["osVersion"] as? String ?: "unknown",
                deviceScreenWidth = (device["screenWidthDp"] as? Int)?.toDouble() ?: 0.0,
                deviceScreenHeight = (device["screenHeightDp"] as? Int)?.toDouble() ?: 0.0,
            )
            val template = OutboxEntry(encoded.envelope.reportID, System.currentTimeMillis(), encoded.bytes,
                encoded.idempotencyKey, emptyList(), config.sdkKey, IngestEndpoint.url, identitySubject = null)
            val platformEligible = {
                runCatching {
                    val process = ActivityManager.RunningAppProcessInfo()
                    ActivityManager.getMyMemoryState(process)
                    stallEligible(true, process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND,
                        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive,
                        Debug.isDebuggerConnected(), Debug.waitingForDebugger())
                }.getOrDefault(false)
            }
            lateinit var session: AndroidRecoveredStallSession
            session = AndroidRecoveredStallSession(Handler(Looper.getMainLooper()), { ProcessLifecycleOwner.get() },
                ScheduledStallTicker(), { StallClockSample(SystemClock.uptimeMillis(), SystemClock.elapsedRealtime(), System.currentTimeMillis()) },
                allowed, platformEligible, budget) { observation ->
                val authorization = object : OutboxAuthorization {
                    override fun isAllowed() = session.eligible()
                }
                try {
                    outbox.store.enqueueSync(recoveredStallEntry(template, observation, Build.VERSION.SDK_INT), authorization)
                    Everframe.requestOutboxDrain()
                    true
                } catch (_: Exception) { false }
            }
            session
        }
    }
}

internal interface StallTicker {
    fun start(action: () -> Unit)
    fun stop()
    fun close()
}

private class ScheduledStallTicker : StallTicker {
    private val executor = Executors.newSingleThreadScheduledExecutor { action ->
        Thread(action, "Everframe-main-probe").apply { isDaemon = true }
    }
    private var pending: ScheduledFuture<*>? = null
    @Synchronized override fun start(action: () -> Unit) {
        if (!executor.isShutdown && pending == null) pending = executor.scheduleWithFixedDelay(
            { runCatching(action) }, 0, 1_000, TimeUnit.MILLISECONDS)
    }
    @Synchronized override fun stop() { pending?.cancel(false); pending = null }
    @Synchronized override fun close() { stop(); executor.shutdown() }
}

/** Main only installs/removes lifecycle callbacks and acknowledges probes. */
internal class AndroidRecoveredStallSession(
    private val main: Handler,
    private val owner: () -> LifecycleOwner,
    private val ticker: StallTicker,
    private val clock: () -> StallClockSample,
    private val allowed: () -> Boolean,
    private val platformEligible: () -> Boolean,
    budget: RecoveredStallBudget,
    admit: (RecoveredStallObservation) -> Boolean,
) : RecoveredStallSession, DefaultLifecycleObserver {
    private val closed = AtomicBoolean(false)
    private val installed = AtomicBoolean(false)
    private val foreground = AtomicBoolean(false)
    private val probes = mutableMapOf<Long, Runnable>()
    private var lifecycle: Lifecycle? = null // main-thread confined
    private val observer = RecoveredStallObserver(budget, ::postProbe, ::removeProbe) {
        if (eligible()) admit(it) else false
    }
    override val ready: Boolean get() = installed.get() && !closed.get() && allowed()
    fun eligible(): Boolean = !closed.get() && foreground.get() && allowed() &&
        runCatching(platformEligible).getOrDefault(false)

    override fun start() {
        main.post {
            if (closed.get() || !allowed() || !installed.compareAndSet(false, true)) return@post
            lifecycle = owner().lifecycle
            lifecycle?.addObserver(this)
            if (lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) != true) onStop(owner())
            // close can win while addObserver synchronously replays lifecycle events.
            if (closed.get() || !allowed()) close()
        }
    }
    override fun onStart(owner: LifecycleOwner) {
        if (closed.get() || !allowed()) return
        foreground.set(true)
        ticker.start { observer.tick(clock(), eligible()) }
        if (closed.get() || !allowed()) { foreground.set(false); ticker.stop(); observer.invalidate() }
    }
    override fun onStop(owner: LifecycleOwner) {
        foreground.set(false); ticker.stop(); observer.invalidate()
    }
    override fun close() {
        closed.set(true); foreground.set(false)
        ticker.close(); observer.invalidate()
        main.post {
            if (installed.compareAndSet(true, false)) lifecycle?.removeObserver(this)
            lifecycle = null
        }
    }
    private fun postProbe(id: Long): Boolean = synchronized(probes) {
        if (!eligible()) return false
        val callback = Runnable {
            synchronized(probes) { probes.remove(id) }
            observer.acknowledge(id, clock())
        }
        probes[id] = callback
        main.post(callback).also { if (!it) probes.remove(id) }
    }
    private fun removeProbe(id: Long) = synchronized(probes) {
        probes.remove(id)?.let { main.removeCallbacks(it) }
        Unit
    }
}
