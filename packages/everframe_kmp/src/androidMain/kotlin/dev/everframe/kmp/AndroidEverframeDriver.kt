// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

import android.app.Activity
import android.content.Context
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.SensitiveRectRegistry
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import dev.everframe.config.TXUser
import dev.everframe.ui.EFReporterFromImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference

/** Android adapter with masked, image-only replay for Compose hosts. */
class AndroidEverframeDriver(
    private val context: Context,
    currentActivity: Activity?,
    private val allowCaptureWithoutSensitiveMarkers: () -> Boolean = { false },
) : EverframeNativeDriver {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var captureJob: Job? = null
    private var replay = AndroidImageReplayBuffer()
    private var activityRef = currentActivity?.let(::WeakReference)
    private var started = false

    private fun hostActivity(): Activity? = activityRef?.get()?.takeUnless { it.isFinishing || it.isDestroyed }

    /** Bind the visible Activity on creation/resume and pass null when it stops. */
    fun bindActivity(activity: Activity?) {
        if (activityRef?.get() === activity) return
        captureJob?.cancel()
        captureJob = null
        replay = AndroidImageReplayBuffer()
        activityRef = activity?.let(::WeakReference)
        if (activity != null && started && Everframe.captureGate) beginCapture()
    }

    override fun start(appId: String, sdkKey: String, environment: String): Boolean {
        return try {
            val nativeEnvironment = Environment.entries.firstOrNull { it.name == environment } ?: return false
            Everframe.start(context, EverframeConfig(
                appId = appId,
                sdkKey = sdkKey,
                environment = nativeEnvironment,
                capture = CaptureConfig(screenshot = false, crash = true, network = true, networkBodies = false),
            ), hostActivity())
            Everframe.captureGate.also {
                started = it
                if (it) beginCapture()
            }
        } catch (_: Exception) {
            false
        }
    }

    override fun setUser(id: String?, email: String?, displayName: String?) {
        Everframe.setUser(if (id == null && email == null && displayName == null) null else TXUser(id, email, displayName))
    }

    override fun recordScreen(name: String) { Everframe.recordScreen(name) }
    override fun addBreadcrumb(message: String, kind: String?, level: String?) {
        Everframe.addBreadcrumb(message, kind, level)
    }

    override fun captureHandledError(code: String) {
        Everframe.captureException(KmpHandledException(code), null, "everframe-kmp")
    }

    override fun captureException(error: Throwable) {
        Everframe.captureException(error, null, "everframe-kmp")
    }

    override fun openReporter(completion: (EverframeReportOutcome) -> Unit) {
        scope.launch {
            try {
                captureJob?.cancelAndJoin()
                captureJob = null
                val hostReplay = replay.export()
                replay = AndroidImageReplayBuffer()
                val host = hostActivity()
                if (host == null) {
                    completion(EverframeReportOutcome("failed", reason = "no_activity"))
                    return@launch
                }
                val sensitive = SensitiveRectRegistry.collectInWindowCoords(host)
                if (sensitive.isEmpty() && !allowCaptureWithoutSensitiveMarkers()) {
                    completion(EverframeReportOutcome("failed", reason = "sensitive_markers_missing"))
                    return@launch
                }
                val screenshot = ScreenshotCapture.captureBeforeReporter(host, sensitive)
                if (screenshot == null) {
                    completion(EverframeReportOutcome("failed", reason = "capture_unavailable"))
                    return@launch
                }
                if (host !== hostActivity()) {
                    screenshot.bitmap.recycle()
                    completion(EverframeReportOutcome("failed", reason = "activity_changed"))
                    return@launch
                }
                val maskedPng = screenshot.pngBytes.copyOf()
                screenshot.bitmap.recycle()
                val outcome = EFReporterFromImage.open(host, maskedPng, hostReplay, sdkName = "everframe-kmp")
                completion(when (outcome) {
                    is ReportResult.Submitted -> EverframeReportOutcome("submitted", outcome.reportId.toString())
                    is ReportResult.Queued -> EverframeReportOutcome("queued", outcome.reportId.toString())
                    is ReportResult.Cancelled -> EverframeReportOutcome("cancelled", reason = outcome.reason)
                })
            } catch (error: Exception) {
                completion(EverframeReportOutcome("failed", reason = error.message))
            } finally {
                if (started && Everframe.captureGate) beginCapture()
            }
        }
    }

    override fun kill() {
        captureJob?.cancel()
        captureJob = null
        replay = AndroidImageReplayBuffer()
        started = false
        Everframe.kill()
    }

    private fun beginCapture() {
        captureJob?.cancel()
        replay = AndroidImageReplayBuffer()
        captureJob = scope.launch {
            // Give Compose one settled frame after the Start button changes state.
            delay(250)
            var lastHost: Activity? = null
            while (isActive && Everframe.captureGate) {
                val host = hostActivity()
                if (host == null) {
                    replay = AndroidImageReplayBuffer()
                    lastHost = null
                    delay(1_000)
                    continue
                }
                if (host !== lastHost) {
                    replay = AndroidImageReplayBuffer()
                    lastHost = host
                }
                val sensitive = SensitiveRectRegistry.collectInWindowCoords(host)
                // Require a proven sensitive marker before
                // retaining any frame; uncertainty discards the whole ring.
                if (sensitive.isEmpty() && !allowCaptureWithoutSensitiveMarkers()) {
                    replay = AndroidImageReplayBuffer()
                    delay(1_000)
                    continue
                }
                val screenshot = ScreenshotCapture.captureBeforeReporter(host, sensitive)
                if (!isActive || !Everframe.captureGate || host !== hostActivity() || screenshot == null) {
                    screenshot?.bitmap?.recycle()
                    replay = AndroidImageReplayBuffer()
                    if (!isActive || !Everframe.captureGate) break
                    delay(1_000)
                    continue
                }
                val accepted = replay.add(screenshot.widthPx, screenshot.heightPx, screenshot.pngBytes)
                screenshot.bitmap.recycle()
                if (!accepted) replay = AndroidImageReplayBuffer()
                delay(1_000)
            }
        }
    }
}

private class KmpHandledException(code: String) : RuntimeException("KMP handled error: $code")
