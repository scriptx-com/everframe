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
import dev.everframe.outbox.*
import java.io.File
import java.util.UUID

internal object AndroidNativeCrashRuntime {
    private val lock = Any()
    @Volatile private var requests = AndroidNativeRecoveryRequests()
    fun noteKill() { requests.invalidate() }
    fun request(epoch: Int, enabled: Boolean, diagnostics: Boolean = false, supported: Boolean = true): Long =
        requests.request(epoch, enabled, diagnostics, supported)
    fun diagnosticsReady(epoch: Int): Boolean = requests.diagnosticsEnabled(epoch) && ready(epoch)
    fun ready(epoch: Int): Boolean = requests.enabled(epoch) && synchronized(lock) { controller }?.ready(epoch) == true
    private var controller: AndroidNativeRecoveryController? = null
    private var eraseWhenContextAvailable = false

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
        }, AndroidExitPlatform(context.applicationContext)).also { controller = it }
    }

    /** Off-main caller. Defaults to no state-summary ownership until explicitly requested by the host. */
    fun enable(context: Context, captured: TXCapturedSession, outbox: JSONLOutbox, request: Long, diagnostics: Boolean = false): Boolean {
        if (Build.VERSION.SDK_INT < (if (diagnostics) 30 else 31) || !captured.captureConsent || captured.config?.capture?.crash != true) return false
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
        return if (diagnostics) owner.enableDiagnostics(epoch, gate, System.currentTimeMillis(), template, admit)
            else owner.enable(epoch, gate, System.currentTimeMillis(), template, admit)
    }

    /** Outside SDK stateLock. Pending OS reads cannot block this transition. */
    fun boundary(context: Context?, epoch: Int, erasePersisted: Boolean, isCurrent: () -> Boolean, request: Long? = null) {
        if (Build.VERSION.SDK_INT < 30 || !isCurrent()) return
        val command = request ?: requests.boundary(epoch)
        val owns = { isCurrent() && requests.allows(command, epoch, false) }
        if (!owns()) return
        if (context != null && !requests.finishRevocation {
            if (!owns()) false else {
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
        val owner = prior ?: if (erasePersisted && context != null &&
            File(context.noBackupFilesDir, "dev.everframe/native-exit-v1").exists()) controller(context) else null
        owner?.retire(epoch, erasePersisted, owns)
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
            exit.processStateSummary?.takeIf { it.size <= 128 }?.copyOf(), { exit.traceInputStream }, exit.status) }
}
