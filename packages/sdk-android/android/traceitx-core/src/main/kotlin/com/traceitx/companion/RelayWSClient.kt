// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 Task 2 — Android relay WebSocket client.
//
// Mirrors `packages/sdk-ios/Sources/TraceItX/Companion/RelayWSClient.swift`
// (Plan 06.2-07). PATTERNS.md "RelayWSClient.kt (service, event-driven WS)"
// — OkHttp `WebSocketListener` shape; URL composition mirrors
// `MultipartUploader.kt` (HTTP→WS swap).
//
// Companion discovery (spec 2026-08-07): when the host supplies an `sdkKey`,
// EVERY connect attempt first announces over HTTPS (`CompanionAnnounce`) and
// opens `wss://<endpoint>/relay/tv/<ticket>` with the single-use ticket it
// gets back. Tickets are single-use with a 60s TTL, so nothing here may cache
// one across two attempts — there is deliberately no ticket-holding field.
// Announce failure of any kind falls back to plain `/relay/tv`: the device
// drops out of the dashboard's device list and keeps reporting exactly as it
// did before this feature existed.
//
// Lifecycle contract (T-06.2-08-02 mitigation):
//   • `ProcessLifecycleOwner.ON_STOP` -> `com.traceitx.companion.Companion.__setState(PhoneDisconnected)`
//     + `ws.cancel()` (proactive teardown; Android backgrounding does NOT
//     deliver onClosing/onFailure deterministically) + SUPERSEDE the in-flight
//     connect attempt. The supersede half is not optional: an announce is an
//     awaited HTTP call in front of every socket open, so `onStop` routinely
//     runs while no socket exists to cancel, and without the generation bump
//     that continuation opens one with the app in the background.
//   • `ON_START` -> reconnect via stored `device_token` if available, else a
//     FRESH announce + `pair_token` cold start. Never a resumed one: the
//     superseded ticket is single-use with a 60s TTL.
//   • Those callbacks fire only on TRANSITIONS, so `start()` additionally reads
//     the process's CURRENT lifecycle state once (on main, right before
//     `addObserver`) and supersedes itself when it is already backgrounded — a
//     fresh client built by a host that restarts companion from the background
//     would otherwise announce and dial with no transition ever arriving to
//     stop it.
//
// Reconnect backoff: [1s, 2s, 4s, 8s, 10s ceiling]. That schedule is the WHOLE
// reconnect policy: this file caps per-attempt delay at 10s and increments
// `reconnectAttempt`, and NOTHING caps the total. An earlier revision said
// "Plan 09 owns the 5-minute total-budget cap (passed to host via callback)".
// Plan 09 shipped; no budget and no such callback ever landed anywhere in the
// SDK, so the client retries at the 10s ceiling indefinitely against a relay
// that may never return.
//
// This DIVERGES from the web reference — `packages/sdk-react/src/companion/
// ws-client.ts` (see `TOTAL_RECONNECT_BUDGET_MS`) drops to `unpaired` and
// clears pairUrl/code/attachedUserName once the budget lapses. iOS
// (`RelayWSClient.swift`) matches Android here, and both diverge from web.
// Deliberately left as-is: a lobby TV has no user present to re-arm it, so
// retrying forever is the safer default until the product decides otherwise.
// Tracked as a cross-platform follow-up — do not read this as already done.
//
// SECURITY:
//   • `pair_token`, `device_token`, the announce `ticket` and the companion
//     `attribution_token` NEVER cross a log boundary (T-06.2-08-01
//     mitigation). Only the host-renderable `pair_url` (which embeds
//     pair_token) is written, into `Companion._pairUrl`. In particular this
//     file must never log a raw inbound frame: `pair.bonded` now carries
//     `attribution_token` and `companion_user`.
//   • Malformed RelayMessage frames are dropped via `runCatching` — the
//     decoder must not crash the SDK (T-06.2-08-03).

package com.traceitx.companion

import androidx.annotation.VisibleForTesting
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.traceitx.TraceItX
import com.traceitx.config.IngestEndpoint
import com.traceitx.protocol.generated.AttachChallenge
import com.traceitx.protocol.generated.AttachChallengeCleared
import com.traceitx.protocol.generated.CompanionName
import com.traceitx.protocol.generated.PairBonded
import com.traceitx.protocol.generated.PairCreated
import com.traceitx.protocol.generated.PairExpired
import com.traceitx.protocol.generated.PhoneDisconnected
import com.traceitx.protocol.generated.PreviewStart
import com.traceitx.protocol.generated.PreviewStop
import com.traceitx.protocol.generated.RelayMessage
import com.traceitx.protocol.generated.ReportCancelled
import com.traceitx.protocol.generated.ReportCompleted
import com.traceitx.protocol.generated.ReportFailed
import com.traceitx.protocol.generated.ReportRejected
import com.traceitx.protocol.generated.ReportRequest
import com.traceitx.protocol.generated.ReportSubmit
import com.traceitx.protocol.generated.ShotBinary
import com.traceitx.protocol.generated.ShotRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.atomic.AtomicReference

/**
 * Governs the `supportsAttachPin` capability computed at every announce call
 * site (spec 2026-08-19): `CUSTOM` always advertises it (the host owns
 * rendering); `BUILTIN` (the default) advertises it only when
 * `TraceItX.__attachPinUiInstalled` is set — i.e. `:traceitx-reporter-ui`'s
 * `CompanionPinPresenter` is actually on the classpath and running, so the
 * dashboard is never told a code will be shown when nothing will show it;
 * `OFF` never advertises it. Mirrors iOS `RelayWSClient.AttachPinUi`.
 */
enum class AttachPinUi { BUILTIN, CUSTOM, OFF }

class RelayWSClient(
    private val client: OkHttpClient,
    /**
     * Relay base URL. Defaults to the build-time-baked [IngestEndpoint.url] —
     * release AAR points at prod, debug AAR at TRACEITX_DEV_INGEST_URL.
     * The constructor parameter is kept (with default) as a test seam only.
     */
    private val baseUrl: String = IngestEndpoint.url,
    /**
     * Scheduler injection seam — production posts to the main looper;
     * tests substitute a synchronous executor. Default impl uses
     * `android.os.Handler(Looper.getMainLooper())`. Held as a lambda so
     * the test seam doesn't drag the Looper shadow into JVM unit tests.
     */
    private val scheduler: (delayMs: Long, action: () -> Unit) -> Unit = ::defaultScheduler,
    /**
     * The host's TraceItX key (`TraceItXConfig.sdkKey`). Supply it to make
     * this device discoverable from the dashboard; omit it and NO HTTP call
     * is made at all — the client goes straight to plain `/relay/tv`,
     * byte-identical to pre-companion behaviour. Companion discovery is
     * opt-in; reporting never depends on it. SECURITY: never log.
     */
    private val sdkKey: String? = null,
    /**
     * Optional human label sent with each announce (e.g. "Lobby TV").
     * Length-capped server-side.
     */
    private val deviceLabel: String? = null,
    /**
     * Resolves the announce `device` identity block (naming spec
     * 2026-08-24) — `CompanionDeviceFacts.current(context, explicit)`
     * wrapped as a suspend thunk so the facade can defer the `Context`
     * capture to construction time without this class taking one itself.
     * Awaited inside [beginConnect]'s announce launch on every attempt
     * (mirrors [deviceLabel] and [supportsAttachPinCapability] being
     * recomputed per attempt); a thrown exception or a null resolution both
     * just omit the `device` block from THAT attempt's announce body —
     * device-identity failing must never cost the device its reporting, the
     * same rule [CompanionAnnounce] itself is built around. `null` (the
     * default) skips the seam entirely and announces with no device block,
     * byte-identical to before this feature.
     */
    private val deviceProvider: (suspend () -> AnnounceDevice?)? = null,
    /**
     * How this device advertises attach-PIN support at announce time (spec
     * 2026-08-19) — see [AttachPinUi]'s doc comment for the capability rule.
     * Defaults to [AttachPinUi.BUILTIN], matching a host that has done
     * nothing special: the capability is then gated on whether
     * `:traceitx-reporter-ui`'s presenter actually installed itself.
     */
    private val attachPinUi: AttachPinUi = AttachPinUi.BUILTIN,
    /**
     * Reads the host process's CURRENT lifecycle state. Production reads
     * `ProcessLifecycleOwner`; [start] consults it so a client started while
     * the process is ALREADY backgrounded supersedes itself — the observer
     * callbacks only ever fire on a transition.
     *
     * Test seam because a JVM/Robolectric process has no real foreground:
     * measured, `ProcessLifecycleOwner.get().lifecycle.currentState` there is
     * `INITIALIZED` forever, which is neither "foreground" nor "background".
     * See [start] for why INITIALIZED deliberately fails OPEN.
     *
     * Called on the MAIN thread only (inside [start]'s `runOnMain`), which is
     * the thread `LifecycleRegistry` is written from.
     */
    private val processLifecycleState: () -> Lifecycle.State = {
        ProcessLifecycleOwner.get().lifecycle.currentState
    },
    /**
     * Task 11 review round 2, design correction (c) — test seam. Production
     * leaves this null and [previewSession] below constructs a REAL
     * `CompanionPreviewSession`. `RelayWSClientTest` overrides it with a
     * recording double implementing [CompanionPreviewSessionApi] so the
     * ROUTING (which incoming frame calls which session method, with which
     * arguments) is directly assertable without driving the real capture
     * loop's async timing through Robolectric's paused main Looper.
     */
    @VisibleForTesting
    internal val previewSessionForTesting: CompanionPreviewSessionApi? = null,
    /**
     * Config for the capture-excluded companion name badge
     * (`CompanionBadge.kt`, naming spec 2026-08-24 Task 6) — identification
     * only, never a privacy mitigation (see that file's header). Captured
     * ONCE here (first-client-wins, mirroring web and iOS's
     * `RelayWSClient(companionBadge:)`): change it by building a fresh
     * `RelayWSClient`, not by mutating a running one.
     */
    companionBadge: CompanionBadgeOptions = CompanionBadgeOptions(),
) : DefaultLifecycleObserver {

    private val ws = AtomicReference<WebSocket?>(null)

    /**
     * The [CompanionBadgeOptions] this client was constructed with, stored
     * only so a test can assert badge wiring (enabled/position) without a
     * live UI thread to observe [badge] itself. External review, finding N3:
     * `TraceItX.startCompanion()` wires this from `TraceItXConfig` — this
     * seam is what proves that config actually reached the constructed
     * client, mirroring the file's existing `ForTesting` seam idiom.
     */
    @VisibleForTesting
    internal val companionBadgeOptionsForTesting: CompanionBadgeOptions = companionBadge

    /**
     * Capture-excluded companion name badge (naming spec 2026-08-24 Task 6)
     * — identification only, see `CompanionBadge.kt`'s header. ALWAYS
     * constructed now (plan 2026-08-25): the dashboard can force-enable the
     * badge over an inline `companionBadge.enabled = false` — see
     * `CompanionBadge.resolvedEnabled()` — so a null-when-disabled badge
     * here would have nothing for that server override to ever act on.
     * `CompanionBadge` owns its own StateFlow subscription (now itself
     * unconditional, for the same reason), so construction here is
     * fire-and-forget: nothing else in this file needs to drive it, only
     * tear it down in [stop].
     */
    private val badge: CompanionBadge = CompanionBadge(companionBadge)

    /**
     * Non-null exactly when the host supplied an SDK key. Its presence is
     * what turns the ticketed path on. Holds no ticket — `announce(label)`
     * is called fresh on every connect attempt, because the server burns the
     * ticket on the handshake and a cached one would close 4004 forever.
     */
    private val announcer: CompanionAnnounce? = sdkKey?.let {
        CompanionAnnounce(client = client, baseUrl = baseUrl, sdkKey = it)
    }

    /**
     * Runs the announce hop off the caller's thread. `SupervisorJob` so one
     * failed attempt can't poison later ones. Attempts are superseded by
     * [connectGeneration] rather than by cancellation, so this scope is never
     * cancelled — `stop()` followed by `start()` is a supported lifecycle.
     */
    private val announceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Guards [connectGeneration], [reconnectArmedForGeneration],
     *  [connectInFlight] and [isClosed], and serialises socket installation
     *  in [openSocket] against them. */
    private val lock = Any()

    /**
     * Monotonic connect-attempt counter. Every entry into [beginConnect]
     * claims the next value; [stop] bumps it too. An announce whose
     * generation is no longer current lost the race (a newer reconnect
     * superseded it, or the host stopped the client) and must drop silently
     * rather than open a second socket — the announce hop is up to 5s wide,
     * so the window is real, and two sockets mean two rows for one device in
     * the dashboard.
     */
    private var connectGeneration: Long = 0L

    /**
     * The [connectGeneration] a reconnect timer is currently armed for, or
     * null when none is.
     *
     * A single socket drop signals TWICE within ~ms — `onClosing` and
     * `onFailure` — and both describe the SAME generation, so the second is
     * deduped. That is what stops one drop from announcing twice, spending
     * two single-use tickets and listing the same device in the dashboard
     * twice.
     *
     * Scoped to a generation rather than a bare flag: a bare flag left set by
     * a superseded attempt would swallow a genuinely new drop, and a stale
     * timer would later fire into [beginConnect] and replace a healthy
     * connection.
     */
    private var reconnectArmedForGeneration: Long? = null

    /**
     * True while a connect attempt has claimed a generation but not yet
     * resolved to a socket. During the announce hop no socket is installed,
     * so `ws.get() != null` is NOT a usable "already connecting" test — see
     * [onStart], whose whole job is to avoid opening a second socket.
     */
    private var connectInFlight: Boolean = false

    /** Set by [stop]; makes every in-flight attempt and armed timer drop. */
    private var isClosed: Boolean = false

    /**
     * True between [onStop] and [onStart] — i.e. while the process is in the
     * background.
     *
     * Backgrounding must SUPERSEDE whatever connect attempt is in flight, not
     * merely cancel an installed socket. The announce hop is an awaited HTTP
     * call sitting in front of every socket open (including every reconnect),
     * so for seconds at a time there is no socket for [onStop] to cancel — and
     * the continuation would sail past `isAttemptCurrent` and open a socket
     * with the process still backgrounded, leaving the device listed in the
     * dashboard and able to receive capture requests with no UI to serve them.
     * [onStop] therefore bumps [connectGeneration] exactly as [stop] does, and
     * this flag stops any LATER attempt (a host [start]) from composing a new
     * one while the state persists.
     *
     * Foregrounding clears it and announces FRESH: the superseded ticket is
     * single-use with a 60s TTL, so there is nothing to resume.
     */
    private var isBackgrounded: Boolean = false

    /** Stored on `pair.bonded` for reconnect; cleared on `pair.expired` /
     *  close codes 4001..4004 (auth/permanent-rejection family). */
    @Volatile
    private var deviceToken: String? = null

    /**
     * Companion attribution (spec 2026-08-07) — captured off `pair.bonded`
     * when the relay populated it (dashboard-initiated attach only), then
     * overwritten by any fresher token riding a `report.request`. Rides the
     * ingest POST as `X-TX-Companion-Attribution` and goes nowhere else.
     * SECURITY: never log.
     */
    @Volatile
    private var attributionToken: String? = null

    @Volatile
    private var reconnectAttempt: Int = 0

    /**
     * Plan 06.2-13 Task 3 — single-buffered correlation_id for the D-05
     * submit→binary wire pairing. Set on `report.submit` text frame,
     * read+cleared on the very next binary frame. Mirrors iOS
     * RelayWSClient.pendingSubmitCorrelationId. One in-flight submit at a
     * time (matches SPEC: "one report at a time per pair").
     */
    @Volatile
    private var pendingSubmitCorrelationId: String? = null

    /**
     * Set by a `shot.binary {shot_id}` marker: the NEXT binary frame carries
     * that shot's baked image rather than the report's primary screenshot.
     *
     * The phone sends `report.submit` → primary binary → (`shot.binary` →
     * binary)* — so the marker is what disambiguates, and the protocol chose a
     * marker over positional counting precisely so the device never has to
     * infer which image belongs to which id.
     */
    private var pendingShotBinary: Pair<String, String>? = null

    /**
     * Forgets every partially-received submit: the pending-submit binding, the
     * `shot.binary` binding, and the bridge's half-filled part buffers.
     *
     * The `shot.binary` binding is the dangerous one. It says "the NEXT binary
     * belongs to shot X", and it outlives the phone leg — so a phone that
     * dropped between the marker and its payload left the binding armed, and
     * the next report's PRIMARY binary was routed into that dead shot instead.
     * That report then waits forever for a primary that already arrived.
     */
    /**
     * Installed once: every report that ends — completed, failed, rejected,
     * cancelled, or superseded — drops that report's shot stash.
     *
     * This lives on `Companion.__finishReport` rather than on this class's
     * `send()` because `CompanionCaptureBridge` writes its terminal frames
     * straight onto the raw WebSocket, so the client's send never sees them.
     */
    init {
        // At construction, not in `start()`: the hook must be live for any
        // report this client can serve, and tests drive `listener.onMessage`
        // directly without ever starting a socket.
        installReportEndedHook()
    }

    private fun installReportEndedHook() {
        com.traceitx.companion.Companion.__onReportEnded = { corrId ->
            previewSession.clearStashFor(corrId)
        }
    }

    private fun resetSubmitFraming() {
        // Bumped synchronously here, so a capture past its last suspension
        // point still sees that authorisation ended. See [CompanionAuthEpoch].
        CompanionAuthEpoch.invalidate()
        val endedCapture = CompanionCaptureBridge.takeCaptureFor(this)
        if (endedCapture != null) android.os.Handler(android.os.Looper.getMainLooper())
            .post { endedCapture.cancel() }
        pendingSubmitCorrelationId = null
        pendingShotBinary = null
        CompanionCaptureBridge.__dropPendingSubmits()
    }

    /**
     * Task 11 — live-preview session for this pair. [previewSessionForTesting]
     * (constructor param) lets tests substitute a recording double; production
     * leaves it null and gets a REAL `CompanionPreviewSession` wired to this
     * client's own [send]/[sendBinary] and to [CompanionCaptureBridge]'s two
     * capture seams. `capturePreview`/`captureShot` are passed through AS-IS
     * (both already return `PreviewCapture?`, nullable) — `CompanionPreviewSession`
     * itself turns a null into `capture_unavailable`, so no throwing adapter
     * is needed at this layer.
     *
     * There is deliberately no separate scope here for launching
     * `requestShot`/shot handling (round-1 shape had one, `Dispatchers.IO`) —
     * `CompanionPreviewSession.requestShot` launches on the session's OWN
     * single scope, which is what keeps a `preview.frame`+binary pair and a
     * `shot.assembled`+binary pair from ever interleaving on the wire
     * (task-11 review round 2, CRITICAL 3). A second scope here would
     * reintroduce exactly that race, and — round-1's actual bug — was never
     * cancelled by [stop] either, leaking a `CoroutineScope` per client
     * (task-11 review round 2, CRITICAL 2). [previewSession] itself now IS
     * torn down from [stop] (permanently, via `teardown()`) and from
     * [supersedeForBackground] (silently, resumable) — see both.
     */
    private val previewSession: CompanionPreviewSessionApi = previewSessionForTesting
        ?: CompanionPreviewSession(
            send = ::send,
            sendBinary = { bytes -> sendBinary(ByteString.of(*bytes)) },
            capturePreview = { CompanionCaptureBridge.__previewProvider?.invoke() },
            captureShot = { CompanionCaptureBridge.__shotCaptureProvider?.invoke() },
        )

    /**
     * `@JsonClassDiscriminator("type")` is declared on the codegen
     * sealed class itself (Plan 06.2-03 output), so `classDiscriminator`
     * here is redundant — kept explicit for parity with iOS client and
     * to fail-loud if codegen ever drops the annotation.
     */
    private val json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = false
        encodeDefaults = false
    }

    fun start() {
        // `Lifecycle.addObserver()` MUST run on the main thread (AndroidX
        // contract — throws IllegalStateException otherwise). RN's
        // `@ReactMethod` dispatch lands on a TurboModule worker, NOT main,
        // so callers cannot be expected to marshal for us. iOS has no
        // equivalent constraint; this is an Android-only paper cut.
        // The WebSocket open in `beginConnect()` is thread-safe and stays
        // on the caller's thread (the announce hop, when enabled, moves to
        // `Dispatchers.IO` and returns immediately).
        //
        // ORDER MATTERS: `addObserver` on an already-STARTED owner
        // synthesizes ON_START *inline* when we are already on the main
        // thread. Claiming the connect attempt first means that replay finds
        // `connectInFlight` set and no-ops, instead of racing a second
        // announce (two tickets, two sockets, two dashboard rows) against the
        // one below.
        synchronized(lock) { isClosed = false }
        beginConnect()
        runOnMain {
            // PR-fix 3 — a client STARTED while the process is already in the
            // background. [isBackgrounded] only ever flips on a TRANSITION,
            // and a host calling start() between ON_STOP and the next ON_START
            // never produces one. This is the ordinary RN path, not an exotic
            // one: `stopCompanion()` drops the client and `startCompanion()`
            // builds a FRESH RelayWSClient whose flag initialises to false, so
            // every session started from a backgrounded process would announce
            // and dial, with nothing to correct it until a full
            // background/foreground cycle.
            //
            // The read belongs HERE — in the block that already has to be on
            // the main thread for `addObserver`, and immediately before it.
            // start() stays synchronous, and the claim-the-attempt-before-
            // addObserver ordering above is untouched: when the owner IS
            // started this does nothing, so the synthesized ON_START still
            // finds `connectInFlight` set and still no-ops.
            //
            // CREATED (attached, backgrounded) supersedes. INITIALIZED does
            // NOT: it means the process observer was never attached at all,
            // which no ordinary app shows (androidx-startup attaches it before
            // Application.onCreate) but a host that disabled that initializer
            // would show forever. Failing OPEN there keeps companion working
            // exactly as it does today instead of silently disabling it — and
            // it is the state a JVM/Robolectric process reports, which is why
            // [processLifecycleState] is a seam.
            val state = processLifecycleState()
            if (state != Lifecycle.State.INITIALIZED &&
                !state.isAtLeast(Lifecycle.State.STARTED)
            ) {
                // Deliberately NOT `Companion.__setState(PhoneDisconnected)`:
                // no phone was ever connected on this path. Only the connect
                // machinery is superseded.
                supersedeForBackground()
            }
            ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        }
    }

    fun stop() {
        // The socket is dying here regardless of whether it was ever open —
        // same "server deleted the pair on this TV-socket close, so no
        // cleared frame can ever arrive" reasoning as [scheduleReconnect]
        // below (spec 2026-08-19 review finding 2).
        com.traceitx.companion.Companion.__setAttachChallenge(null)
        // External review, finding N2 — a stopped client's pair no longer
        // exists, so any dashboard attach it carried ends with it. Mirrors
        // the PairCreated/PairExpired branches above (and the web
        // ws-client's own three attachedUserName-clearing boundaries):
        // resolvedName is deliberately left alone — it's device identity,
        // not attach state.
        com.traceitx.companion.Companion.__setAttachedUserName(null)
        // Symmetric main-thread marshaling for `removeObserver` (same
        // AndroidX requirement as `addObserver` above).
        runOnMain { ProcessLifecycleOwner.get().lifecycle.removeObserver(this) }
        synchronized(lock) {
            isClosed = true
            // Supersede any in-flight announce and any armed reconnect timer:
            // both drop instead of resurrecting a socket the host just closed.
            connectGeneration += 1
            reconnectArmedForGeneration = null
            connectInFlight = false
        }
        ws.getAndSet(null)?.cancel()
        deviceToken = null
        // SECURITY: never log. The companion identity dies with the session.
        attributionToken = null
        reconnectAttempt = 0
        // Task 11 review round 2, CRITICAL 2 — this client is being torn
        // down for good (the host builds a FRESH RelayWSClient for its next
        // `start()`, per this file's header), so the preview session dies
        // with it: permanently (`teardown()`, not `stopSilently()`), or the
        // capture loop keeps reading the user's screen for up to 2 minutes
        // against a socket that no longer exists.
        previewSession.teardown()
        resetSubmitFraming()
        // The badge dies with the client that owns it, exactly like
        // previewSession above — see CompanionBadge.teardown()'s doc.
        badge.teardown()
    }

    private fun runOnMain(block: () -> Unit) {
        val mainLooper = android.os.Looper.getMainLooper()
        if (android.os.Looper.myLooper() === mainLooper) {
            block()
        } else {
            android.os.Handler(mainLooper).post(block)
        }
    }

    fun send(message: RelayMessage) {
        // The device is the sender of every terminal report frame, so this is
        // the one choke point that sees a report end however it ended. The
        // shot stash exists only for the report being assembled; holding
        // report-grade screenshots of the user's screen past that point is the
        // same failure the preview's own time cap exists to prevent, and
        // nothing else cleared it (pair-loss and backgrounding only).
        when (message) {
            is ReportCompleted, is ReportFailed, is ReportRejected -> previewSession.clearStash()
            else -> Unit
        }
        ws.get()?.send(json.encodeToString(RelayMessage.serializer(), message))
    }

    fun sendBinary(bytes: ByteString) {
        ws.get()?.send(bytes)
    }

    // ---------------- Reconnect scheduling ----------------

    /**
     * Per-attempt backoff in ms. Plateaus at the ceiling once `attempt >=
     * BACKOFF_STEPS.lastIndex`, and keeps returning that ceiling forever —
     * nothing wraps a total budget around this and nothing surfaces a
     * callback when retries "run out", because they never do. (An earlier
     * revision of this comment attributed both to Plan 09; Plan 09 shipped
     * without either. See the file header.)
     *
     * `internal` for `@VisibleForTesting` — testing the delay table
     * directly is cleaner than driving the Robolectric Looper.
     */
    @VisibleForTesting
    internal fun computeBackoff(attempt: Int): Long =
        BACKOFF_STEPS[minOf(attempt, BACKOFF_STEPS.lastIndex)]

    @VisibleForTesting
    internal fun scheduleReconnect() {
        // The server deletes the pair on ANY TV-socket close, not only the
        // terminal-close-code cases handled in `onClosing` above — so no
        // `attach.challenge.cleared` frame can ever arrive once we're here,
        // and a retained challenge would be permanently stale. `onClosing`'s
        // terminal branch already clears it explicitly before calling this
        // function (redundant with the line below, harmless); this is what
        // covers `onClosing`'s non-terminal branches and `onFailure`, both of
        // which call this function directly without clearing first (spec
        // 2026-08-19 review finding 2; mirrors iOS `scheduleReconnect()`).
        com.traceitx.companion.Companion.__setAttachChallenge(null)
        val delay: Long
        val armedGeneration: Long
        synchronized(lock) {
            if (isClosed) return
            // One drop, one reconnect: a timer already armed for THIS attempt
            // makes the drop's second signal (onClosing then onFailure, ~ms
            // apart) redundant. Without this each drop announces twice and the
            // dashboard grows a duplicate row for one device.
            if (reconnectArmedForGeneration == connectGeneration) return
            delay = computeBackoff(reconnectAttempt)
            reconnectAttempt++
            armedGeneration = connectGeneration
            reconnectArmedForGeneration = armedGeneration
        }
        scheduler(delay) {
            synchronized(lock) {
                // Fire only if this timer's attempt still owns the client. A
                // newer reconnect or a `stop()` superseded it otherwise —
                // firing anyway would replace a healthy connection and spend
                // another single-use ticket to do it. The marker is left alone
                // in that case: it belongs to whoever armed most recently.
                if (isClosed || armedGeneration != connectGeneration) return@scheduler
                reconnectArmedForGeneration = null
            }
            if (deviceToken != null) connectWithDeviceToken() else beginConnect()
        }
    }

    // ---------------- Connect flavours ----------------

    /**
     * The ONE place a connect attempt is composed for the TV leg. Both entry
     * points call it: cold-start [start] and every [scheduleReconnect] retry
     * (plus the foreground [onStart] hook). Keeping them on one path is
     * load-bearing — the announce ticket is single-use, so a reconnect that
     * skipped the announce would open a ticketless socket and the device would
     * silently vanish from the dashboard after its first drop, never to
     * return.
     *
     * [connectWithDeviceToken] is the one other composer in this file. It is
     * unreachable on this leg (the relay never sends `device_token` to the TV)
     * and is kept only for the phone-side shape — but it opens a socket, so it
     * carries its own copy of the [isBackgrounded] guard below. "No socket may
     * open while the process is backgrounded" has to hold for every path that
     * installs one, not just the common one.
     */
    private fun beginConnect() {
        val generation: Long
        synchronized(lock) {
            // Nothing may compose a connect attempt while the process is
            // backgrounded. Every INTERNAL path here is already stopped by the
            // generation bump in [onStop]; this closes the remaining one, a
            // host calling [start] between ON_STOP and ON_START. Refusing costs
            // nothing: [onStart] connects on the way back, and it clears the
            // flag before it checks anything, so the client is never wedged.
            if (isBackgrounded) return
            connectGeneration += 1
            generation = connectGeneration
            connectInFlight = true
        }
        val announcer = this.announcer
        if (announcer == null) {
            // No SDK key — no HTTP call at all, exactly as before companion.
            try {
                openSocket(wsUrl(TV_PATH), generation)
            } finally {
                finishAttempt(generation)
            }
            return
        }
        announceScope.launch {
            try {
                // deviceProvider failures (or a null resolution) just omit
                // the `device` block from THIS attempt's announce body —
                // mirrors the web client's `deviceProvider().catch(() =>
                // null)` (ws-client.ts connectWithAnnounce).
                val device = runCatching { deviceProvider?.invoke() }.getOrNull()
                // Fresh ticket per attempt. Nothing retains `result` past this
                // scope; the next attempt announces again.
                val result = announcer.announce(deviceLabel, supportsAttachPinCapability(), device)
                // `stop()`, or a newer attempt, may have superseded this one
                // while the request was in flight. Checked BEFORE `__setCode`
                // so a losing attempt cannot publish its (already dead) code.
                if (!isAttemptCurrent(generation)) return@launch
                if (result == null) {
                    // Announce failed for ANY reason (offline, revoked key,
                    // 404 on an older server, timeout). Fall through to the
                    // plain, ticketless path: discovery is allowed to fail,
                    // reporting is not.
                    com.traceitx.companion.Companion.__setCode(null)
                    // resolvedName shares code's lifecycle — nulled on the
                    // same failure path; there is no successful announce to
                    // read one off.
                    com.traceitx.companion.Companion.__setResolvedName(null)
                    openSocket(wsUrl(TV_PATH), generation)
                    return@launch
                }
                com.traceitx.companion.Companion.__setCode(result.code)
                com.traceitx.companion.Companion.__setResolvedName(result.resolvedName)
                // SECURITY: the ticket rides the socket URL and is never logged.
                openSocket(wsUrl("$TV_PATH/${encodePathSegment(result.ticket)}"), generation)
            } finally {
                finishAttempt(generation)
            }
        }
    }

    /**
     * The `supportsAttachPin` value for THIS announce, per [attachPinUi]'s
     * capability rule (spec 2026-08-19, same rule as iOS's
     * `RelayWSClient.beginConnect`): `CUSTOM` always advertises it — the host
     * owns rendering and is asserting it exists; `BUILTIN` advertises it only
     * when `:traceitx-reporter-ui`'s presenter has actually installed itself
     * ([TraceItX.__attachPinUiInstalled]), so an app without that module on
     * the classpath never claims a capability nothing will render; `OFF`
     * never advertises it.
     */
    private fun supportsAttachPinCapability(): Boolean = when (attachPinUi) {
        AttachPinUi.CUSTOM -> true
        AttachPinUi.BUILTIN -> TraceItX.__attachPinUiInstalled
        AttachPinUi.OFF -> false
    }

    /**
     * Whether the attempt that claimed [generation] still owns the client.
     *
     * The single "is this still ours?" test in the file. The announce
     * continuation asks it about itself, and every listener callback asks it
     * about the attempt that created its socket ([RelayListener]) — frames
     * from, and failures of, a socket we already replaced must not touch state
     * or schedule anything, or our own supersede-cancel reads as a drop.
     * Applies to EVERY callback: a stale `onMessage` is the same bug wearing a
     * different hat.
     */
    private fun isAttemptCurrent(generation: Long): Boolean = synchronized(lock) {
        !isClosed && generation == connectGeneration
    }

    private fun finishAttempt(generation: Long) = synchronized(lock) {
        if (generation == connectGeneration) connectInFlight = false
    }

    /**
     * Creates the socket for an already-resolved URL. Split out so the
     * ticketed (async) and ticketless (sync) paths share one place that
     * touches [ws]. [generation] is re-checked here, under the same lock that
     * installs the socket, so the check and the install cannot be interleaved
     * by a competing attempt.
     *
     * The predecessor is cancelled AFTER the new socket is installed, never
     * before: OkHttp keeps a socket we merely stop referencing alive and
     * connected (a second live `/relay/tv` and a duplicate dashboard row),
     * and cancelling first would make our own supersede-cancel arrive at
     * `onFailure` while the predecessor still looks current — a drop signal
     * that would tear down the socket we just opened.
     *
     * `newWebSocket` runs OUTSIDE the lock, and deliberately so. It starts
     * connecting immediately, so its listener can be called back — on OkHttp's
     * dispatcher thread — before it returns, i.e. before anything here has had
     * a chance to store the socket. Two things follow:
     *
     *   • The callback must be attributable WITHOUT the stored reference.
     *     That is why the listener carries [generation] (see [RelayListener])
     *     instead of comparing identity against [ws]: an identity test reads
     *     the PREDECESSOR during that window, calls a genuine connect failure
     *     "not ours", and drops it — which used to leave a device that lost
     *     DNS/TLS/connect on the first packet stuck forever, with the dead
     *     socket installed a moment later and looking perfectly live to
     *     [onStart].
     *   • Holding the lock across the call would deadlock that callback the
     *     moment it needs the lock itself (it does — via [isAttemptCurrent]),
     *     with this thread waiting inside `newWebSocket` for the callback to
     *     return.
     *
     * The generation is therefore re-checked after creation, and a socket
     * whose attempt lost the race in the meantime is cancelled rather than
     * installed — the check and the install still happen under one lock hold,
     * so two competing attempts cannot interleave into a double install.
     */
    private fun openSocket(url: String, generation: Long) {
        val request = Request.Builder().url(url).build()
        val attemptListener = RelayListener(generation)
        synchronized(lock) {
            if (isClosed || generation != connectGeneration) return
            // Published before the socket exists so a test (and only a test)
            // can reach the listener that is about to be handed to OkHttp.
            currentListener = attemptListener
        }
        val socket = client.newWebSocket(request, attemptListener)
        var previous: WebSocket? = null
        var superseded = false
        synchronized(lock) {
            if (isClosed || generation != connectGeneration) {
                superseded = true
            } else {
                previous = ws.getAndSet(socket)
            }
        }
        if (superseded) socket.cancel() else previous?.cancel()
    }

    /**
     * Reconnect straight to `/relay/phone/reconnect/<device_token>`, skipping
     * the announce.
     *
     * Dead in practice on this leg: the server deliberately never sends
     * `device_token` to the TV (the relay service — "Don't leak the
     * device_token to the TV"), so [deviceToken] is always null here and every
     * real reconnect falls through to [beginConnect]. Left in place for the
     * phone-side shape.
     *
     * It still carries the background guard, because it composes a connect
     * attempt WITHOUT going through [beginConnect] — the one place that guard
     * used to live. The generation check in [scheduleReconnect]'s timer is not
     * a substitute: it releases the lock before calling here, so backgrounding
     * in between would find a freshly claimed, perfectly current generation
     * and dial. Reading [isBackgrounded] under the SAME lock hold that claims
     * the generation is what closes that window.
     *
     * `internal` so a test can reach it: that race cannot be staged
     * deterministically through the public surface (see
     * `aDeviceTokenReconnectOpensNoSocketWhileBackgrounded`).
     */
    @VisibleForTesting
    internal fun connectWithDeviceToken() {
        val dt = deviceToken ?: return beginConnect()
        val generation: Long
        synchronized(lock) {
            if (isClosed || isBackgrounded) return
            connectGeneration += 1
            generation = connectGeneration
        }
        // SECURITY: device_token rides the URL path on reconnect — TLS
        // protects it on wire. Never logged.
        openSocket(wsUrl("/relay/phone/reconnect/$dt"), generation)
    }

    private fun wsUrl(path: String): String {
        val swapped = when {
            baseUrl.startsWith("https://") -> "wss://" + baseUrl.removePrefix("https://")
            baseUrl.startsWith("http://") -> "ws://" + baseUrl.removePrefix("http://")
            else -> baseUrl
        }
        return swapped.trimEnd('/') + path
    }

    // ---------------- WebSocketListener ----------------

    /**
     * The listener for ONE connect attempt, stamped with the [generation] that
     * attempt claimed.
     *
     * Generation rather than socket identity, because identity is not
     * available early enough: `client.newWebSocket(…)` starts connecting the
     * moment it is called and can deliver `onFailure` (an immediate DNS, TLS
     * or connection-refused error) before it has returned the reference
     * [openSocket] would store. A listener asking `ws.get() === webSocket` in
     * that window reads the PREDECESSOR, calls a real failure stale, and
     * returns without scheduling a reconnect — after which the dead socket is
     * installed and looks live to every later guard, `onStart`'s included.
     * The generation is known BEFORE the socket exists, so there is no window
     * at all. (iOS solves the same problem the same way, by stamping
     * `taskDescription` — see `RelayWSClient.swift`'s `isCurrentTask`.)
     *
     * One generation opens at most one socket, so this is exactly as precise
     * as identity was once the socket is installed: [beginConnect] and
     * [connectWithDeviceToken] each claim a generation and call [openSocket]
     * once, and every supersede — a newer attempt, [stop], or
     * [supersedeForBackground] — bumps the generation, which is what keeps our
     * own supersede-cancel from reading as a drop.
     */
    internal inner class RelayListener(private val generation: Long) : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isAttemptCurrent(generation)) return
            reconnectAttempt = 0
            android.util.Log.i("TraceItX.companion", "ws.onOpen — code=${response.code}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isAttemptCurrent(generation)) return
            // SECURITY: the raw frame is NOT logged. `pair.bonded` carries
            // `attribution_token` and `companion_user` on a companion attach,
            // and `pair.created` carries `pair_token` — none of which may
            // reach logcat. Only the decoded discriminator is logged below.
            val msg = runCatching {
                json.decodeFromString(RelayMessage.serializer(), text)
            }.onFailure {
                // SECURITY: the exception TYPE only. kotlinx's decoding
                // messages quote the offending input, which on this socket is
                // a frame that may carry `pair_token` / `attribution_token` —
                // and `ignoreUnknownKeys = false` means a server that adds a
                // field lands here with the whole frame in hand.
                android.util.Log.w(
                    "TraceItX.companion",
                    "ws.onMessage decode FAILED: ${it.javaClass.simpleName}",
                )
            }.getOrNull() ?: return  // T-06.2-08-03: drop malformed frames silently

            android.util.Log.i("TraceItX.companion", "ws.onMessage parsed=${msg::class.simpleName}")
            when (msg) {
                is PairCreated -> {
                    // SECURITY: pair_token embedded in URL only — never logged separately.
                    com.traceitx.companion.Companion.__setPairUrl(buildPairUrl(msg.pairToken))
                    // External review, finding N2 — mirrors the web ws-client's
                    // `pair.created` handler: the server destroys the pair
                    // record on ANY TV-socket close (terminal or not), so a
                    // `pair.created` reaching us here is by construction an
                    // UNBONDED pair — a rebond, if any, arrives as its own
                    // `pair.bonded`. Any attach state retained from a previous
                    // bond on an earlier connection is therefore stale and
                    // must not survive: without this, a non-terminal close
                    // that silently killed the bond leaves the badge claiming
                    // the old user is still attached indefinitely.
                    // resolvedName is deliberately left alone — it's device
                    // identity, not attach state.
                    com.traceitx.companion.Companion.__setAttachedUserName(null)
                    com.traceitx.companion.Companion.__setState(CompanionState.Unpaired)
                    android.util.Log.i("TraceItX.companion", "pair.created → state=Unpaired, pairUrl=set")
                }
                is PairBonded -> {
                    deviceToken = msg.deviceToken
                    // Companion attach (spec 2026-08-07): both
                    // `attribution_token` and `companion_user` are OPTIONAL
                    // and both ABSENT on an ordinary QR bond. Assign
                    // unconditionally — resetting to null when the frame does
                    // not carry them is what stops a later ordinary bond on
                    // the same session from inheriting a stale companion
                    // identity from an earlier dashboard attach.
                    // SECURITY: never log msg.attributionToken.
                    attributionToken = msg.attributionToken
                    com.traceitx.companion.Companion.__setAttachedUserName(
                        msg.companionUser?.displayName,
                    )
                    // Keep pairUrl intact on bond — it's nulled only on socket
                    // close (onClosing terminal codes below). The pair token is
                    // single-use server-side so a retained URL is harmless.
                    // Hosts drive QR teardown off `state == Paired` — `state` is
                    // the reliably-delivered signal (incl. across the RN native
                    // bridge), so it's the single source of truth for QR
                    // visibility.
                    com.traceitx.companion.Companion.__setState(CompanionState.Paired)
                    android.util.Log.i("TraceItX.companion", "pair.bonded → state=Paired, pairUrl=kept")
                }
                is PairExpired -> {
                    // Drop the dead token + return to Unpaired, but keep pairUrl
                    // (cleared only on socket close). A fresh pair.created
                    // overwrites it if the relay re-issues.
                    deviceToken = null
                    // External review, finding N2 — mirrors the web ws-client's
                    // `pair.expired` handler: a released bond ends the attach —
                    // the badge (gated on attachedUserName) must not survive a
                    // detach. resolvedName is deliberately kept: it's device
                    // identity, not attach state.
                    com.traceitx.companion.Companion.__setAttachedUserName(null)
                    com.traceitx.companion.Companion.__setState(CompanionState.Unpaired)
                    android.util.Log.i("TraceItX.companion", "pair.expired → state=Unpaired, pairUrl=kept")
                    // Task 11 auto-stop trigger #4 — the pair this preview
                    // belonged to no longer exists; nobody is left to receive
                    // frames. stopSilently(), not stop(): there is no live
                    // pair to announce a preview.stop into.
                    previewSession.stopSilently()
                    previewSession.clearStash()
                    resetSubmitFraming()
                }
                is PhoneDisconnected -> {
                    // Phone WS closed (browser tab close, network drop, app
                    // backgrounded). Keep device_token + pairUrl intact —
                    // server holds the pair record open for 5 minutes; if the
                    // phone reconnects we'll get a fresh `pair.bonded` and
                    // flip back to Paired. If the grace window elapses we'll
                    // get `pair.expired` and fully reset.
                    com.traceitx.companion.Companion.__setState(CompanionState.PhoneDisconnected)
                    android.util.Log.i("TraceItX.companion", "phone.disconnected → state=PhoneDisconnected")
                    // Task 11 auto-stop trigger #3 — nobody left to send
                    // frames to; stop capturing the screen NOW rather than
                    // running out the 2-minute cap against a dead session.
                    previewSession.stopSilently()
                    previewSession.clearStash()
                    resetSubmitFraming()
                }
                is PreviewStart -> {
                    android.util.Log.i("TraceItX.companion", "preview.start corrId=${msg.correlationId}")
                    previewSession.start(msg.correlationId)
                }
                is PreviewStop -> {
                    // Phone-initiated stop (Task 11 auto-stop trigger #1): go
                    // quiet without echoing a stop frame back at the peer
                    // that just sent us one.
                    android.util.Log.i("TraceItX.companion", "preview.stop corrId=${msg.correlationId} reason=${msg.reason}")
                    previewSession.stopSilently()
                }
                is ShotRequest -> {
                    val rect = msg.rect?.let { NormalizedRect(x = it.x, y = it.y, w = it.w, h = it.h) }
                    // `msg.correlationId` — the id carried on THIS frame —
                    // not read back off session state. Task 11 review round
                    // 2, CRITICAL 1: the old shape read the session's own
                    // (possibly already-nulled) correlationId instead, and a
                    // `shot.request` immediately followed by `preview.stop`
                    // (a real ordering — the phone's snapshot flow does
                    // exactly this) dropped the shot silently — no
                    // `shot.assembled`, no `shot.failed`, no retry
                    // affordance. `requestShot` launches on the session's OWN
                    // scope (see its doc) rather than a separate one here —
                    // off the WS reader thread AND serialized against the
                    // preview loop's own sends.
                    previewSession.requestShot(msg.correlationId, msg.shotId, rect)
                }
                is ReportRequest -> {
                    // Serial-report invariant (SPEC "one report at a time per
                    // pair"): read the state BEFORE setting it, and before
                    // touching ANY session state. An overlapping report.request
                    // mid-submit would wipe the frozen snapshot the in-flight
                    // composer is about to consume, so reject it outright — no
                    // token write, no state change, no dispatch to the bridge.
                    //
                    // The rejection comes first for the token's sake, not just
                    // for tidiness. The session token used to be overwritten on
                    // the line above this check, so a rejected request handed
                    // its own single-use token to the session — where the NEXT
                    // request (if it carried none, i.e. an older relay) would
                    // fall back to it. That token was minted for a report that
                    // never ran and is spent on first use, so the next real
                    // report would attribute to nobody. The branch's invariant
                    // is that a report carries the token minted for IT.
                    // SECURITY: never log.
                    if (com.traceitx.companion.Companion.state.value == CompanionState.ReportInProgress) {
                        android.util.Log.i(
                            "TraceItX.companion",
                            "report.request corrId=${msg.correlationId} REJECTED — report already in flight",
                        )
                        webSocket.send(json.encodeToString(
                            RelayMessage.serializer(),
                            ReportRejected(correlationId = msg.correlationId, reason = "in_flight"),
                        ))
                        return
                    }
                    // The relay mints a FRESH attribution token on every
                    // `report.request` for an attached (companion) pair — a
                    // bond-time token goes stale after 10 minutes while a
                    // companion session can stay attached for hours. Always
                    // prefer the newest token seen: an older server, or an
                    // ordinary QR pair (which never gets one), sends none, and
                    // the bond-time value — possibly null — is simply left in
                    // place. SECURITY: never log.
                    msg.attributionToken?.let { attributionToken = it }
                    // ATTRIBUTION SNAPSHOT (PR-fix 1). The token that credits
                    // a report must be the one that belonged to THIS
                    // `report.request` — not whatever the live session happens
                    // to hold minutes later, when the submit finally builds its
                    // HTTP request. Between the two, the same session can
                    // legitimately re-bond to a DIFFERENT dashboard user
                    // (`releasePairBond` bumps `bondGeneration` and the relay
                    // sends a fresh `pair.bonded` with the new user's token
                    // down this same TV socket), and the host can
                    // stop/startCompanion under an in-flight submit. Reading
                    // late meant the older report consumed the newer user's
                    // single-use token: the report was credited to them AND
                    // their own next report lost its attribution.
                    //
                    // Read the frame's own token first, falling back to the
                    // session's current value so an older relay (which sends
                    // none) still attributes off the bond-time token. Taking
                    // `msg.attributionToken` directly rather than re-reading
                    // the field keeps this correct even if `stop()` nulls the
                    // field concurrently. SECURITY: never log.
                    val reportAttribution = msg.attributionToken ?: getCompanionAttribution()
                    // `__beginReport`, not `__setState(ReportInProgress)`: the
                    // state is claimed BY this correlation_id, and only a
                    // completion carrying the same one may give it back
                    // (PR-fix 7).
                    com.traceitx.companion.Companion.__beginReport(msg.correlationId)
                    android.util.Log.i("TraceItX.companion", "report.request corrId=${msg.correlationId} → state=ReportInProgress")
                    CompanionCaptureBridge.onReportRequest(
                        msg.correlationId,
                        webSocket,
                        reportAttribution,
                        clientOwner = this@RelayWSClient,
                    )
                }
                is ReportSubmit -> {
                    // Plan 06.2-13 Task 3 — stash correlation_id so the
                    // immediately-following binary frame (baked PNG, D-05)
                    // can be routed to the same bridge submit. Cleared on
                    // binary arrival.
                    pendingSubmitCorrelationId = msg.correlationId
                    android.util.Log.i("TraceItX.companion", "report.submit corrId=${msg.correlationId}")
                    CompanionCaptureBridge.onReportSubmit(msg, webSocket)
                }
                is ReportCancelled -> {
                    // Phone-side cancel: user tapped Discard in the reporter
                    // SPA after the TV had already entered ReportInProgress.
                    // Drop any in-flight binary stash for the same
                    // correlation_id so a future submit can't accidentally
                    // pair with a stale capture, then return to Paired so
                    // the host UI clears its "report in progress" indicator.
                    if (pendingSubmitCorrelationId == msg.correlationId) {
                        pendingSubmitCorrelationId = null
                    }
                    // A cancel for a report a re-bond already superseded must
                    // discard NOTHING — the frozen snapshot now belongs to the
                    // live report — and must not clear its state either, so
                    // both live inside `__finishReport`'s claim (PR-fix 7).
                    //
                    // ReplaySession is main-thread-confined; this listener
                    // runs on the OkHttp WS reader thread and the phone's
                    // submit arrives much later, so a posted cancel always
                    // lands after any in-flight freeze.
                    // The report this stash was captured for is over: drop the
                    // report-grade pixels with it. Only pair-loss and
                    // backgrounding cleared the stash before, so a cancelled
                    // report left full-resolution screenshots of the user's
                    // screen resident until some LATER report happened to start
                    // under a new correlation id.
                    // No explicit stash clear here: `__finishReport` below
                    // fires the report-ended hook, which drops this
                    // correlation's captures. Clearing here too would be a
                    // second, redundant pass — and an UNCONDITIONAL clear (the
                    // original shape) let a delayed cancellation from an older
                    // report delete the CURRENT report's captures, after which
                    // a re-crop silently captured the current screen under the
                    // old shot id.
                    val endedCapture = CompanionCaptureBridge.captureFor(msg.correlationId)
                    val ended = com.traceitx.companion.Companion.__finishReport(
                        msg.correlationId,
                    ) {
                        android.os.Handler(android.os.Looper.getMainLooper())
                            .post { endedCapture?.cancel() }
                    }
                    android.util.Log.i(
                        "TraceItX.companion",
                        "report.cancelled corrId=${msg.correlationId} ended=$ended",
                    )
                }
                is ShotBinary -> {
                    // Phone → device, at submit time: binds the NEXT binary to
                    // this shot_id. Before this the marker was unhandled and
                    // every extra shot's bytes were dropped, so a multi-shot
                    // report uploaded only the primary screenshot and still
                    // reported success — silent loss of evidence the user had
                    // explicitly captured.
                    pendingShotBinary = msg.correlationId to msg.shotId
                }
                is AttachChallenge -> {
                    // Dashboard member requested attach (spec 2026-08-19).
                    // SECURITY: never log msg.code — display on-device IS the
                    // feature; logcat is not the device screen.
                    com.traceitx.companion.Companion.__setAttachChallenge(
                        AttachChallengeInfo(
                            code = msg.code,
                            requestedByName = msg.requestedByName,
                            ttlMs = msg.ttlMs,
                        ),
                    )
                    android.util.Log.i("TraceItX.companion", "attach.challenge → pin surface shown")
                }
                is AttachChallengeCleared -> {
                    // reason is expired|attached|burned|superseded — every
                    // reason means "this PIN is no longer live", so all of
                    // them just clear it (mirrors iOS).
                    com.traceitx.companion.Companion.__setAttachChallenge(null)
                    android.util.Log.i(
                        "TraceItX.companion",
                        "attach.challenge.cleared reason=${msg.reason}",
                    )
                }
                is CompanionName -> {
                    // Device naming (spec 2026-08-24): resolved display name
                    // pushed after a dashboard rename. Mirror the web
                    // client's guard (ws-client.ts:318-327) — the generated
                    // data class accepts any string, so re-check 1...80 here
                    // rather than trust the wire. Out-of-range is silently
                    // ignored (defense-in-depth, matching the malformed-frame
                    // handling above): the server already validates length,
                    // so this only guards a stale/misbehaving peer.
                    if (msg.name.length in 1..80) {
                        com.traceitx.companion.Companion.__setResolvedName(msg.name)
                        android.util.Log.i("TraceItX.companion", "companion.name → resolvedName updated")
                    }
                }
                else -> {
                    android.util.Log.i("TraceItX.companion", "ws.onMessage IGNORED (unhandled discriminator) class=${msg::class.simpleName}")
                    // report.assembled / report.draft.update / report.completed /
                    // report.failed / report.rejected / preview.frame /
                    // shot.assembled / shot.failed are TV-emitted (this
                    // device sends them; see `previewSession` and
                    // `CompanionCaptureBridge` above) — TV-side does not
                    // RECEIVE them. shot.binary is DIFFERENT: it is
                    // phone-emitted, a per-shot marker the phone sends ahead
                    // of each extra shot's baked binary during a multi-shot
                    // `report.submit` (an earlier revision of this comment
                    // called it TV-emitted and unused — wrong on both counts;
                    // corrected by task-11 review round 2). It is genuinely
                    // UNHANDLED here, not because it doesn't apply to this
                    // leg, but because multi-shot submit ingestion on the
                    // device is out of Task 11's scope — it lands in this
                    // branch and is logged same as any other unhandled
                    // discriminator. Future protocol revisions MAY add more
                    // TV-bound branches; ignore silently for forward-compat
                    // (note: `ignoreUnknownKeys = false` only catches unknown
                    // FIELDS, not unknown DISCRIMINATORS — those still decode
                    // but land here).
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (!isAttemptCurrent(generation)) return
            android.util.Log.i("TraceItX.companion", "ws.onMessage(binary) bytes=${bytes.size}, pendingCorrId=$pendingSubmitCorrelationId")
            // Plan 06.2-13 Task 3 — phone→relay→TV binary frames ARE part
            // of the v1 protocol now: the phone sends the baked annotated
            // PNG as a binary frame immediately after `report.submit`
            // (D-05). Route by the single-buffered correlation_id stashed
            // when the submit text frame arrived. Mirrors iOS
            // RelayWSClient.handleBinary.
            // A `shot.binary` marker takes precedence: it was sent
            // immediately before these bytes and names the shot they belong to.
            val shotBinding = pendingShotBinary
            if (shotBinding != null) {
                pendingShotBinary = null
                CompanionCaptureBridge.onShotBinary(
                    shotBinding.first,
                    shotBinding.second,
                    bytes.toByteArray(),
                    webSocket,
                )
                return
            }
            val corrId = pendingSubmitCorrelationId
            pendingSubmitCorrelationId = null
            if (corrId == null) {
                android.util.Log.w("TraceItX.companion", "ws.onMessage(binary) DROPPED — no pending submit")
                // Binary without a preceding submit — silently dropped
                // (forward-compat: v1 protocol defines no other phone→TV
                // binary frames).
                return
            }
            CompanionCaptureBridge.onSubmitBinary(corrId, bytes.toByteArray(), webSocket)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // A close we caused by superseding this socket is not a drop —
            // see [RelayListener].
            if (!isAttemptCurrent(generation)) return
            android.util.Log.i("TraceItX.companion", "ws.onClosing code=$code, reason=$reason")
            // An ORDERLY close ends the authorisation exactly as a failure
            // does, and it is the more common one — `onFailure` is not
            // guaranteed to follow a clean close at all. Stopping only there
            // left capture running against a socket that had already gone.
            previewSession.stopSilently()
            previewSession.clearStash()
            resetSubmitFraming()
            when (code) {
                CLOSE_ALREADY_BONDED,
                CLOSE_PAIR_EXPIRED,
                CLOSE_GRACE_EXCEEDED,
                CLOSE_TOKEN_NOT_FOUND -> {
                    // Permanent rejections — socket is closing for good. Drop
                    // tokens + clear pairUrl (the one place we null it; parity
                    // with web ws-client.ts:290 / iOS didCloseWith) + return to
                    // Unpaired so the host re-pairs via a fresh QR.
                    deviceToken = null
                    // SECURITY: never log. The companion identity dies with
                    // the pair.
                    attributionToken = null
                    com.traceitx.companion.Companion.__setPairUrl(null)
                    // `code`, `attachedUserName`, and `resolvedName` share
                    // `pairUrl`'s lifecycle — cleared wherever it is. A stale
                    // display code (or name) would send the dashboard user
                    // chasing a row that no longer exists.
                    com.traceitx.companion.Companion.__setCode(null)
                    com.traceitx.companion.Companion.__setAttachedUserName(null)
                    com.traceitx.companion.Companion.__setResolvedName(null)
                    // A dead pair leaves no bond for a pending attach PIN to
                    // attach to — clear it rather than let a stale code
                    // linger on screen (spec 2026-08-19). Mirrors iOS
                    // `didCloseWith`'s terminal branch.
                    com.traceitx.companion.Companion.__setAttachChallenge(null)
                    com.traceitx.companion.Companion.__setState(CompanionState.Unpaired)
                    // Release the dead socket. Without this `onStart`'s
                    // "already alive" guard reads a corpse as a live
                    // connection and the foreground-recovery path is blocked
                    // too, so the ONLY way back would be
                    // stopCompanion/startCompanion.
                    ws.compareAndSet(webSocket, null)
                    // Then re-pair from scratch. Terminal means "this pair is
                    // dead", not "this device is done": the state above has
                    // already been reset to Unpaired with no pairUrl, so
                    // without a reconnect the host sits on a blank screen
                    // indefinitely. A TV box cannot be reloaded the way the
                    // web reference's browser SPA can, which is why this
                    // follows iOS (`didCloseWith` reschedules) rather than
                    // web ws-client.ts (nulls its socket and returns). With
                    // announce in front of every attempt, the most likely
                    // cause on this leg — 4004 from a ticket that expired in
                    // the 60s window between announce and dial — is fixed by
                    // the very next attempt's fresh ticket. Backoff
                    // (1/2/4/8/10s) bounds the cost if it is not.
                    scheduleReconnect()
                }
                CLOSE_SERVER_SHUTDOWN,
                CLOSE_MALFORMED_FRAME,
                CLOSE_OVERSIZE_BINARY_FRAME,
                CLOSE_TV_ANNOUNCE_BACKLOG,
                CLOSE_NORMAL,
                CLOSE_GOING_AWAY,
                CLOSE_ABNORMAL -> {
                    scheduleReconnect()
                }
                else -> scheduleReconnect()
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // Our own supersede-cancel surfaces here as a failure on the
            // socket we just replaced — ignore it, or it would tear down the
            // socket that replaced it. A failure of the socket this attempt is
            // still opening is NOT that, even if it arrives before the
            // reference has been stored, and it must reconnect: an immediate
            // DNS/TLS/connection-refused error is otherwise the last thing
            // this client ever does.
            if (!isAttemptCurrent(generation)) return
            // The socket that authorised this preview is gone. Stop reading
            // the user's screen NOW rather than letting the loop run out its
            // two-minute cap against a dead socket — and, worse, resume
            // emitting frames under a stale correlation id once the
            // replacement socket opens. THE RULE THAT MATTERS MOST in
            // CompanionPreviewSession's own header: a preview must never
            // outlive the thing that authorised it.
            previewSession.stopSilently()
            previewSession.clearStash()
            resetSubmitFraming()
            // SECURITY: never log `t.message` if it could embed token bytes;
            // OkHttp's IOException messages are URL-free in practice.
            scheduleReconnect()
        }
    }

    /**
     * The listener handed to the newest attempt that reached [openSocket].
     *
     * Initialised to a generation no attempt can ever claim (generations start
     * at 0 and are pre-incremented, so 1 is the first), so a client that has
     * not connected yet owns a listener that ignores everything — the same
     * thing the old identity check did while [ws] was null.
     */
    @Volatile
    private var currentListener: RelayListener = RelayListener(NEVER_CLAIMED_GENERATION)

    /**
     * Test seam: the listener bound to the CURRENT attempt — i.e. the one
     * OkHttp would call back for the installed socket. Tests that drive a
     * deliberately stale socket must use that socket's OWN listener instead;
     * driving a superseded socket through this one proves nothing, because
     * this listener's attempt is by definition still current.
     */
    @VisibleForTesting
    internal val listener: WebSocketListener get() = currentListener

    private fun buildPairUrl(pairToken: String): String =
        baseUrl.trimEnd('/') + "/r/" + pairToken

    // ---------------- ProcessLifecycleOwner (DefaultLifecycleObserver) ----------------

    override fun onStop(owner: LifecycleOwner) {
        supersedeForBackground()
        com.traceitx.companion.Companion.__setState(CompanionState.PhoneDisconnected)
    }

    /**
     * Everything "the process is away" does to this client. Called from
     * [onStop] (the transition) and from [start] (already backgrounded when
     * the host started us, so no transition is coming).
     */
    private fun supersedeForBackground() {
        // The socket cancel below tears the connection down WITHOUT going
        // through `onClosing`/`onFailure` (that's the whole point of this
        // method per the comment below) or `scheduleReconnect()` — this is
        // the supersession path those two don't cover. Same "server deletes
        // the pair on any TV-socket close" reasoning as there (spec
        // 2026-08-19 review finding 2; mirrors iOS `handleDidEnterBackground()`).
        com.traceitx.companion.Companion.__setAttachChallenge(null)
        // T-06.2-08-02 — Android backgrounding doesn't deliver onClosing/
        // onFailure deterministically; proactively cancel. (The
        // `PhoneDisconnected` transition stays in [onStop]: it belongs to the
        // backgrounding EVENT, and the [start] caller never had a phone.)
        //
        // Cancelling the installed socket is NOT sufficient, and is not even
        // the main case. Two things can still open a socket after this returns
        // unless they are superseded here, and both leave the device
        // dashboard-visible and answering capture requests with no UI:
        //
        //   • an announce awaiting HTTP right now. No socket exists yet for
        //     the cancel below to touch, so the continuation would pass
        //     `isAttemptCurrent` and dial. Bumping the generation is what
        //     drops it — the same mechanism [stop] uses, from the entry point
        //     that never used it.
        //   • a reconnect timer armed by an earlier drop. It fires on the
        //     scheduler regardless of lifecycle; the SAME generation bump is
        //     what makes it find its `armedGeneration` stale and drop.
        //
        // `reconnectArmedForGeneration = null` is hygiene only — the
        // generation is monotonic, so the stale marker can never match again.
        // It mirrors [stop]; do not read it as the thing doing the work.
        // Measured: removing it alone fails no test.
        //
        // `connectInFlight = false` is load-bearing in the other direction:
        // the superseded announce's `finishAttempt` no-ops (its generation is
        // stale), so leaving the flag set would wedge [onStart]'s "already
        // connecting" guard permanently and the device would never come back.
        synchronized(lock) {
            isBackgrounded = true
            connectGeneration += 1
            reconnectArmedForGeneration = null
            connectInFlight = false
        }
        // After the bump, never before: an `openSocket` that won the lock a
        // moment ago has its socket installed here and gets cancelled; one
        // that has not yet taken the lock sees the stale generation and
        // returns without installing anything.
        ws.getAndSet(null)?.cancel()
        // Task 11 review round 2, CRITICAL 2 — this cancels the SOCKET, not
        // the preview session; round-1 shape stopped here, so a capture loop
        // already running kept reading the user's screen for up to 2 more
        // minutes with the socket already dead (the exact failure this
        // feature's privacy budget exists to prevent). `stopSilently()`, not
        // `teardown()`: THIS client instance reconnects on foreground (see
        // this method's own doc), so the session must stay reusable, not be
        // torn down for good.
        previewSession.stopSilently()
        previewSession.clearStash()
        resetSubmitFraming()
    }

    override fun onStart(owner: LifecycleOwner) {
        // `Lifecycle.addObserver()` synthesizes any missed lifecycle callbacks
        // when the observer is registered against an already-STARTED owner —
        // which is exactly the case for ProcessLifecycleOwner the first time
        // we call `start()` from a foregrounded app. Without this guard we'd
        // open a second WebSocket on top of the one `start()` just opened in
        // `connectInitial()`, and the server would mint two pair_ids racing
        // for the QR (see TraceItX.companion log: two `ws.onOpen` + two
        // `pair.created` from a single `RelayWSClient.start`). Only reconnect
        // here when there is genuinely no live socket (i.e. the app was
        // backgrounded, our `onStop` cancelled the WS, and now we've returned
        // to foreground).
        //
        // `ws.get() != null` alone is NOT enough once an announce sits in
        // front of the socket: for the whole announce hop (up to 5s) an
        // attempt is live but no socket is installed yet, and reconnecting
        // here would burn a second ticket and open a second socket — a
        // duplicate device row in the dashboard.
        //
        // Clearing `isBackgrounded` FIRST is what un-wedges the flag: [onStop]
        // sets it, [beginConnect] refuses while it is set, and this is the one
        // place it comes off. It also covers the stale case where the app was
        // backgrounded, the host called [stop] (deregistering this observer,
        // so no ON_START ever reached us), and a later [start] re-registers
        // against an already-STARTED owner — the synthesized replay below
        // clears the flag and connects, instead of the client sitting dark.
        synchronized(lock) { isBackgrounded = false }
        if (ws.get() != null || synchronized(lock) { connectInFlight }) {
            android.util.Log.i(
                "TraceItX.companion",
                "onStart: connect already live or in flight, skip (addObserver replay)",
            )
            return
        }
        android.util.Log.i("TraceItX.companion", "onStart: reconnecting from foreground")
        if (deviceToken != null) connectWithDeviceToken() else beginConnect()
    }

    // ---------------- Companion attribution (snapshotted at report.request) ----------------

    /**
     * Companion attribution token for the pair this client is currently
     * serving — from the newest frame that carried one (`report.request`
     * preferred over `pair.bonded`), or null on an ordinary QR bond.
     *
     * Read ONLY from the `report.request` branch, as the fallback for a frame
     * that carried no token of its own; the value is snapshotted there and
     * carried to the submit. Nothing may call this at submit time — see the
     * note in the companion object. Named after the web client's
     * `getCompanionAttribution()` so the three SDK legs stay greppable
     * together. SECURITY: never log the return value.
     */
    internal fun getCompanionAttribution(): String? = attributionToken

    /**
     * Test seam (read-only): the socket this client currently owns. Lets a
     * test drive the listener with the REAL installed socket — which is the
     * only way [openSocket]'s install-then-cancel ordering is observable at
     * all. Production code never reads this, and
     * nothing here stands in for socket creation: every test that uses it
     * still goes through the real [beginConnect] → [openSocket] path.
     */
    @VisibleForTesting
    internal fun __currentSocketForTesting(): WebSocket? = ws.get()

    companion object {
        // DELIBERATELY ABSENT: a process-global `activeClient` /
        // `currentCompanionAttribution()`. It used to exist so the submit
        // composer could reach "the live session's token" without widening
        // `CompanionCaptureBridge.__submitProvider`'s signature. That is
        // precisely the hazard PR-fix 1 removes: any late read of a live
        // session yields whoever is attached NOW, which is not necessarily
        // whoever asked for the report being submitted. The token is now
        // snapshotted in the `report.request` branch above and carried
        // forward, so nothing needs — or may have — a way to ask the session
        // for its current token at submit time. Do not reintroduce one.

        /** Path of the TV-side relay socket; the ticketed form appends
         *  `/<ticket>`. */
        private const val TV_PATH: String = "/relay/tv"

        /** Sentinel for the placeholder listener no attempt ever owns. */
        private const val NEVER_CLAIMED_GENERATION: Long = -1L

        // Close codes. AUTHORITY: the relay threat model §close
        // code catalog. 4001..4004 are terminal for the pair (the TV must
        // re-pair from a fresh `pair.created`); 4005+ are transient and get a
        // backoff. That grouping is unchanged — only the names were corrected
        // to the catalog's, which the previous set had drifted from across the
        // whole 4001..4007 range.
        const val CLOSE_NORMAL: Int = 1000
        const val CLOSE_GOING_AWAY: Int = 1001
        const val CLOSE_ABNORMAL: Int = 1006

        /** Terminal — a phone is already bonded to this pair. */
        const val CLOSE_ALREADY_BONDED: Int = 4001
        /** Terminal — the pair token is past its TTL. */
        const val CLOSE_PAIR_EXPIRED: Int = 4002
        /** Terminal — the phone never came back inside the grace window. */
        const val CLOSE_GRACE_EXCEEDED: Int = 4003
        /** Terminal — pair token (or announce ticket) never existed / already spent. */
        const val CLOSE_TOKEN_NOT_FOUND: Int = 4004
        /** Retryable — relay is going down; reconnect with a new pair. */
        const val CLOSE_SERVER_SHUTDOWN: Int = 4005
        /** Retryable — transport-level framing error. */
        const val CLOSE_MALFORMED_FRAME: Int = 4006
        /** Retryable — a binary frame exceeded the relay's cap. */
        const val CLOSE_OVERSIZE_BINARY_FRAME: Int = 4007
        /** Retryable — the relay is shedding announce load. */
        const val CLOSE_TV_ANNOUNCE_BACKLOG: Int = 4008

        /**
         * Percent-encodes one URL path segment against the RFC-3986
         * unreserved set — the `encodeURIComponent` equivalent the web client
         * uses, so a ticket containing `/` or `?` can never restructure the
         * socket URL.
         */
        internal fun encodePathSegment(raw: String): String {
            val out = StringBuilder(raw.length)
            for (byte in raw.toByteArray(Charsets.UTF_8)) {
                val v = byte.toInt() and 0xFF
                val c = v.toChar()
                val unreserved = v < 0x80 &&
                    (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~")
                if (unreserved) {
                    out.append(c)
                } else {
                    out.append('%')
                        .append(HEX_DIGITS[(v shr 4) and 0xF])
                        .append(HEX_DIGITS[v and 0xF])
                }
            }
            return out.toString()
        }

        private const val HEX_DIGITS: String = "0123456789ABCDEF"

        /** RESEARCH §Reconnect — 1/2/4/8/10s ceiling. */
        @JvmField
        internal val BACKOFF_STEPS: LongArray =
            longArrayOf(1_000L, 2_000L, 4_000L, 8_000L, 10_000L)

        /** Default Looper-backed scheduler. Tests inject a synchronous one. */
        private fun defaultScheduler(delayMs: Long, action: () -> Unit) {
            android.os.Handler(android.os.Looper.getMainLooper())
                .postDelayed(action, delayMs)
        }
    }
}
