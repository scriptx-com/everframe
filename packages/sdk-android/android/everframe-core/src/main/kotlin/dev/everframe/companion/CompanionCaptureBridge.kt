// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 Task 2 — capture-on-request bridge for the Android
// companion runtime. Mirrors iOS `CompanionCaptureBridge` (Plan 06.2-07).
//
// CONTEXT carry-forward: "Reuses existing native primitives." This
// bridge does NOT re-implement capture — it composes:
//   • `dev.everframe.capture.ScreenshotCapture.captureBeforeReporter`
//     for PNG bytes (needs the host Activity — supplied by the
//     `__captureProvider` seam below).
//   • `dev.everframe.capture.LogRingBuffer` / `NetworkRingBuffer` counts.
//   • `dev.everframe.outbox.JSONLOutbox` for the final ship path
//     (preserves PIPE-01..03 ordering guarantees from Phase 04).
//
// Wiring split between this plan and Plan 06.2-13:
//   • THIS plan (06.2-08) — provides the dispatch points (`onReportRequest`,
//     `onReportSubmit`) that `RelayWSClient` calls when phone-driven
//     report messages arrive. State transitions stay consistent even
//     when no provider is installed.
//   • Plan 06.2-13 — installs `__captureProvider` / `__submitProvider` from
//     the RN bridge (EverframeModule.startCompanion) using the host's
//     foreground activity registry and the canonical envelope composer.
//
// When `__captureProvider` is null (default), the bridge responds with
// `report.failed` so the phone reporter gets a deterministic answer
// instead of timing out. State machine returns to `Paired`.
//
// SECURITY: this file does NOT log `correlationId` (it's a host-rendered
// trace ID, but logs from production builds must stay token-free per
// T-06.2-08-01).

package dev.everframe.companion

import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.protocol.generated.RelayMessage
import dev.everframe.protocol.generated.ReportFailed
import dev.everframe.protocol.generated.ReportSubmit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.WebSocket
import java.util.concurrent.ConcurrentHashMap

typealias CompanionSubmitWork = suspend () -> CompanionCaptureBridge.SubmitResult
typealias CompanionSubmitProvider = (ReportSubmit, ByteArray, List<ByteArray>, String?, FrozenReportCapture, TXCapturedSession) -> CompanionSubmitWork

object CompanionCaptureBridge {
    private data class CaptureSlot(val correlationId: String, val clientOwner: Any, val capture: FrozenReportCapture)
    private val captureLock = Any()
    private var pendingCapture: CaptureSlot? = null

    /** Detach synchronously; callers may then post cancellation of this exact owner. */
    internal fun takeCaptureFor(clientOwner: Any): FrozenReportCapture? = synchronized(captureLock) {
        val slot = pendingCapture ?: return@synchronized null
        if (slot.clientOwner !== clientOwner) return@synchronized null
        pendingCapture = null
        slot.capture
    }

    /** Host capture completion may publish only while this correlation still owns the slot. */
    fun __publishCapture(correlationId: String, capture: FrozenReportCapture, publish: () -> Unit): Boolean = synchronized(captureLock) {
        if (pendingCapture?.let { it.correlationId == correlationId && it.capture === capture } != true) return@synchronized false
        publish()
        true
    }

    internal fun captureFor(correlationId: String): FrozenReportCapture? = synchronized(captureLock) {
        pendingCapture?.takeIf { it.correlationId == correlationId }?.capture
    }


    /**
     * Installed by Plan 06.2-13 (RN bridge host wiring) with a function
     * that knows how to acquire the foreground Activity, run
     * ScreenshotCapture, gather log/network counts, and build the
     * `report.assembled` envelope.
     *
     * Returning `null` from the provider is allowed (e.g., no foreground
     * Activity) — the bridge maps that to `report.failed`.
     *
     * Type: `(correlationId: String, capture: FrozenReportCapture) -> AssembledPayload?` where the
     * payload bundles the JSON header (ReportAssembled) plus PNG bytes
     * for the binary frame that immediately follows.
     */
    @JvmStatic
    var __captureProvider: ((String, FrozenReportCapture) -> AssembledPayload?)? = null

    /**
     * Task 11 — host-installed 2fps-LOOP capture (low-res, e.g. ~480p JPEG),
     * same contract and same reason as [__captureProvider]: the core AAR
     * must not know how to find a foreground Activity. Installed by the RN
     * module (Task 11b, not this task) and nulled on stop, exactly like
     * [__captureProvider].
     *
     * `suspend`, not a plain lambda — round-1 shape used
     * `() -> PreviewCapture?` here, but the real capture implementation goes
     * through `PixelCopy`, which is inherently async (it posts to a Handler
     * and completes on a callback), so a synchronous seam would force a
     * `runBlocking` adapter at the install site — which deadlocks when that
     * Handler is the SAME main thread `runBlocking` would be blocking
     * (task-11 review round 2, design correction (a)).
     *
     * Returning `null` means "cannot capture right now" —
     * `CompanionPreviewSession`'s own loop maps that to `capture_unavailable`
     * and stops, rather than crashing.
     *
     * NOT the seam for a shot's stash capture — see [__shotCaptureProvider].
     * Task 11 round-1 wired the SAME provider to both the loop and the stash,
     * which silently shipped preview-resolution pixels as a report's shot
     * evidence with a hardcoded, possibly-wrong mime (task-11 review round
     * 2, IMPORTANT 4).
     */
    @JvmStatic
    var __previewProvider: (suspend () -> PreviewCapture?)? = null

    /**
     * Task 11 round 2 — host-installed FULL-RESOLUTION capture for
     * `CompanionPreviewSession`'s shot stash (`shot.request`'s contract is
     * "capture fresh now, at full resolution" — a 2fps-loop-grade frame does
     * not satisfy it). Same install/null-on-stop contract as
     * [__previewProvider]; a future task installs this alongside it from the
     * RN module. Returning `null` means "cannot capture right now" —
     * `CompanionPreviewSession.handleShotRequest` maps that to `shot.failed`,
     * scoped to that one shot, never to the whole report.
     */
    @JvmStatic
    var __shotCaptureProvider: (suspend () -> PreviewCapture?)? = null

    /**
     * Synchronous bounded preparation at receipt of every announced submit part.
     * The host transfers its existing screenshot stash into the returned suspend work.
     * No image processing, disk or network work may run in preparation; it executes
     * under the capture lock so stop/re-pair cannot erase received report content.
     * Attribution (fourth argument) is a bearer token: never log it. The explicit
     * capture and Send-time session govern optional replay and report authorization.
     */
    @JvmStatic
    var __submitProvider: CompanionSubmitProvider? = null

    /**
     * Plan 06.2-13 Task 3 — internal scope for launching suspend submits
     * off the WebSocket listener thread. `Dispatchers.IO` is correct for
     * the multipart-upload path (mirrors `ReporterDialog`'s
     * `MainScope().launch(Dispatchers.Default)` shape — different
     * dispatcher because IO-bound, not CPU-bound). SupervisorJob so one
     * failing submit doesn't cancel siblings.
     */
    private val submitSlots = java.util.concurrent.Semaphore(2)

    private val submitScope: CoroutineScope =
        CoroutineScope(Dispatchers.IO + SupervisorJob())

    /**
     * Plan 06.2-13 Task 3 — per-correlation_id stash for the baked PNG
     * bytes delivered as a binary frame AFTER the `report.submit` text
     * frame (D-05 wire ordering). `RelayWSClient.onMessage(ws, bytes)`
     * routes binary into `onSubmitBinary(...)` which writes here; the
     * submit-text-frame handler in `onReportSubmit(...)` reads and clears.
     * Each entry is consumed exactly once.
     *
     * ConcurrentHashMap because writes from the OkHttp WS thread can race
     * with reads from the submitScope coroutine on rare orderings.
     */
    private val pendingBakedBytes = ConcurrentHashMap<String, ByteArray>()

    /**
     * PR-fix 1 — the companion attribution token that belonged to the
     * in-flight report's `report.request`, paired with that report's
     * correlation_id.
     *
     * WHY IT IS SNAPSHOTTED HERE AND NOT READ AT SUBMIT TIME. The submit
     * composition runs for seconds (multipart upload of screenshot + replay),
     * and it deliberately outlives `stopCompanion()`. In that window the pair
     * can be released and a DIFFERENT dashboard user can attach — the relay
     * sends a fresh `pair.bonded` carrying that new user's token down the same
     * TV socket, and the host may have swapped relay clients entirely. Reading
     * the live session at submit time therefore hands the older report the
     * newer user's token; because ingest consumes attribution tokens
     * single-use, that both mis-credits the old report AND burns the new
     * user's token so their own next report lands unattributed.
     *
     * SINGLE SLOT, not a map: `RelayWSClient` rejects any `report.request`
     * arriving while `Companion.state == ReportInProgress`, so at most one
     * report is ever live per pair. A new request overwrites the slot, which
     * is exactly the desired eviction — the superseded report can no longer
     * find a token and submits unattributed rather than borrowing the new
     * one. The correlation_id is stored with the token and must match on
     * read, so a mismatched or stale slot yields null.
     *
     * ATTRIBUTION IS NEVER FATAL: every failure to resolve a token here means
     * "submit unattributed", never a dropped or errored report.
     *
     * SECURITY: never log the token half.
     */
    @Volatile
    private var pendingAttribution: Pair<String, String?>? = null

    /**
     * Bundled `report.assembled` payload. The protocol-codegen
     * `ReportAssembled` data class + the screenshot bytes (PNG or WebP/JPEG
     * per the announced `mime`).
     *
     * There is NO second binary frame any more: tap-to-identify was removed
     * (spec 2026-08-29), so no UI tree is captured, gzipped or announced.
     * `assembled.tree` is always null, which is exactly what tells the
     * phone's binary demuxer to stop after the screenshot.
     */
    data class AssembledPayload(
        val assembled: RelayMessage,  // sealed-type RelayMessage.ReportAssembled
        val pngBytes: ByteArray,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is AssembledPayload) return false
            return assembled == other.assembled && pngBytes.contentEquals(other.pngBytes)
        }

        override fun hashCode(): Int = assembled.hashCode() * 31 + pngBytes.contentHashCode()
    }

    /** Plan 09 submit outcome. */
    sealed class SubmitResult {
        data class Ok(val eventId: String) : SubmitResult()
        data class Err(val reason: String) : SubmitResult()
    }

    /**
     * Called by `RelayWSClient` when `report.request` arrives. By this
     * point `Companion.state == ReportInProgress` (RelayWSClient flipped
     * it before dispatching here). Bridge MUST either:
     *   1. send `report.assembled` + binary PNG, OR
     *   2. send `report.failed` and return state to `Paired`.
     *
     * [companionAttribution] is the token the relay minted for THIS report
     * (null on an ordinary QR bond). It is stashed against [correlationId]
     * and handed back to `__submitProvider` when the matching
     * `report.submit` lands. SECURITY: never log it.
     *
     * NO DEFAULT, deliberately — same rule as
     * `CompanionSubmissionComposer.Inputs.companionAttribution`, and for the
     * same reason one layer down: a `= null` default lets a new call site drop
     * attribution silently, and this is the exact seam the token has to cross.
     * Every caller must say what the token is, `null` included. (The default
     * that used to be here, with `@JvmOverloads`, existed only so two tests
     * compiled unchanged; there is no Java caller of this method anywhere in
     * the repo.)
     */
    @JvmStatic
    fun onReportRequest(
        correlationId: String,
        ws: WebSocket,
        companionAttribution: String?,
        clientOwner: Any = ws,
    ) {
        // Claim the slot BEFORE anything can fail or block: capture runs
        // synchronously on the WS reader thread and can take a while
        // (screenshot capture), and this is the last moment at which
        // the token is unambiguously this report's.
        pendingAttribution = Pair(correlationId, companionAttribution)
        val provider = __captureProvider
        if (provider == null) {
            dropPendingAttribution(correlationId)
            ws.send(jsonEnvelope.encodeToString(
                RelayMessage.serializer(),
                ReportFailed(correlationId = correlationId, reason = "capture_unavailable"),
            ))
            Companion.__finishReport(correlationId)
            return
        }
        // Freeze before invoking the host screenshot provider. Replacement revokes only its predecessor.
        val capture = synchronized(captureLock) {
            pendingCapture?.capture?.cancel()
            Everframe.__replayFreeze().also {
                pendingCapture = CaptureSlot(correlationId, clientOwner, it)
            }
        }
        // Final whole-branch review, fix round 2, Critical 1 — this IS the
        // companion path's reporter-open moment (see the comment immediately
        // above), so it gets the identical identity re-warm
        // `TXReporterPresenter.openReporter` fires for the in-app dialog.
        // `__warmIdentityToken` has no UI-thread requirement of its own.
        // Firing it immediately gives the provider
        // the maximum time to resolve before the phone's `report.submit`.
        Everframe.__warmIdentityToken()
        val payload = runCatching { provider.invoke(correlationId, capture) }.getOrNull()
        if (payload == null) {
            // No capture → no submit will ever arrive for this report; drop
            // the token rather than leave it parked on the slot.
            dropPendingAttribution(correlationId)
            ws.send(jsonEnvelope.encodeToString(
                RelayMessage.serializer(),
                ReportFailed(correlationId = correlationId, reason = "capture_failed"),
            ))
            capture.cancel()
            Companion.__finishReport(correlationId)
            return
        }
        // The whole report.assembled sequence — header, then screenshot —
        // under ONE lock, shared with the preview loop and the shot path. Both
        // the relay and the phone frame binaries as "the next one belongs to
        // the latest header", so a preview frame landing between this header
        // and its screenshot would install a low-resolution preview as the
        // report's primary evidence. See [CompanionWireLock].
        CompanionWireLock.framed {
        ws.send(jsonEnvelope.encodeToString(RelayMessage.serializer(), payload.assembled))
        ws.send(okio.ByteString.of(*payload.pngBytes))
        }
        // State stays at ReportInProgress until the phone sends
        // `report.submit` (or `report.rejected`) -> see onReportSubmit.
    }

    /**
     * Called by `RelayWSClient` when `report.submit` arrives. By this
     * point the host has the draft assembled and the bridge applies the
     * `includes` toggles + description redactions before shipping via
     * `JSONLOutbox`. On Plan 09 install this is a real submit; here it
     * sends a deterministic `report.failed` if no submitter is wired.
     */
    @JvmStatic
    fun onReportSubmit(message: ReportSubmit, ws: WebSocket) {
        val submitter = __submitProvider
        if (submitter == null) {
            captureFor(message.correlationId)?.cancel()
            ws.send(jsonEnvelope.encodeToString(
                RelayMessage.serializer(),
                ReportFailed(correlationId = message.correlationId, reason = "submit_unavailable"),
            ))
            Companion.__finishReport(message.correlationId)
            return
        }
        // Plan 06.2-13 Task 3: pair with the baked PNG binary frame.
        // The phone sends submit→binary in strict D-05 order; if the binary
        // arrived first (rare interleave) it's already stashed below. If it
        // arrives after, the binary handler kicks off the submit using the
        // text frame stored here.
        tryRunSubmit(message, ws, submitter)
    }

    /**
     * Plan 06.2-13 Task 3 — called from `RelayWSClient.onMessage(ws, bytes)`
     * when a binary frame arrives. The submit text frame may or may not
     * have arrived yet; we stash the bytes and try the pair, so either
     * ordering completes the submit.
     */
    @JvmStatic
    fun onSubmitBinary(correlationId: String, bytes: ByteArray, ws: WebSocket) {
        val submitter = __submitProvider ?: run {
            ws.send(jsonEnvelope.encodeToString(
                RelayMessage.serializer(),
                ReportFailed(correlationId = correlationId, reason = "submit_unavailable"),
            ))
            return
        }
        // Stash the bytes; the submit text frame's `onReportSubmit` reads
        // them. If the text frame already arrived (rare race), the pending
        // text is gone and this binary is the second part — kick the
        // submit directly using the stashed-text fallback. The simple
        // single-buffer model below mirrors iOS Plan 12's single-shot
        // pairing: one in-flight submit at a time, no multi-submit batching.
        // Both orderings funnel through the same readiness gate: the submit
        // fires when the text frame, the primary binary and every announced
        // shot binary are all present.
        pendingBakedBytes[correlationId] = bytes
        evictStalledSubmits(keep = correlationId, ws = ws)
        maybeLaunchSubmit(correlationId, ws, submitter)
    }

    /**
     * Plan 06.2-13 Task 3 — companion-side single-buffered submit text
     * stash. Mirrors iOS RelayWSClient.pendingSubmitCorrelationId but lives
     * on the bridge (Android RelayWSClient's onMessage shape is per-frame,
     * not per-message — the bridge owns the pairing state).
     */
    private val pendingSubmitText = ConcurrentHashMap<String, ReportSubmit>()

    /**
     * Baked images for the extra shots of an in-flight submit, keyed
     * correlationId -> shotId.
     *
     * The phone announces its extra shots in `report.submit.shots[]` and then
     * sends each one's bytes behind a `shot.binary {shot_id}` marker. Until
     * this existed the marker was unhandled and the bytes were dropped, so a
     * multi-shot report uploaded ONLY the primary screenshot and still
     * reported success — silent loss of evidence the user explicitly captured,
     * with the admin UI already able to render the extras (it parses
     * `annotated-screenshot-N` part names).
     */
    private val pendingShotBytes = ConcurrentHashMap<String, MutableMap<String, ByteArray>>()

    /**
     * Ceilings on half-assembled submits.
     *
     * The readiness gate waits for every announced shot, which means the
     * primary binary and any shots received so far are RETAINED while one is
     * outstanding. Before the gate existed the primary was consumed the moment
     * it arrived, so nothing accumulated. A bonded sender can now open a
     * submit, send a large primary, omit the announced shot and repeat — so
     * both the number of half-assembled submits and their total bytes are
     * bounded, oldest evicted first. Dropping a stalled submit costs that
     * report; not dropping it costs the process.
     */
    private const val MAX_PENDING_SUBMITS: Int = 2
    private const val MAX_PENDING_BYTES: Int = 30_000_000

    private fun retainedBytes(): Int =
        pendingBakedBytes.values.sumOf { it.size } +
            pendingShotBytes.values.sumOf { m -> m.values.sumOf { it.size } }

    /** Drops half-assembled submits until both ceilings hold. */
    private fun evictStalledSubmits(keep: String, ws: WebSocket?) {
        while (pendingSubmitText.size > MAX_PENDING_SUBMITS || retainedBytes() > MAX_PENDING_BYTES) {
            // Older submits go first, but the CURRENT one is not exempt: a
            // sender can blow the byte ceiling with a single submit (a
            // maximum-size primary plus shots, withholding the last), and
            // exempting it meant `firstOrNull()` returned null and the loop
            // broke with the bound unmet — the advertised limit did not hold at
            // all in the one case that matters most.
            val victim = pendingSubmitText.keys.firstOrNull { it != keep }
                ?: pendingSubmitText.keys.firstOrNull()
                ?: break
            android.util.Log.w(
                "Everframe.companion",
                "dropping a half-assembled submit — pending ceiling reached",
            )
            pendingSubmitText.remove(victim)
            pendingBakedBytes.remove(victim)
            pendingShotBytes.remove(victim)
            // Tell the phone, or it waits on "Submitting…" forever.
            ws?.send(
                jsonEnvelope.encodeToString(
                    RelayMessage.serializer(),
                    ReportFailed(correlationId = victim, reason = "payload_too_large"),
                ),
            )
        }
    }

    private fun tryRunSubmit(
        message: ReportSubmit,
        ws: WebSocket,
        submitter: CompanionSubmitProvider,
    ) {
        pendingSubmitText[message.correlationId] = message
        evictStalledSubmits(keep = message.correlationId, ws = ws)
        maybeLaunchSubmit(message.correlationId, ws, submitter)
    }

    /**
     * Fires the submit once EVERY part the phone announced has arrived: the
     * text frame, the primary binary, and one binary per entry in
     * `report.submit.shots[]`.
     *
     * The old shape fired as soon as the primary binary landed, which is why
     * the extra shots' bytes — which arrive AFTER it — could never be part of
     * the upload no matter how they were routed.
     */
    private fun maybeLaunchSubmit(
        correlationId: String,
        ws: WebSocket,
        submitter: CompanionSubmitProvider,
    ) {
        val message = pendingSubmitText[correlationId] ?: return
        val bakedBytes = pendingBakedBytes[correlationId] ?: return
        val announced = message.shots?.map { it.shotId } ?: emptyList()
        val arrived = pendingShotBytes[correlationId] ?: emptyMap<String, ByteArray>()
        // Announced-but-missing: keep waiting. The phone sends every announced
        // shot's binary immediately after the primary, so this window is short;
        // a phone that dies mid-sequence leaves the buffers to be cleared by
        // the same teardown/pair-loss paths that clear every other per-report
        // state (see dropEntries).
        if (announced.any { !arrived.containsKey(it) }) return

        pendingSubmitText.remove(correlationId)
        pendingBakedBytes.remove(correlationId)
        pendingShotBytes.remove(correlationId)
        // Ordered by the ANNOUNCED order, not arrival order — the envelope's
        // `annotated-screenshot-N` suffixes have to line up with the
        // `shots[]` array the phone sent, or annotations pair to the wrong image.
        val extras = announced.mapNotNull { arrived[it] }
        launchSubmit(message, bakedBytes, extras, ws, submitter)
    }

    /**
     * A baked image for one extra shot, bound by the `shot.binary {shot_id}`
     * marker that immediately preceded it.
     */
    @JvmStatic
    fun onShotBinary(correlationId: String, shotId: String, bytes: ByteArray, ws: WebSocket) {
        val submitter = __submitProvider ?: return
        // UNSOLICITED shot binaries are dropped. `shot.binary` is only ever
        // legal behind a `report.submit` that announced that shot, so without
        // a pending submit for this correlation id there is nothing these
        // bytes can belong to. Buffering them anyway let a bonded phone stream
        // unlimited marker/payload pairs under ids of its own choosing into a
        // map cleared only at teardown — a straightforward way to exhaust the
        // device's memory.
        val pending = pendingSubmitText[correlationId]
        if (pending == null) {
            android.util.Log.w(
                "Everframe.companion",
                "shot.binary DROPPED — no pending submit for this correlation id",
            )
            return
        }
        // …and only for shots that submit actually announced, which also caps
        // the map at the protocol's own `shots` maximum.
        if (pending.shots?.none { it.shotId == shotId } != false) {
            android.util.Log.w("Everframe.companion", "shot.binary DROPPED — shot_id was not announced by the submit")
            return
        }
        pendingShotBytes.getOrPut(correlationId) { ConcurrentHashMap() }[shotId] = bytes
        evictStalledSubmits(keep = correlationId, ws = ws)
        maybeLaunchSubmit(correlationId, ws, submitter)
    }

    private fun launchSubmit(
        message: ReportSubmit,
        bakedBytes: ByteArray,
        extraShotPngs: List<ByteArray>,
        ws: WebSocket,
        submitter: CompanionSubmitProvider,
    ) {
        // Resolve the attribution token synchronously, on the WS reader
        // thread, BEFORE the coroutine is dispatched — the coroutine is the
        // long-lived half, and by the time it runs the session may already
        // belong to someone else.
        val attribution = takePendingAttribution(message.correlationId)
        val capture = captureFor(message.correlationId)
        if (capture == null) {
            ws.send(jsonEnvelope.encodeToString(RelayMessage.serializer(),
                ReportFailed(correlationId = message.correlationId, reason = "no_capture")))
            Companion.__finishReport(message.correlationId)
            return
        }
        if (!submitSlots.tryAcquire()) {
            capture.cancel()
            ws.send(jsonEnvelope.encodeToString(RelayMessage.serializer(),
                ReportFailed(correlationId = message.correlationId, reason = "submit_capacity")))
            Companion.__finishReport(message.correlationId)
            return
        }
        val session = Everframe.captureSessionSnapshot()
        // The host transfers its stash now, before disconnect/stop can clear it.
        val work = try { synchronized(captureLock) {
            check(pendingCapture?.capture === capture)
            submitter(message, bakedBytes, extraShotPngs, attribution, capture, session)
        } }
        catch (_: Throwable) {
            submitSlots.release()
            capture.cancel()
            ws.send(jsonEnvelope.encodeToString(RelayMessage.serializer(),
                ReportFailed(correlationId = message.correlationId, reason = "prepare_failed")))
            Companion.__finishReport(message.correlationId)
            return
        }
        submitScope.launch {
            val result = try {
                work.invoke()
            } catch (t: Throwable) {
                android.util.Log.w(
                    "Everframe.companion",
                    "submit threw: ${t.javaClass.simpleName}: ${t.message}",
                )
                SubmitResult.Err("ingest_error")
            } finally { capture.finishConsumption(); submitSlots.release() }
            when (result) {
                is SubmitResult.Ok -> {
                    ws.send(jsonEnvelope.encodeToString(
                        RelayMessage.serializer(),
                        dev.everframe.protocol.generated.ReportCompleted(
                            correlationId = message.correlationId,
                            eventId = result.eventId,
                        ),
                    ))
                }
                is SubmitResult.Err -> {
                    android.util.Log.w("Everframe.companion", "submit failed (reason=${result.reason})")
                    ws.send(jsonEnvelope.encodeToString(
                        RelayMessage.serializer(),
                        ReportFailed(
                            correlationId = message.correlationId,
                            reason = result.reason,
                        ),
                    ))
                }
            }
            // PR-fix 7 — this submit runs for seconds and deliberately
            // outlives the bond that started it. In that window the pair can be
            // released and re-attached to a DIFFERENT dashboard user
            // (`releasePairBond` force-closes only the phone leg), the re-bond
            // flips the pair to `Paired`, and the new user's `report.request`
            // is accepted and enters `ReportInProgress`. Flipping to `Paired`
            // unconditionally here cleared THAT report's state, after which a
            // third request was accepted over it and re-froze the replay
            // snapshot its composer was about to consume. The frame above is
            // still sent either way — the phone that submitted a superseded
            // report is waiting for an answer.
            Companion.__finishReport(message.correlationId)
        }
    }

    /**
     * PR-fix 1 — consume the attribution snapshot for [correlationId].
     * Returns null (submit unattributed) whenever the slot belongs to a
     * different report, which is what a superseded or abandoned report sees.
     * Consuming is single-use, mirroring ingest: a token cannot be reused by
     * a retry or a second submit for the same correlation id.
     */
    private fun takePendingAttribution(correlationId: String): String? {
        val slot = pendingAttribution ?: return null
        if (slot.first != correlationId) return null
        pendingAttribution = null
        return slot.second
    }

    /** PR-fix 1 — release the slot when this report can no longer produce a
     *  submit. No-op when the slot has already moved on to another report. */
    private fun dropPendingAttribution(correlationId: String) {
        val slot = pendingAttribution ?: return
        if (slot.first == correlationId) pendingAttribution = null
    }

    /**
     * PR-fix 1 — called from `EverframeModule.stopCompanion()`. The companion
     * identity dies with the session (same rule `RelayWSClient.stop()` applies
     * to its own `attributionToken`), so an unclaimed snapshot must not sit in
     * this object waiting for a session that is over.
     *
     * Not load-bearing for correctness — a stale slot is keyed by its own
     * correlation_id and can only ever be read by the report it belongs to,
     * whose socket is gone. This is hygiene: no bearer token outlives the
     * session that minted it.
     */
    @JvmStatic
    fun __clearPendingAttribution() {
        pendingAttribution = null
    }

    /**
     * Plan 06.2-13 Task 3 — uninstall hook called from
     * `EverframeModule.stopCompanion()`. Drops both providers and any
     * stashed binary/text pairs, and cancels any in-flight submits
     * spawned on `submitScope`. Idempotent.
     */
    @JvmStatic
    fun __teardownForTesting() {
        __captureProvider = null
        __submitProvider = null
        __previewProvider = null
        __shotCaptureProvider = null
        pendingBakedBytes.clear()
        pendingSubmitText.clear()
        pendingShotBytes.clear()
        pendingAttribution = null
        synchronized(captureLock) { pendingCapture?.capture?.cancel(); pendingCapture = null }
    }

    /**
     * Drops every half-assembled submit.
     *
     * Called when the phone leg ends (disconnect, pair expiry, backgrounding,
     * client teardown): those buffers belong to a submit that can no longer
     * complete, and leaving them means the NEXT report inherits a partially
     * filled slot — its own parts then merge with a dead one and it never
     * satisfies the readiness gate. An in-flight submit coroutine already holds
     * its own copies, so this cannot truncate an upload that started.
     */
    @JvmStatic
    internal fun __dropPendingSubmits() {
        pendingSubmitText.clear()
        pendingBakedBytes.clear()
        pendingShotBytes.clear()
    }

    /** Test seam — assert the install/uninstall lifecycle without
     *  exposing the maps. */
    @JvmStatic
    fun __pendingPairsCountForTesting(): Int =
        pendingBakedBytes.size + pendingSubmitText.size + pendingShotBytes.size

    /** Match RelayWSClient's encoder shape — `@JsonClassDiscriminator` already
     *  set on RelayMessage; `encodeDefaults = false` keeps `correlation_id`
     *  out of payloads where its nullable. */
    private val jsonEnvelope = Json {
        classDiscriminator = "type"
        encodeDefaults = false
    }
}
