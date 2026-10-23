// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Emulator quick capture: Shift+B pressed inside the app (the dashboard's binding when the emulator can
// deliver it, see [AndroidCaptureChord]), or `adb shell am broadcast -a com.everframe.CAPTURE`, sent to a
// debug build on an emulator files a report with no UI. The SDK
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
// The key chord is seen by `TXWindowCallbackWrapper.dispatchKeyEvent` (the Activity window callback the
// tap breadcrumbs already install on every start), which asks [QuickCapture.armedChord] per key event and
// stands aside while a text editor has focus.
//
// The block's `replay` flag also records session replay while quick capture is armed, whatever the
// app's `replayEnabled` ([QuickCapture.forcesReplay]).
//
// A host that renders its own pixels (Flutter, which starts the SDK with `capture.screenshot = false`
// and masks in Dart) installs an evidence provider through `Everframe.__setQuickCaptureEvidenceProvider`.
// With a provider the capture ships the host's masked screenshot and replay and never takes the native
// screenshot. Without one, a session whose `capture.screenshot` is false is ignored
// (`screenshot_disabled`): it never uploads an unmasked native screenshot.
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
import dev.everframe.TXCapturedSession
import dev.everframe.capture.EmulatorEnvironment
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.SensitiveRectRegistry
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.companion.CompanionSubmissionComposer
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.IngestEndpoint
import dev.everframe.config.ReportResult
import dev.everframe.config.ReporterTrigger
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Host-rendered evidence for one quick capture. [screenshot] is already masked, built the way
 * `EFReporterFromImage.open` builds it from the host's `maskedPng` (decoded bitmap, its size, and the
 * PNG bytes). [hostReplayVTree] is the host's masked replay timeline, the bytes the reporter takes as
 * `hostReplayVTree`; null means the host has no safe frames. [sdkName] is the host SDK's identity for
 * `sdk.name`, as the host passes it to `EFReporterFromImage.open`; null keeps `everframe-android`.
 * SDK seam for host plugins; see `Everframe.__setQuickCaptureEvidenceProvider`.
 */
class QuickCaptureHostEvidence(
    val screenshot: ScreenshotCapture.CaptureResult,
    val hostReplayVTree: ByteArray?,
    val sdkName: String? = null,
)

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

    internal const val EVIDENCE_TIMEOUT_MS: Long = 5_000

    private const val NATIVE_SDK_NAME = "everframe-android"

    /** The identities `EFReporterFromImage.open` accepts. */
    private val HOST_SDK_NAMES = setOf(NATIVE_SDK_NAME, "everframe-flutter", "everframe-kmp")

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

    /** How long a host evidence provider may take before the capture fails. */
    @Volatile
    internal var evidenceTimeoutMs: Long = EVIDENCE_TIMEOUT_MS

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
    @Volatile private var screenshot = true
    @Volatile private var evidenceProvider: (suspend () -> QuickCaptureHostEvidence?)? = null

    /**
     * The in-app chord while quick capture is armed (receiver installed on a debug emulator build with the
     * local opt-in, and the dashboard's block enabled), else null. Written under [lock] by every state
     * change; read lock-free on each key event.
     */
    @Volatile private var chordWhileArmed: AndroidCaptureChord? = null
    private val inFlight = AtomicBoolean(false)

    /** The session's `capture.screenshot`. */
    val sessionScreenshotEnabled: Boolean get() = screenshot

    val hasEvidenceProvider: Boolean get() = evidenceProvider != null

    /** Installs (or with null, removes) the host evidence provider. `teardown` (from `kill()`) clears it. */
    fun setEvidenceProvider(provider: (suspend () -> QuickCaptureHostEvidence?)?) {
        synchronized(lock) { evidenceProvider = provider }
    }

    /**
     * True from the gate check to the toast. Shake-to-report stands down while it is set. An explicit
     * `report.open()` does not check it and proceeds as today: its freeze then finds this capture's
     * owner and gets an empty capture, so that report may miss the replay and frozen evidence.
     */
    val isCapturing: Boolean get() = inFlight.get()

    /**
     * Called from `start()`. Replaces any previous receiver, and a new session starts disarmed until its
     * own config names a `captureHotkey` block. [screenshot] is the session's `capture.screenshot`.
     */
    fun install(
        context: Context,
        localEnabled: Boolean,
        debug: Boolean,
        screenshot: Boolean = true,
        isCurrent: () -> Boolean = { true },
    ) {
        synchronized(lock) {
            if (!isCurrent()) return
            unregisterLocked()
            this.debug = debug
            this.localEnabled = localEnabled
            this.screenshot = screenshot
            remoteEnabled = false
            remoteReplay = false
            chordWhileArmed = null
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

    /**
     * The dashboard's `captureHotkey` block from each config refresh. `binding` picks the in-app chord, as
     * far as the emulator can deliver it ([AndroidCaptureChord.from]).
     */
    fun publishRemote(wire: CaptureHotkeyConfigWire?, isCurrent: () -> Boolean = { true }) {
        synchronized(lock) {
            if (!isCurrent()) return
            remoteEnabled = wire?.enabled == true
            remoteReplay = wire?.replay == true
            chordWhileArmed = if (receiver != null && debug && localEnabled && remoteEnabled) {
                AndroidCaptureChord.from(wire?.binding)
            } else {
                null
            }
        }
    }

    /**
     * The chord to capture on, or null while quick capture is disarmed or the kill switch is closed. Two
     * volatile reads: cheap enough for every key event. The capture itself re-checks the full gate.
     */
    val armedChord: AndroidCaptureChord?
        get() {
            val chord = chordWhileArmed ?: return null
            return chord.takeIf { Everframe.captureGate }
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
            chordWhileArmed = null
            screenshot = true
            evidenceProvider = null
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
            trigger()
        }
    }

    /** Starts one capture on the SDK scope. The broadcast and the in-app chord both come here. */
    fun trigger() {
        __lastTrigger = Everframe.sdkScope.async { capture() }
    }

    // ---- Pipeline ----

    suspend fun capture(): QuickCaptureOutcome {
        val activity = Everframe.__activitySupplier?.invoke()?.takeUnless { it.isFinishing || it.isDestroyed }
        // Read once: the gate and the pipeline must agree on the provider.
        val provider = evidenceProvider
        ignoreReason(activity, provider != null)?.let { return QuickCaptureOutcome.Ignored(it) }
        if (!inFlight.compareAndSet(false, true)) return QuickCaptureOutcome.Ignored("in_flight")
        try {
            // The in-app reporter freezes before its dialog shows, and the companion never marks itself
            // presenting: a held owner means another capture's frozen evidence, which this capture must
            // not freeze over or consume. Checked after the claim, so no capture of ours can slip between.
            if (Everframe.__replayHasReporterOwner) return QuickCaptureOutcome.Ignored("capture_frozen")
            val appContext = activity!!.applicationContext
            val outcome = runPipeline(appContext, activity, provider)
            toastText(outcome, deviceName(appContext))?.let { text ->
                withContext(Dispatchers.Main) { Toast.makeText(appContext, text, Toast.LENGTH_SHORT).show() }
            }
            return outcome
        } finally {
            inFlight.set(false)
        }
    }

    private fun ignoreReason(activity: Activity?, hasProvider: Boolean): String? = when {
        !isEmulator() -> "not_emulator"
        !debug -> "not_debug"
        !localEnabled -> "disabled"
        !remoteEnabled -> "remote_disabled"
        !Everframe.captureGate -> "kill_switch"
        activity == null -> "inactive"
        // The same flag the shake gate reads.
        Everframe.report.isPresenting.value -> "reporter_presenting"
        // The host masks its own pixels (Flutter) and installed no provider: the native screenshot would
        // be unmasked, so there is nothing safe to send.
        !hasProvider && !screenshot -> "screenshot_disabled"
        else -> null
    }

    /**
     * `TXReporterPresenter.presentOnce` minus the dialog: screenshot first, then the reporter-open
     * boundary and freeze, then submit. Every exit after the freeze releases it: an upload (sent or
     * queued) finishes consumption, anything else cancels.
     */
    private suspend fun runPipeline(
        appContext: Context,
        activity: Activity,
        provider: (suspend () -> QuickCaptureHostEvidence?)?,
    ): QuickCaptureOutcome {
        val shot: ScreenshotCapture.CaptureResult
        val hostReplayVTree: ByteArray?
        val sdkName: String
        // The session this capture belongs to, taken once before any evidence and carried to the submission.
        // Its epoch is read in the same critical section as its config, so the check below and the routing
        // agree on one session; nothing after the screenshot reads the session again.
        val capturedSession = Everframe.captureSessionSnapshot()
        if (provider != null) {
            // The host's masked evidence replaces the native screenshot entirely; a null answer, a throw, or
            // no answer within the timeout fails without a fallback.
            val evidence = awaitEvidence(provider) ?: return QuickCaptureOutcome.Failed
            // As `EFReporterFromImage.open`: an identity outside the known SDKs is refused.
            sdkName = evidence.sdkName ?: NATIVE_SDK_NAME
            if (sdkName !in HOST_SDK_NAMES) return QuickCaptureOutcome.Failed
            shot = evidence.screenshot
            // As `EFReporterFromImage`: host evidence owns replay, and an empty value keeps the native
            // video fallback off.
            hostReplayVTree = evidence.hostReplayVTree ?: ByteArray(0)
        } else {
            shot = withContext(Dispatchers.Main) {
                if (activity.isFinishing || activity.isDestroyed) return@withContext null
                screenshotter(activity, SensitiveRectRegistry.collectInWindowCoords(activity))
            } ?: return QuickCaptureOutcome.Failed
            hostReplayVTree = null
            sdkName = NATIVE_SDK_NAME
        }
        // Either screenshot was taken asynchronously (the host's render, or PixelCopy and PNG encoding). A
        // kill() in that window means nothing may freeze or ship; a kill() then start() means the image
        // belongs to the previous session; a finished activity is no longer what was captured; and a
        // reporter that opened (or froze) meanwhile owns the evidence this capture would freeze.
        if (!isCurrent(capturedSession) || activity.isFinishing || activity.isDestroyed ||
            Everframe.report.isPresenting.value || Everframe.__replayHasReporterOwner
        ) {
            return QuickCaptureOutcome.Failed
        }
        val capture = try {
            freezer(ReporterTrigger.QuickCapture)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            return QuickCaptureOutcome.Failed
        }
        try {
            // Consume-once host payload, exactly as the reporter drains it at open.
            val hostExtra = Everframe.consumePendingAttachments()?.takeIf { it.isNotEmpty() }
            // The host's extra resolver can suspend: a start() meanwhile may have handed back the new
            // session's metadata. The consumed value is dropped with the capture.
            if (!isCurrent(capturedSession)) {
                capture.cancel()
                return QuickCaptureOutcome.Failed
            }
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
                    // Only for the origin that issued it; the composer posts to `IngestEndpoint.url`.
                    captureToken = CaptureTokenReader.read(appContext, IngestEndpoint.url),
                    // The raw screenshot: no annotation canvas ran.
                    annotated = false,
                    hostReplayVTree = hostReplayVTree,
                    sdkName = sdkName,
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

    /** The kill switch is open and no start() or kill() has run since [capturedSession] was taken. */
    private fun isCurrent(capturedSession: TXCapturedSession): Boolean =
        Everframe.captureGate && Everframe.currentStartEpochVolatile() == capturedSession.user.startEpoch

    /**
     * The provider's answer, or null on a throw or after [evidenceTimeoutMs]. The provider runs as its own
     * child of the SDK scope, so the wait ends at the timeout even when the provider ignores cancellation;
     * it is cancelled either way and a late answer is dropped.
     */
    private suspend fun awaitEvidence(provider: suspend () -> QuickCaptureHostEvidence?): QuickCaptureHostEvidence? {
        val answer = Everframe.sdkScope.async { provider() }
        return try {
            withTimeoutOrNull(evidenceTimeoutMs) { answer.await() }
        } catch (e: CancellationException) {
            // Our own cancellation propagates; a provider that cancelled itself is a failed answer.
            if (!currentCoroutineContext().isActive) throw e
            null
        } catch (_: Throwable) {
            null
        } finally {
            answer.cancel()
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
        evidenceTimeoutMs = EVIDENCE_TIMEOUT_MS
        __lastTrigger = null
        inFlight.set(false)
    }
}
