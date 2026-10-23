// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the mode rule. When the platform gesture fires
// (shake on phones; a remote binding on TVs in a later change), [decide] turns
// the device's state into a capture, a link hello, the in-app reporter, or
// nothing (wire contract, "Device behavior summary"):
//
//   linked (user or team)     capture with the token
//   unlinked debug build      shared capture, plus a hello if linking is on
//   unlinked release phone    today's shake (reporter if shake-to-report allows), plus a hello
//   unlinked release TV       nothing visible, plus a hello
//
// With quick capture off (`captureHotkey.enabled: false`, or the local
// `quickCaptureEnabled`/`reporterEnabled` off, or the kill switch closed)
// there is no capture and no hello, and the gesture behaves exactly as today.

package dev.everframe.quickcapture

import dev.everframe.devicelink.DeviceLink
import dev.everframe.devicelink.DeviceLinkOwner

internal enum class GestureSource { Shake, Remote }

/**
 * [quickCaptureEnabled]: the local `quickCaptureEnabled && reporterEnabled`, the dashboard's
 * `captureHotkey.enabled`, and the kill switch. [shakeReporterEnabled]: the local and dashboard
 * shake-to-report switches, which decide only whether an unlinked release phone opens the reporter.
 */
internal data class GestureInput(
    val quickCaptureEnabled: Boolean,
    val linkingEnabled: Boolean,
    val link: DeviceLinkOwner?,
    val debugBuild: Boolean,
    val isTv: Boolean,
    val shakeReporterEnabled: Boolean,
)

internal data class GestureDecision(
    val capture: Boolean,
    val sendHello: Boolean,
    val openReporter: Boolean,
    val swallowKeys: Boolean,
)

internal object CaptureGesture {
    // ---- Test seams ----

    @Volatile internal var captureTrigger: () -> Unit = { QuickCapture.trigger() }
    @Volatile internal var helloSender: () -> Unit = { DeviceLink.sendHello() }
    @Volatile internal var inputProvider: ((isTv: Boolean) -> GestureInput)? = null

    /** A direct transcription of the contract table; see the file header. */
    fun decide(input: GestureInput): GestureDecision {
        val qc = input.quickCaptureEnabled
        val linked = input.link != null
        return GestureDecision(
            capture = qc && (linked || input.debugBuild),
            sendHello = qc && !linked && input.linkingEnabled,
            openReporter = !input.isTv && input.shakeReporterEnabled && (!qc || (!linked && !input.debugBuild)),
            swallowKeys = qc && linked,
        )
    }

    /** Whether the gesture detector should run at all for quick capture or linking. */
    fun isArmed(input: GestureInput): Boolean =
        input.quickCaptureEnabled && (input.link != null || input.debugBuild || input.linkingEnabled)

    fun currentInput(isTv: Boolean): GestureInput {
        inputProvider?.let { return it(isTv) }
        return GestureInput(
            quickCaptureEnabled = QuickCapture.gestureCaptureEnabled,
            linkingEnabled = DeviceLink.linkingEnabled,
            link = DeviceLink.current?.owner,
            debugBuild = QuickCapture.isDebugBuild,
            isTv = isTv,
            shakeReporterEnabled = dev.everframe.trigger.ShakeToReportTrigger.reporterAllowed,
        )
    }

    /**
     * Runs the decision for one gesture and returns it, so the caller can open the reporter or swallow keys.
     * Until the stored link has loaded there is no capture and no hello (a linked device must never file a
     * shared capture or say hello); the reporter still opens as it does today.
     */
    fun onGesture(source: GestureSource): GestureDecision {
        val input = currentInput(isTv = source == GestureSource.Remote)
        if (!DeviceLink.isLoaded) {
            return GestureDecision(
                capture = false,
                sendHello = false,
                openReporter = !input.isTv && input.shakeReporterEnabled,
                swallowKeys = false,
            )
        }
        val decision = decide(input)
        if (decision.capture) runCatching { captureTrigger() }
        if (decision.sendHello) runCatching { helloSender() }
        return decision
    }

    /** Tests only. */
    internal fun __resetForTesting() {
        captureTrigger = { QuickCapture.trigger() }
        helloSender = { DeviceLink.sendHello() }
        inputProvider = null
    }
}
