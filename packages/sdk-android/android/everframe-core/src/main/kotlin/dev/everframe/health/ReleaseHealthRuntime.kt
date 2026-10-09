// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.crash.AndroidNativeCrashRuntime
import dev.everframe.crash.AndroidNativeSignalRuntime
import dev.everframe.envelope.txGuardSuspend
import dev.everframe.outbox.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** The foreground owner is independent of replay, vitals and install identity. */
internal object ReleaseHealthRuntime {
    @Volatile private var context: Context? = null
    @Volatile private var controller = newController()
    private fun newController() = ReleaseHealthController(factory = {
        val application = requireNotNull(context)
        OutboxStore(File(application.noBackupFilesDir, "dev.everframe/release-health-v1"),
            __keysForTesting ?: AndroidOutboxKeyProvider("dev.everframe.release-health.v1"), __fileOpsForTesting ?: AndroidOutboxFileOps(),
            maxEntries = 256, maxTotalBytes = 1024 * 1024, maintenanceReserveBytes = 16 * 1024)
    })

    /** Test seams replacing Keystore keys, file operations and the process lifecycle. Never set in production. */
    @VisibleForTesting internal var __keysForTesting: OutboxKeyProvider? = null
    @VisibleForTesting internal var __fileOpsForTesting: OutboxFileOps? = null
    @VisibleForTesting internal var __lifecycleOwnerForTesting: LifecycleOwner? = null

    /** Simulates process death: in-memory sessions and obligations are lost, the durable journal remains. */
    @VisibleForTesting
    internal fun __resetForTesting() {
        observer.getAndSet(null)?.uninstall()
        preparedBoundaries.set(null)
        controller = newController()
    }

    /** Lifecycle and delivery work launched so far, for tests that wait for it to settle. */
    @VisibleForTesting
    internal fun __pendingWorkForTesting(): List<Job> = scope.coroutineContext[Job]?.children?.toList().orEmpty()

    private val transport by lazy { OkHttpHealthTransport() }
    private val admission = HealthAdmission { allowed, prepared ->
        Everframe.withReportAuthorizationLock { if (allowed()) prepared() else null }
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lifecycleWork = Mutex()
    private val observer = AtomicReference<ReleaseHealthLifecycleObserver?>()
    private val preparedBoundaries = AtomicReference<ReleaseHealthRequest?>()

    /** SDK authorization lock held: publication and invalidation are memory-only. */
    fun request(epoch: Int, enabled: Boolean) {
        preparedBoundaries.set(null)
        controller.request(epoch, enabled)
        observer.getAndSet(null)?.uninstall()
    }
    fun readyPointer(epoch: Int) = controller.readyPointer(epoch)

    /** Disabled boundaries attempt durable erasure on the calling thread, outside the SDK authorization
     * lock, before kill() or a disabled start returns. A start without health configuration passes
     * [erase] false and leaves that erasure to [start]. */
    fun boundary(application: Context?, epoch: Int, erase: Boolean = true) {
        if (application != null) context = application.applicationContext
        if (!erase) return
        val request = controller.currentRequest(epoch) ?: return
        if (!request.enabled) controller.finishBoundary(request)
    }

    /** IO initialization registers lifecycle ownership; it never assumes a foreground app. */
    suspend fun start(application: Context, captured: TXCapturedSession, endpoint: String) {
        context = application.applicationContext
        val config = captured.config ?: return
        val epoch = captured.user.startEpoch
        val request = controller.currentRequest(epoch) ?: return
        Everframe.withReportAuthorizationLock {
            if (controller.currentRequest(epoch) === request) preparedBoundaries.set(request)
        } // The SDK start tail follows its native context boundary.
        controller.finishBoundary(request)
        val health = config.releaseHealth ?: return
        if (!request.enabled) return
        val current = object : OutboxAuthorization {
            override fun isAllowed() = Everframe.captureGate && Everframe.currentStartEpochVolatile() == epoch &&
                !Everframe.killGenerationChangedVolatile(captured.killGeneration)
        }
        val retained = object : OutboxAuthorization {
            override fun isAllowed() = Everframe.captureGate && !Everframe.killGenerationChangedVolatile(captured.killGeneration)
        }
        val installed = ReleaseHealthLifecycleObserver({ foreground ->
            val boundary = Everframe.withReportAuthorizationLock {
                if (controller.currentRequest(epoch) !== request || !current.isAllowed()) null else {
                    val closed = controller.foreground(request, foreground)
                    // Background clears actual native attribution before the end can persist; this
                    // memory/OS-token fence cannot clear a newer SDK generation's context. Foreground
                    // entry keeps capture armed: no pointer is live yet, and the refresh after the
                    // durable start replaces the pointer-free context.
                    if (!foreground) {
                        AndroidNativeCrashRuntime.invalidateExposure()
                        AndroidNativeSignalRuntime.invalidateExposure()
                    }
                    closed?.let(controller::rememberForegroundBoundary)
                    Pair(true, closed)
                }
            } ?: return@ReleaseHealthLifecycleObserver
            val closed = boundary.second
            scope.launch {
                txGuardSuspend("releaseHealth.lifecycleWork") {
                    lifecycleWork.withLock {
                        if (controller.currentRequest(epoch) !== request || !current.isAllowed()) return@withLock
                        if (foreground) controller.activate(request, health, Everframe.SDK_VERSION, config.sdkKey,
                            endpoint.trimEnd('/') + "/api/ingest/release-health", current, retained)
                        AndroidNativeCrashRuntime.refreshExposure(epoch)
                        AndroidNativeSignalRuntime.refreshExposure(epoch)
                        closed?.let(controller::finishForegroundBoundary)
                    }
                    flush(epoch)
                }
            }
        }, { __lifecycleOwnerForTesting ?: ProcessLifecycleOwner.get() })
        Everframe.withReportAuthorizationLock {
            if (current.isAllowed() && controller.currentRequest(epoch) === request) {
                observer.getAndSet(installed)?.uninstall()
                installed.install()
            } else installed.uninstall()
        }
    }
    suspend fun flush(epoch: Int) {
        val request = controller.currentRequest(epoch) ?: return
        if (preparedBoundaries.get() === request) controller.finishBoundary(request)
        // Retry only explicit live boundaries after the native registration fence.
        controller.flush(request, transport, admission)
    }
}
