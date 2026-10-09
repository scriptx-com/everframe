// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.annotation.VisibleForTesting
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.capture.DeviceMetadata
import dev.everframe.config.IngestEndpoint
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.envelope.txGuardVoid
import dev.everframe.outbox.*
import kotlinx.coroutines.*
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Optional API26..30 path; API31+ keeps the OS-native recovery implementation. */
internal object AndroidNativeSignalRuntime {
    private val revision = AtomicLong()
    private val erasePending = AtomicBoolean()
    private val work = Any()
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var controller: AndroidNativeSignalController? = null
    @Volatile private var files: AndroidNativeSignalFiles? = null

    /** Test seams replacing Keystore keys, Os file operations and the optional module. Never set in production. */
    @VisibleForTesting internal var __keysForTesting: OutboxKeyProvider? = null
    @VisibleForTesting internal var __fileOpsForTesting: OutboxFileOps? = null
    @VisibleForTesting internal var __producerForTesting: AndroidNativeSignalProducer? = null

    /** Simulates process death: in-memory ownership and the erase obligation are lost, durable files remain. */
    @VisibleForTesting
    internal fun __resetForTesting() { synchronized(work) { controller = null; files = null; erasePending.set(false) } }

    /** The process owner exactly as an opt-in or an erase creates it. */
    @VisibleForTesting @androidx.annotation.RequiresApi(26)
    internal fun __ownerForTesting(context: Context): AndroidNativeSignalController = synchronized(work) { owner(context) }

    /** Atomic/native-only fence, safe under the SDK stateLock. */
    fun request(erase: Boolean = false): Long {
        if (erase) erasePending.set(true)
        val command = revision.incrementAndGet()
        controller?.request(erase)
        return command
    }
    fun ready(epoch: Int) = !erasePending.get() && controller?.ready(epoch) == true
    private fun mainProcess(context: Context): Boolean {
        val name = if (Build.VERSION.SDK_INT >= 28) Application.getProcessName()
            else File("/proc/self/cmdline").inputStream().use { input ->
                val bytes = ByteArray(256); val size = input.read(bytes)
                if (size <= 0) "" else bytes.copyOfRange(0, size).takeWhile { it != 0.toByte() }.toByteArray().toString(Charsets.UTF_8)
            }
        return name == context.packageName
    }
    private fun fileOps(): OutboxFileOps = __fileOpsForTesting ?: AndroidOutboxFileOps()
    @androidx.annotation.RequiresApi(26)
    private fun engine(storage: AndroidNativeSignalFiles): AndroidNativeRecordImport {
        fun store(name: String) = OutboxStore(File(storage.root, name),
            __keysForTesting ?: AndroidOutboxKeyProvider("dev.everframe.native-signal.v1.$name"), fileOps(), 8, 2L*1024*1024)
        return AndroidNativeRecordImport(store("capsules"), store("prepared"))
    }
    @androidx.annotation.RequiresApi(26)
    private fun owner(context: Context): AndroidNativeSignalController {
        controller?.let { return it }
        val storage = AndroidNativeSignalFiles(context.noBackupFilesDir, fileOps())
        val producer = __producerForTesting ?: OptionalProducer(context, storage)
        return AndroidNativeSignalController({ engine(storage) }, producer, storage::read, cleanup = storage::cleanup).also {
            files = storage; controller = it
        }
    }
    fun enable(context: Context, captured: TXCapturedSession, outbox: JSONLOutbox, command: Long): Boolean = synchronized(work) {
        if (Build.VERSION.SDK_INT !in 26..30 || !mainProcess(context)) return@synchronized false
        val epoch = captured.user.startEpoch
        val gate = object : OutboxAuthorization {
            override fun isAllowed() = revision.get() == command && !erasePending.get() && Everframe.captureGate &&
                Everframe.currentStartEpochVolatile() == epoch && captured.captureConsent && captured.config?.capture?.crash == true
        }
        if (revision.get() != command || !captured.captureConsent || captured.config?.capture?.crash != true) return@synchronized false
        val owner = owner(context)
        if (!finishErase(context) || !gate.isAllowed()) return@synchronized false
        val localCommand = owner.request()
        owner.enable(localCommand, epoch, gate, {
            val device = DeviceMetadata.collect(context)
            val encoded = EnvelopeBuilder(vitalsStamp = { null }).buildEncoded(
                reportId = UUID.randomUUID(), sdkVersion = Everframe.SDK_VERSION,
                formFactor = DeviceMetadata.formFactor(device), appName = context.packageName,
                appVersion = device["appVersion"] as? String ?: "0.0.0",
                appBuild = device["appBuild"]?.toString(), deviceModel = device["model"] as? String,
                deviceOsVersion = device["osVersion"] as? String ?: "unknown",
                deviceScreenWidth = (device["screenWidthDp"] as? Int)?.toDouble() ?: 0.0,
                deviceScreenHeight = (device["screenHeightDp"] as? Int)?.toDouble() ?: 0.0)
            OutboxEntry(encoded.envelope.reportID, System.currentTimeMillis(), encoded.bytes, encoded.idempotencyKey,
                emptyList(), captured.config.sdkKey, IngestEndpoint.url, identitySubject = null)
        }) { entry, admission ->
            try { outbox.store.enqueueSync(entry, admission); true } catch (_: Exception) { false }
        }
    }
    /** Outside stateLock. Erasure is durable before an explicit disable/kill returns. */
    fun finishErase(context: Context?): Boolean = synchronized(work) {
        if (!erasePending.get()) return@synchronized true
        if (context == null) return@synchronized false
        // A secondary process must never erase the default process's collector.
        if (Build.VERSION.SDK_INT < 26 || !mainProcess(context)) {
            erasePending.set(false); return@synchronized true
        }
        if (controller == null && !File(context.noBackupFilesDir, "dev.everframe/native-signal-v1").exists()) {
            erasePending.set(false); return@synchronized true
        }
        while (erasePending.getAndSet(false)) {
            val owner = owner(context)
            owner.request(erase = true)
            if (!owner.finishRevocation()) { erasePending.set(true); return@synchronized false }
            files?.cleanup(emptySet())
        }
        true
    }
    /** Replacement start pauses synchronously, then retires only this process's context on IO. */
    fun retireAfterStart(command: Long): Job? {
        if (controller == null) return null
        return cleanupScope.launch {
            // Keystore or storage failure keeps the paused owner for a later enable or erase;
            // it must never reach the host's uncaught-exception handler.
            txGuardVoid("nativeSignal.retire") {
                synchronized(work) {
                    if (revision.get() == command) controller?.retireCurrent()
                }
            }
        }
    }

    @androidx.annotation.RequiresApi(26)
    private class OptionalProducer(private val context: Context, private val files: AndroidNativeSignalFiles) : AndroidNativeSignalProducer {
        @Volatile private var bridge: Class<*>? = null
        private var attempted = false
        private fun load(): Class<*>? {
            if (!attempted) {
                attempted = true
                bridge = try { Class.forName("dev.everframe.nativecrash.NativeCrashBridge", true, context.classLoader) }
                    catch (_: ClassNotFoundException) { null } catch (_: LinkageError) { null }
            }
            return bridge
        }
        override fun generation(): Long = load()?.getMethod("generation")?.invoke(null) as? Long ?: -1
        override fun pause() { bridge?.getMethod("pause")?.invoke(null) }
        override fun revoke(): Boolean = bridge?.getMethod("revoke")?.invoke(null) as? Boolean ?: true
        override fun arm(epoch: String, key: ByteArray, generation: Long): Boolean {
            val type = load() ?: return false
            files.prepare(epoch)
            return type.getMethod("arm", String::class.java, String::class.java, ByteArray::class.java,
                String::class.java, Long::class.javaPrimitiveType).invoke(null, files.records.path,
                context.applicationInfo.nativeLibraryDir, key, epoch, generation) as Boolean
        }
    }
}
