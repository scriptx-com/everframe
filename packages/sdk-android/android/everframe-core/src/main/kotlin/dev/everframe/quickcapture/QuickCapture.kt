// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Emulator quick capture: `adb shell am broadcast -a com.everframe.CAPTURE`
// sent to a debug build on an emulator files a report with no UI. The SDK
// takes the screenshot, freezes replay and evidence exactly as the reporter
// does at open, submits with `quickCapture: true` plus the developer's capture
// token, then shows a short toast. Title and description stay empty: the
// dashboard fills them in. Android twin of iOS `QuickCapture.swift`.
//
// The receiver is registered only on a debug build, on an emulator, with the
// local `quickCaptureEnabled` and `reporterEnabled` options on. It is
// RECEIVER_EXPORTED because `adb shell` broadcasts as the shell UID, and it
// requires the sender to hold `android.permission.DUMP` (see
// [QuickCapture.BROADCAST_PERMISSION]), which the shell holds and an ordinary
// app cannot obtain. The receiver is still a pure trigger: it reads no extras
// and returns no data, and every capture still passes the gate below (the
// dashboard's `captureHotkey` block, a current activity, no reporter on screen,
// no other capture holding the freeze).
//
// The block's `replay` flag also records session replay while quick capture is armed, whatever the
// app's `replayEnabled` ([QuickCapture.forcesReplay]).
package dev.everframe.quickcapture

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Rect
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import dev.everframe.Everframe
import dev.everframe.capture.EmulatorEnvironment
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.SensitiveRectRegistry
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.companion.CompanionSubmissionComposer
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.ReportResult
import dev.everframe.config.ReporterTrigger
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext

internal sealed interface QuickCaptureOutcome {
    data class Ignored(val reason: String) : QuickCaptureOutcome
    data object Sent : QuickCaptureOutcome
    data object Queued : QuickCaptureOutcome
    data object Failed : QuickCaptureOutcome
}

internal object QuickCapture {
    const val ACTION: String = "com.everframe.CAPTURE"

    /**
     * The permission a sender must hold for the receiver to accept the broadcast. The shell UID
     * holds DUMP, so `adb shell am broadcast -a com.everframe.CAPTURE` still reaches the receiver;
     * DUMP is signature|privileged|development, so another app on the emulator cannot hold it
     * unless someone grants it from adb. Whatever this is changed to MUST keep allowing
     * `adb shell am broadcast`, or the host trigger stops working.
     */
    const val BROADCAST_PERMISSION: String = "android.permission.DUMP"

    // ---- Test seams ----

    @Volatile
    internal var submitter: suspend (CompanionSubmissionComposer.Inputs) -> ReportResult = CompanionSubmissionComposer::submit

    @Volatile
    internal var isEmulator: () -> Boolean = EmulatorEnvironment::isEmulator

    @Volatile
    internal var screenshotter: suspend (Activity, List<Rect>) -> ScreenshotCapture.CaptureResult? =
        { activity, rects -> ScreenshotCapture.captureBeforeReporter(activity, rects) }

    /** The reporter-open boundary and freeze, counted in tests. */
    @Volatile
    internal var freezer: (ReporterTrigger) -> FrozenReportCapture = { Everframe.__replayFreeze(it) }

    /** The capture the latest broadcast started. Tests await it; production never reads it. */
    @Volatile
    internal var __lastTrigger: Deferred<QuickCaptureOutcome>? = null

    // ---- Session state ----

    private val lock = Any()
    private var receiver: BroadcastReceiver? = null
    private var receiverContext: Context? = null
    @Volatile private var debug = false
    @Volatile private var localEnabled = false
    @Volatile private var remoteEnabled = false
    @Volatile private var remoteReplay = false
    private val inFlight = AtomicBoolean(false)

    /**
     * True from the gate check to the toast. Shake-to-report stands down while it is set. An explicit
     * `report.open()` does not check it and proceeds as today: its freeze then finds this capture's
     * owner and gets an empty capture, so that report may miss the replay and frozen evidence.
     */
    val isCapturing: Boolean get() = inFlight.get()

    /**
     * Called from `start()`. Replaces any previous receiver, and a new session starts disarmed until its
     * own config names a `captureHotkey` block.
     */
    fun install(context: Context, localEnabled: Boolean, debug: Boolean, isCurrent: () -> Boolean = { true }) {
        synchronized(lock) {
            if (!isCurrent()) return
            unregisterLocked()
            this.debug = debug
            this.localEnabled = localEnabled
            remoteEnabled = false
            remoteReplay = false
            if (!debug || !localEnabled || !isEmulator()) return
            val app = context.applicationContext ?: context
            val next = Receiver()
            val registered = runCatching {
                // `adb shell am broadcast` runs as the shell UID and cannot reach a NOT_EXPORTED receiver.
                // The permission keeps other apps out and MUST keep admitting the shell (see above).
                if (Build.VERSION.SDK_INT >= 33) {
                    app.registerReceiver(next, IntentFilter(ACTION), BROADCAST_PERMISSION, null, Context.RECEIVER_EXPORTED)
                } else {
                    app.registerReceiver(next, IntentFilter(ACTION), BROADCAST_PERMISSION, null)
                }
            }.isSuccess
            if (registered) {
                receiver = next
                receiverContext = app
            }
        }
    }

    /** The dashboard's `captureHotkey` block from each config refresh. Android ignores `binding`. */
    fun publishRemote(wire: CaptureHotkeyConfigWire?, isCurrent: () -> Boolean = { true }) {
        synchronized(lock) {
            if (!isCurrent()) return
            remoteEnabled = wire?.enabled == true
            remoteReplay = wire?.replay == true
        }
    }

    /**
     * True while quick capture is armed (debug build, emulator, local opt-in, the dashboard's block enabled,
     * the receiver installed, kill switch open) and the block's `replay` flag is set. `ReplaySession` then
     * records replay even when `replayEnabled` is false; this never turns replay off. Release builds and
     * real devices never install the receiver, so it is always false there. `ReplaySession` reads it at
     * every config apply, right after publishing that config's block, so a disarm stops a forced
     * recording at the next apply, and `kill()` tears the replay session down with it.
     */
    val forcesReplay: Boolean
        get() {
            val flagged = synchronized(lock) { receiver != null && debug && localEnabled && remoteEnabled && remoteReplay }
            return flagged && Everframe.captureGate && isEmulator()
        }

    /** Called from `kill()`. */
    fun teardown(isCurrent: () -> Boolean = { true }) {
        synchronized(lock) {
            if (!isCurrent()) return
            unregisterLocked()
            debug = false
            localEnabled = false
            remoteEnabled = false
            remoteReplay = false
        }
    }

    private fun unregisterLocked() {
        val current = receiver ?: return
        runCatching { receiverContext?.unregisterReceiver(current) }
        receiver = null
        receiverContext = null
    }

    private class Receiver : BroadcastReceiver() {
        // A pure trigger: nothing is read from the intent, whoever sent it.
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION) return
            __lastTrigger = Everframe.sdkScope.async { capture() }
        }
    }

    // ---- Pipeline ----

    suspend fun capture(): QuickCaptureOutcome {
        val activity = Everframe.__activitySupplier?.invoke()?.takeUnless { it.isFinishing || it.isDestroyed }
        ignoreReason(activity)?.let { return QuickCaptureOutcome.Ignored(it) }
        if (!inFlight.compareAndSet(false, true)) return QuickCaptureOutcome.Ignored("in_flight")
        try {
            // The in-app reporter freezes before its dialog shows, and the companion never marks itself
            // presenting: a held owner means another capture's frozen evidence, which this capture must
            // not freeze over or consume. Checked after the claim, so no capture of ours can slip between.
            if (Everframe.__replayHasReporterOwner) return QuickCaptureOutcome.Ignored("capture_frozen")
            val appContext = activity!!.applicationContext
            val outcome = runPipeline(appContext, activity)
            toastText(outcome, deviceName(appContext))?.let { text ->
                withContext(Dispatchers.Main) { Toast.makeText(appContext, text, Toast.LENGTH_SHORT).show() }
            }
            return outcome
        } finally {
            inFlight.set(false)
        }
    }

    private fun ignoreReason(activity: Activity?): String? = when {
        !isEmulator() -> "not_emulator"
        !debug -> "not_debug"
        !localEnabled -> "disabled"
        !remoteEnabled -> "remote_disabled"
        !Everframe.captureGate -> "kill_switch"
        activity == null -> "inactive"
        // The same flag the shake gate reads.
        Everframe.report.isPresenting.value -> "reporter_presenting"
        else -> null
    }

    /**
     * `TXReporterPresenter.presentOnce` minus the dialog: screenshot first, then the reporter-open
     * boundary and freeze, then submit. Every exit after the freeze releases it: an upload (sent or
     * queued) finishes consumption, anything else cancels.
     */
    private suspend fun runPipeline(appContext: Context, activity: Activity): QuickCaptureOutcome {
        val shot = withContext(Dispatchers.Main) {
            if (activity.isFinishing || activity.isDestroyed) return@withContext null
            screenshotter(activity, SensitiveRectRegistry.collectInWindowCoords(activity))
        } ?: return QuickCaptureOutcome.Failed
        val capture = try {
            freezer(ReporterTrigger.QuickCapture)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            return QuickCaptureOutcome.Failed
        }
        try {
            val capturedSession = Everframe.captureSessionSnapshot()
            // Consume-once host payload, exactly as the reporter drains it at open.
            val hostExtra = Everframe.consumePendingAttachments()?.takeIf { it.isNotEmpty() }
            val result = submitter(
                CompanionSubmissionComposer.Inputs(
                    activity = activity,
                    captureBitmap = shot.bitmap,
                    capture = capture,
                    title = "",
                    description = "",
                    includeLogs = true,
                    includeNetwork = true,
                    includeMetadata = true,
                    hostExtra = hostExtra,
                    companionAttribution = null,
                    capturedSession = capturedSession,
                    quickCapture = true,
                    // Read fresh per capture. SECURITY: never log.
                    captureToken = CaptureTokenReader.read(appContext),
                    // The raw screenshot: no annotation canvas ran.
                    annotated = false,
                ),
            )
            return when (result) {
                is ReportResult.Submitted -> QuickCaptureOutcome.Sent.also { capture.finishConsumption() }
                is ReportResult.Queued -> QuickCaptureOutcome.Queued.also { capture.finishConsumption() }
                is ReportResult.Cancelled -> QuickCaptureOutcome.Failed.also { capture.cancel() }
            }
        } catch (e: CancellationException) {
            capture.cancel()
            throw e
        } catch (_: Throwable) {
            capture.cancel()
            return QuickCaptureOutcome.Failed
        }
    }

    internal fun toastText(outcome: QuickCaptureOutcome, deviceName: String): String? = when (outcome) {
        QuickCaptureOutcome.Sent -> "Captured · $deviceName"
        QuickCaptureOutcome.Queued -> "Captured · uploads when online"
        QuickCaptureOutcome.Failed -> "Capture failed"
        is QuickCaptureOutcome.Ignored -> null
    }

    /** Shown in the local toast only, never sent. */
    internal fun deviceName(context: Context): String {
        val named = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        return named?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "emulator"
    }

    /** Tests only: restore the production seams and forget the last trigger. */
    internal fun __resetForTesting() {
        submitter = CompanionSubmissionComposer::submit
        isEmulator = EmulatorEnvironment::isEmulator
        screenshotter = { activity, rects -> ScreenshotCapture.captureBeforeReporter(activity, rects) }
        freezer = { Everframe.__replayFreeze(it) }
        __lastTrigger = null
        inFlight.set(false)
    }
}
