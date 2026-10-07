// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.content.Context
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.outbox.*
import java.io.File

/** The process owner is independent of replay, vitals and install/user identity. */
internal object ReleaseHealthRuntime {
    @Volatile private var context: Context? = null
    private val controller = ReleaseHealthController(factory = {
        val application = requireNotNull(context)
        OutboxStore(File(application.noBackupFilesDir, "dev.everframe/release-health-v1"),
            AndroidOutboxKeyProvider("dev.everframe.release-health.v1"), AndroidOutboxFileOps(),
            maxEntries = 256, maxTotalBytes = 1024 * 1024, maintenanceReserveBytes = 16 * 1024)
    })
    private val transport by lazy { OkHttpHealthTransport() }
    private val admission = HealthAdmission { allowed, prepared ->
        Everframe.withReportAuthorizationLock { if (allowed()) prepared() else null }
    }

    /** SDK authorization lock held: publication and invalidation are memory-only. */
    fun request(epoch: Int, enabled: Boolean) { controller.request(epoch, enabled) }
    fun readyPointer(epoch: Int) = controller.readyPointer(epoch)

    /** Disabled boundaries attempt durable erasure outside the SDK authorization lock. */
    fun boundary(application: Context?, epoch: Int) {
        if (application != null) context = application.applicationContext
        val request = controller.currentRequest(epoch) ?: return
        if (!request.enabled) controller.finishBoundary(request)
    }

    /** Runs on the SDK IO scope. Readiness is published only after encrypted commit. */
    suspend fun start(application: Context, captured: TXCapturedSession, endpoint: String) {
        context = application.applicationContext
        val config = captured.config ?: return
        val health = config.releaseHealth ?: return
        val epoch = captured.user.startEpoch
        val request = controller.currentRequest(epoch) ?: return
        controller.finishBoundary(request)
        val current = object : OutboxAuthorization {
            override fun isAllowed() = Everframe.captureGate && Everframe.currentStartEpochVolatile() == epoch &&
                !Everframe.killGenerationChangedVolatile(captured.killGeneration)
        }
        val retained = object : OutboxAuthorization {
            override fun isAllowed() = Everframe.captureGate && !Everframe.killGenerationChangedVolatile(captured.killGeneration)
        }
        if (controller.activate(request, health, Everframe.SDK_VERSION, config.sdkKey,
                endpoint.trimEnd('/') + "/api/ingest/release-health", current, retained)) flush(epoch)
    }
    suspend fun flush(epoch: Int) {
        val request = controller.currentRequest(epoch) ?: return
        controller.flush(request, transport, admission)
    }
}
