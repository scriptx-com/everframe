// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// "Record on device" (spec 2026-10-23): a teammate asks one of their linked devices to record its next key
// presses, and the dashboard turns them into a TV binding. The device learns about the request from
// `deviceLinking.link.recording` on a config fetch (relaunching or foregrounding fetches), shows
// `Recording remote keys for 10 seconds`, records what the window callback sees for 10 s, then posts the presses
// with its device token and shows `Keys sent to Everframe`. The keys still reach the app meanwhile, and the
// capture gesture pauses, so recording a binding never also captures.
//
// A request is recorded at most once (an in-memory id set), never after it expired, never while another runs,
// and never on an unlinked device. If the link changes during the window, nothing is posted.
//
// SECURITY: never log the token.
package dev.everframe.devicelink

import android.os.SystemClock
import dev.everframe.config.RecordingRequestWire
import dev.everframe.quickcapture.GestureRecorder
import dev.everframe.quickcapture.RecordedKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** `POST /api/device-link/recordings/:recordingId`; implemented by [DeviceLinkClient]. */
internal interface GestureRecordingApi {
    /** True on 204. SECURITY: [token] is never logged. */
    suspend fun postRecording(recordingId: String, token: String, events: List<RecordedKey>): Boolean
}

internal object GestureRecording {
    // ---- Test seams ----

    /** Uptime, the clock key events carry. */
    @Volatile internal var now: () -> Long = { SystemClock.uptimeMillis() }
    /** Wall clock, the clock `expiresAt` is in. */
    @Volatile internal var wallNow: () -> Long = { System.currentTimeMillis() }
    @Volatile internal var toaster: (String) -> Unit = { DeviceLink.toaster(it) }
    @Volatile internal var api: () -> GestureRecordingApi? = { DeviceLink.recordingApi }
    @Volatile internal var tokenProvider: () -> String? = { DeviceLink.current?.token }
    @Volatile internal var scopeProvider: () -> CoroutineScope = { DeviceLink.scopeProvider() }
    @Volatile internal var durationMs: Long = GestureRecorder.DURATION_MS

    /** The recording POST gets this long before it is cancelled. */
    internal const val POST_TIMEOUT_MS: Long = 30_000L

    private val lock = Any()
    private val handled = HashSet<String>()
    private var job: Job? = null

    /** The recording in progress, or null. The window callback feeds it every key event while it is set. */
    @Volatile var active: GestureRecorder? = null
        private set

    fun onRequest(request: RecordingRequestWire, isCurrent: () -> Boolean) {
        val recorder: GestureRecorder
        val token: String
        synchronized(lock) {
            if (!isCurrent() || active != null || request.id in handled) return
            if (request.expiresAtMs <= wallNow()) return
            token = tokenProvider() ?: return // SECURITY: never log
            handled += request.id
            recorder = GestureRecorder()
            active = recorder
        }
        safely { toaster(DeviceLinkCopy.RECORDING_STARTED) }
        val started = scopeProvider().launch {
            try {
                delay(durationMs)
            } finally {
                synchronized(lock) { if (active === recorder) active = null }
            }
            val events = recorder.finish(now())
            // A link replaced or forgotten meanwhile: these keys belong to nobody's recording.
            if (!isCurrent() || tokenProvider() != token) return@launch
            val sent = try {
                // A hung call is cancelled at the deadline (the client cancels its HTTP call with the caller).
                withTimeoutOrNull(POST_TIMEOUT_MS) { api()?.postRecording(request.id, token, events) } == true
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                false
            }
            if (sent) safely { toaster(DeviceLinkCopy.RECORDING_SENT) }
        }
        synchronized(lock) {
            if (active === recorder) job = started else started.cancel()
        }
    }

    /** Called from `DeviceLink.teardown` (`kill()`): drops a recording in progress. */
    fun teardown() {
        val previous = synchronized(lock) {
            val old = job
            job = null
            active = null
            handled.clear()
            old
        }
        previous?.cancel()
    }

    private inline fun safely(block: () -> Unit) {
        try {
            block()
        } catch (_: Throwable) {
        }
    }

    /** Tests only. */
    internal fun __resetForTesting() {
        teardown()
        now = { SystemClock.uptimeMillis() }
        wallNow = { System.currentTimeMillis() }
        toaster = { DeviceLink.toaster(it) }
        api = { DeviceLink.recordingApi }
        tokenProvider = { DeviceLink.current?.token }
        scopeProvider = { DeviceLink.scopeProvider() }
        durationMs = GestureRecorder.DURATION_MS
    }
}
