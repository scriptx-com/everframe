// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import androidx.annotation.RequiresApi
import androidx.annotation.VisibleForTesting
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.capture.DeviceMetadata
import dev.everframe.config.IngestEndpoint
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.envelope.txGuardVoid
import dev.everframe.outbox.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.launch

internal object AndroidNativeCrashRuntime {
    private val lock = Any()
    @Volatile private var requests = AndroidNativeRecoveryRequests()
    fun noteKill() { requests.invalidate() }
    fun request(epoch: Int, enabled: Boolean, diagnostics: Boolean = false): Long =
        requests.request(epoch, enabled, diagnostics)
    fun diagnosticsReady(epoch: Int): Boolean = requests.diagnosticsEnabled(epoch) && ready(epoch)
    fun ready(epoch: Int): Boolean = requests.enabled(epoch) && synchronized(lock) { controller }?.ready(epoch) == true
    // Volatile: the JVM crash handler reads it without the lock (noteJvmFatal).
    @Volatile private var controller: AndroidNativeRecoveryController? = null
    private var eraseWhenContextAvailable = false

    /**
     * The JVM uncaught-exception handler admitted this process's fatal crash; a low-memory kill that
     * ends the process now is the same death and must not become a second issue. Never blocks.
     */
    fun noteJvmFatal() { runCatching { controller?.markJvmFatal() } }

    /** Lifecycle clear is independent of durable context replacement. */
    fun invalidateExposure() { controller?.invalidateExposure() }
    fun refreshExposure(epoch: Int) { controller?.refreshExposure(epoch) }

    /** Test seam replacing the ActivityManager/Keystore-backed owner. Never set in production. */
    @VisibleForTesting
    internal var __controllerFactoryForTesting: ((Context) -> AndroidNativeRecoveryController)? = null

    /** Simulates process death: in-memory ownership and commands are lost, durable journals remain. */
    @VisibleForTesting
    internal fun __resetForTesting() {
        synchronized(lock) { controller = null; eraseWhenContextAvailable = false }
        requests = AndroidNativeRecoveryRequests()
    }

    private fun controller(context: Context): AndroidNativeRecoveryController = synchronized(lock) {
        controller ?: __controllerFactoryForTesting?.invoke(context)?.also { controller = it } ?: AndroidNativeRecoveryController({
            val root = File(context.noBackupFilesDir, "dev.everframe/native-exit-v1")
            fun store(name: String) = OutboxStore(File(root, name),
                AndroidOutboxKeyProvider("dev.everframe.native-exit.v1.$name"), AndroidOutboxFileOps(),
                maxEntries = 8, maxTotalBytes = 2L * 1024 * 1024)
            AndroidNativeRecovery(store("contexts"), store("prepared"))
        }, AndroidExitPlatform(context.applicationContext),
            exposure = dev.everframe.health.ReleaseHealthRuntime::readyPointer,
            signalCapture = { AndroidNativeSignalRuntime.capture(context, it) }).also { controller = it }
    }

    /** Off-main caller. While capture.crash is on, the SDK owns this process's state summary. */
    fun enable(context: Context, captured: TXCapturedSession, outbox: JSONLOutbox, request: Long, diagnostics: Boolean = false): Boolean {
        if (Build.VERSION.SDK_INT < (if (diagnostics) 30 else 31) || !captured.captureConsent ||
            captured.config?.capture?.crash != true || !AppProcess.isDefault(context)) return false
        val epoch = captured.user.startEpoch
        val gate = object : OutboxAuthorization {
            override fun isAllowed() = Everframe.captureGate && Everframe.currentStartEpochVolatile() == epoch && requests.allows(request, epoch, true)
        }
        val owner = controller(context)
        if (!requests.finishRevocation {
            if (!gate.isAllowed()) false else {
                owner.retire(epoch, true) { gate.isAllowed() }
                gate.isAllowed()
            }
        }) return false
        val erase = synchronized(lock) { eraseWhenContextAvailable.also { eraseWhenContextAvailable = false } }
        if (erase) owner.retire(epoch, true) { gate.isAllowed() }
        val template = {
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
            OutboxEntry(encoded.envelope.reportID, System.currentTimeMillis(), encoded.bytes, encoded.idempotencyKey,
                emptyList(), captured.config.sdkKey, IngestEndpoint.url, identitySubject = null)
        }
        val admit: (OutboxEntry) -> Boolean = { entry ->
            try { outbox.store.enqueueSync(entry, gate); true } catch (_: Exception) { false }
        }
        val appId = captured.config.appId
        return if (diagnostics) owner.enableDiagnostics(epoch, gate, System.currentTimeMillis(), template, appId, admit)
            else owner.enable(epoch, gate, System.currentTimeMillis(), template, appId, admit)
    }

    /** Outside SDK stateLock. Pending OS reads cannot block this transition. */
    fun boundary(context: Context?, epoch: Int, erasePersisted: Boolean, isCurrent: () -> Boolean, request: Long? = null) {
        if (Build.VERSION.SDK_INT < 30 || !isCurrent()) return
        // Journals are shared by every process of the app; only the default process owns them. The
        // check reads /proc before API 28, so a replacement start makes it only where it could touch
        // the journals instead of on the caller's thread every time.
        val defaultProcess by lazy(LazyThreadSafetyMode.NONE) { context == null || AppProcess.isDefault(context) }
        if (erasePersisted && !defaultProcess) return
        val command = request ?: requests.boundary(epoch)
        val owns = { isCurrent() && requests.allows(command, epoch, false) }
        if (!owns()) return
        if (context != null && !requests.finishRevocation {
            if (!owns()) false else if (!defaultProcess) true else {
                val existing = synchronized(lock) { controller }
                val owner = existing ?: if (File(context.noBackupFilesDir, "dev.everframe/native-exit-v1").exists()) controller(context) else null
                owner?.retire(epoch, true, owns)
                owns()
            }
        }) return
        val prior = synchronized(lock) {
            if (erasePersisted && context == null) eraseWhenContextAvailable = true
            controller
        }
        if (!erasePersisted) {
            // Replacement start: clear the OS token now, without the controller lock an in-flight
            // arm holds across IO, so a crash from here on is never attributed to the old start.
            // Dropping the old owner's own context is journal IO and runs off the caller's thread.
            prior ?: return
            prior.invalidateExposure()
            Everframe.sdkScope.launch { txGuardVoid("nativeCrash.retire") { prior.retire(epoch, false, owns) } }
            return
        }
        val owner = prior ?: if (context != null &&
            File(context.noBackupFilesDir, "dev.everframe/native-exit-v1").exists()) controller(context) else null
        owner?.retire(epoch, true, owns)
    }
}

@RequiresApi(30)
private class AndroidExitPlatform(private val context: Context) : AndroidNativeExitPlatform {
    override val apiLevel: Int get() = Build.VERSION.SDK_INT
    override val pid: Int get() = Process.myPid()
    override val processName: String get() = Application.getProcessName()
    private val manager get() = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    override fun setStateSummary(value: ByteArray?) { manager.setProcessStateSummary(value) }
    override fun history(): List<AndroidNativeExit> = manager.getHistoricalProcessExitReasons(context.packageName, 0, 32)
        .take(32).map { exit -> AndroidNativeExit(exit.pid, exit.processName, exit.timestamp, exit.reason,
            exit.processStateSummary?.takeIf { it.size <= 128 }?.copyOf(), { exit.traceInputStream }, exit.status,
            exit.importance, exit.pss, exit.rss, exit.description) }
}
