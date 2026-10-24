// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared envelope-build + submit pipeline for the UI-less report paths in
// :everframe-core (simulator and real-device quick capture). Originally
// written for the Companion capture bridge (Plan 06.2-13); moved here and
// renamed when Companion was removed.
//
// Mirrors iOS `ReporterSubmission.swift`. On Android the modal's submit
// composition lives inline inside `ReporterDialog.kt` in the
// `:everframe-reporter-ui` module — which `:everframe-core` CANNOT depend on
// without inverting the module graph — so this composer is a deliberate
// near-copy of it. `ReporterDialog.submitBaked` stays in sync with it for
// everything except `quickCapture`, `captureToken` and `deviceLink`, which
// only the UI-less callers set.
//
// ENVELOPE PARITY INVARIANT: this file's `submit(...)` MUST produce a
// byte-identical envelope to ReporterDialog.kt's inline composition for the
// same Inputs. Any field added there must be added here. A CI grep could
// later enforce that both call EnvelopeBuilder().buildEncoded with the same
// argument list — for now, code review + the documented duplication is the
// guardrail.

package dev.everframe.quickcapture

import android.app.Activity
import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.capture.video.NativeVideoAttachment
import dev.everframe.transport.HostImageVTreeAttachment
import dev.everframe.transport.ReportAuthorizationFactory
import dev.everframe.capture.DeviceMetadata
import dev.everframe.capture.sharedLogBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.capture.sharedResourceBuffer
import dev.everframe.config.ReportResult
import dev.everframe.config.EverframeConfig
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.envelope.partName
import dev.everframe.envelope.txGuardSuspend
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.protocol.generated.Attachment
import dev.everframe.protocol.generated.AttachmentKind
import dev.everframe.transport.ReportSubmitter
import kotlinx.serialization.json.Json
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * Singleton submit pipeline for the UI-less report paths. Stateless — every call
 * builds a fresh `EnvelopeBuilder` + `ReportSubmitter`. Mirrors iOS
 * `ReporterSubmission` (an `enum` without cases — Swift's idiom for a
 * namespace; Kotlin's idiom is `object`).
 */
/** Hard cap on report title length. Matches the Zod protocol schema and every UI surface. */
private const val TITLE_MAX_CHARS: Int = 200
/** Hard cap on report description length. Matches the Zod protocol schema and every UI surface. */
private const val DESCRIPTION_MAX_CHARS: Int = 600

object SubmissionComposer {

    /**
     * Test seam — supplies the [ReportSubmitter] this composer ships through.
     * Production leaves it null and the composer builds its own (whose ingest
     * endpoint is the build-time-baked [dev.everframe.config.IngestEndpoint.url]
     * and therefore not redirectable at runtime).
     *
     * It exists so a test can point the real submit at a local server and
     * assert on the request it receives. Nothing is short-circuited: the
     * composer still builds the whole envelope and still calls `submit(…)` on
     * whatever submitter it is handed.
     */
    @JvmStatic
    internal var __submitterFactoryForTesting: ((EverframeConfig, JSONLOutbox) -> ReportSubmitter)? = null

    /**
     * One submit's inputs. Field order + types mirror iOS
     * `ReporterSubmission.Inputs` member-for-member where the platforms
     * translate cleanly. The notable differences:
     *
     *   • `captureBitmap` is the BAKED bitmap (annotations + blur already
     *     applied) — iOS passes `captureResult` (pre-bake) + `bakedImage`
     *     separately, then re-encodes; on Android the bake happens upstream
     *     in `ReporterRoot` and we receive the final image.
     *   • `extraOverrides` is `Map<String, String>` like iOS, but currently
     *     unused on Android (the iOS DEFE-02 ui_tree_unavailable signal lives
     *     in `degradedReason` directly). Kept in the struct for parity so
     *     future deltas don't ripple through the call site.
     */
    data class Inputs(
        /** Activity used only to read `DeviceMetadata.collect(context)` and to
         *  determine `formFactor`. Never written to. */
        val activity: Activity,
        /** Baked bitmap (annotations + blur regions already applied). */
        val captureBitmap: Bitmap,
        val capture: FrozenReportCapture,
        /**
         * Baked PNGs for the EXTRA shots of a multi-shot submit, in shot
         * order.
         *
         * Empty for a single-shot report, which keeps that envelope
         * byte-identical to the pre-multi-shot shape. Each entry becomes a
         * `screenshot-N` part (1-based from the second shot), which is exactly
         * what the admin payload card already parses.
         */
        val extraShotPngs: List<ByteArray> = emptyList(),
        val title: String,
        val description: String,
        val includeLogs: Boolean,
        val includeNetwork: Boolean,
        val includeMetadata: Boolean,
        /** Caller-supplied extra keys merged into envelope.extra. Currently
         *  unused on Android — see KDoc above. */
        val extraOverrides: Map<String, String> = emptyMap(),
        /** Host-attached opaque metadata string, consumed by the caller via
         *  `Everframe.consumePendingAttachments()` and threaded through here. */
        val hostExtra: String?,
        /**
         * Self-declared user (`setUser`, spec 2026-08-12) SNAPSHOTTED at the
         * moment this report's submission began, before any decode/bake.
         *
         * External review, finding 3 (Serious). This composer used to read
         * `Everframe.currentUser` inline, after PNG encoding, device-metadata
         * collection, ring-buffer snapshotting and replay serialization. Those
         * stages can span hundreds of milliseconds to seconds, and a `setUser`
         * call landing in that window (sign-out/sign-in, account switch)
         * permanently grouped A's report under B.
         *
         * Deliberately has NO default: every caller must state who this report
         * belongs to. A default of "read the live singleton" is the precise
         * defect this field exists to prevent, and a default of `null` would
         * let a new submit surface silently ship anonymous.
         *
         * `TXUser` is an immutable data class, so holding it here is already a
         * snapshot; the native counterpart of web's `captureUserSnapshot`.
         *
         * External review, finding 1 (Serious) — carries the SESSION it was
         * captured in ([dev.everframe.TXCapturedUser]), not a bare `TXUser?`.
         * `cfg` below carries the SDK key, i.e. the destination PROJECT, and is
         * read asynchronously after the capture; `resolve()` drops the user if
         * a `start()`/`kill()` landed in between, so a snapshot can never be
         * uploaded under another project's key.
         */
        val capturedSession: dev.everframe.TXCapturedSession,
        /** Sections the user explicitly toggled off in the reporter UI.
         *  Lands in `captureControl.excluded`. */
        val excluded: List<String> = emptyList(),
        /** Quick capture: stamps `quickCapture: true` on the envelope. */
        val quickCapture: Boolean = false,
        /** Simulator quick-capture token, sent only as the live upload's
         *  `X-Everframe-Capture-Token` header and never persisted to the outbox.
         *  SECURITY: never log. */
        val captureToken: String? = null,
        /** True when [captureBitmap] went through the reporter's annotation
         *  canvas. Quick capture sends the raw
         *  screenshot and passes false, so the attachment is declared a plain
         *  `screenshot` instead of `annotated-screenshot`. */
        val annotated: Boolean = true,
        /**
         * Host-rendered, already masked replay timeline (Flutter or KMP), exactly what
         * `ReporterDialog` receives as `hostReplayVTree` from `EFReporterFromImage`. Non-null means
         * the host owns replay for this report: native video is never attached, and an empty array
         * keeps it that way when the host had no safe frames. Null keeps the native video. Set only by simulator quick capture with host evidence.
         */
        val hostReplayVTree: ByteArray? = null,
        /** `sdk.name` on the envelope. Simulator quick capture passes the host's identity
         *  (`everframe-flutter`) with host evidence, as `EFReporterFromImage` does for its reports. */
        val sdkName: String = "everframe-android",
        /** Real-device quick capture from a linked device: the link nonce and the `linkPending` callback.
         *  Null for every other submit. SECURITY: never log. */
        val deviceLink: dev.everframe.devicelink.DeviceLinkUpload? = null,
    ) {
        /** The generated `toString()` would print both credentials into any log
         *  or crash message that interpolates the inputs. */
        override fun toString(): String =
            "Inputs(activity=$activity, captureBitmap=$captureBitmap, capture=$capture, " +
                "extraShotPngs=${extraShotPngs.size}, title=$title, description=$description, " +
                "includeLogs=$includeLogs, includeNetwork=$includeNetwork, includeMetadata=$includeMetadata, " +
                "extraOverrides=$extraOverrides, hostExtra=$hostExtra, " +
                "capturedSession=$capturedSession, " +
                "excluded=$excluded, quickCapture=$quickCapture, captureToken=${redact(captureToken)}, " +
                "annotated=$annotated, hostReplayVTree=${hostReplayVTree?.let { "${it.size} bytes" }}, " +
                "sdkName=$sdkName, deviceLink=${deviceLink?.let { "<redacted>" }})"

        private fun redact(secret: String?): String? = secret?.let { "<redacted>" }
    }

    /**
     * Compose + submit. Returns the same `ReportResult` that
     * `ReportSubmitter.submit` returns. Wrapped in `txGuardSuspend` so any
     * internal failure surfaces as `ReportResult.Cancelled(...)` rather than
     * a thrown exception (DEFE-02 — submit guarantees never crash the host).
     */
    suspend fun submit(inputs: Inputs): ReportResult {
        try {
        // FOLLOW-UPS ITEM 9 — the config comes from the snapshot taken when the
        // paired submit frames arrived, NOT from a live `Everframe.currentConfig`
        // read here.
        //
        // `_config` carries the SDK KEY, i.e. the project every byte of this
        // report is uploaded to, and PNG encoding, device-metadata collection,
        // ring-buffer snapshotting and replay serialization all run between the
        // capture and this line. A `start(projectB)` landing in that window
        // used to repoint the upload at B while the payload was still A's
        // screenshot, UI tree, breadcrumbs and network rows.
        //
        // The epoch guard on the user half never covered this: it made
        // `resolve()` return null and shipped the report anonymously to B,
        // which reads like a mitigation and is not one. See
        // `ReporterDialog.submitBaked` for the in-app twin of this comment.
        val cfg = inputs.capturedSession.config
            ?: return ReportResult.Cancelled("no_config")

        // FOLLOW-UPS ITEM 9 — FAST PATH only. The authoritative check is the
        // one immediately before `submitter.submit(...)` far below; this one
        // exists so an already-revoked report does not pay for baking,
        // encoding, hashing and replay serialization first. A monotonic
        // counter, not `captureGate`, because `start()` re-opens that gate.
        if (inputs.capturedSession.isRevoked) return ReportResult.Cancelled("revoked")

        return txGuardSuspend("quick-capture-submit") {
            // 1. Encode baked PNG.
            val pngBytes = ByteArrayOutputStream().use { bos ->
                inputs.captureBitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)
                bos.toByteArray()
            }
            val sha = sha256Hex(pngBytes)

            // 2. Device metadata + form-factor classification (mirrors
            //    ReporterDialog.kt:259-261).
            val device = DeviceMetadata.collect(inputs.activity, cfg.debugBuild)

            // 3. Declare the screenshot attachment so parser.ts can pair the
            //    multipart 'screenshot' part with envelope.attachments[]
            //    (ReporterDialog.kt:267-275 parity).
            val screenshotKind = if (inputs.annotated) AttachmentKind.AnnotatedScreenshot else AttachmentKind.Screenshot
            val screenshotAttachment = Attachment(
                byteLength = pngBytes.size.toDouble(),
                contentType = "image/png",
                height = null,
                kind = screenshotKind,
                partName = "screenshot",
                sha256 = sha,
                width = null,
            )

            // 3b. The extra shots of a multi-shot submit. Named with the
            //     shared `partName` helper so the suffixes match what the web
            //     reporter and iOS produce, and what the admin payload card
            //     parses (`/^(annotated-screenshot|screenshot)(?:-(\d+))?$/`).
            // Shared transport admits the measured aggregate, including replay and envelope.
            val extraShotEncoded = inputs.extraShotPngs.take(3).mapIndexed { i, bytes ->
                Triple(partName("screenshot", i + 1), bytes, sha256Hex(bytes))
            }
            val extraShotAttachments = extraShotEncoded.map { (name, bytes, hex) ->
                Attachment(
                    byteLength = bytes.size.toDouble(),
                    contentType = "image/png",
                    height = null,
                    kind = screenshotKind,
                    partName = name,
                    sha256 = hex,
                    width = null,
                )
            }

            // 4a. Section gating — empty list / nil means "user toggled off"
            //     (ReporterDialog.kt:285-304 parity).
            // FOLLOW-UPS ITEM 9, SECOND ROUND (external review 2026-08-13,
            // codex). These two are the only LIVE process-global reads left on
            // this path — breadcrumbs and network bodies are frozen at
            // reporter-open and cannot pick up another session's content.
            // Pinning the config fixed A's report reaching B and opened a
            // narrower reverse direction: a `start(B)` between the Send tap
            // and these reads means the rows here were captured under B, and
            // they would ship under A's key. Drop them when the session has
            // moved on — not the whole report, which is still legitimately
            // A's. Same doctrine as `resolve()` degrading the user to
            // anonymous: lose data, never misroute it.
            val capturedLogs: List<EnvelopeBuilder.LogRow> =
                if (!inputs.includeLogs) emptyList() else sharedLogBuffer.snapshotForSession(inputs.capturedSession.user.startEpoch).map { e ->
                    EnvelopeBuilder.LogRow(
                        timestamp = e.timestamp,
                        level = e.level,
                        tag = e.tag,
                        message = e.message,
                    )
                }
            val capturedNetwork: List<EnvelopeBuilder.NetworkRow> =
                if (!inputs.includeNetwork) emptyList() else sharedNetworkBuffer.snapshotForSession(inputs.capturedSession.user.startEpoch).map { e ->
                    EnvelopeBuilder.NetworkRow(
                        method = e.method,
                        url = e.url,
                        status = e.status,
                        durationMs = e.durationMs.toDouble(),
                        requestHeaders = e.requestHeaders,
                        responseHeaders = e.responseHeaders,
                    )
                }
            val capturedNetworkBodies = if (inputs.includeNetwork && inputs.capture.matchesSession(inputs.capturedSession))
                inputs.capture.takeNetworkBodies() else null
            // Host replay follows `ReporterDialog.submitBaked`: the host's own authorization, its
            // timeline only while that allows replay, and never native video beside it.
            val hostReplayVTree = inputs.hostReplayVTree
            val hostAuthorization = hostReplayVTree?.let {
                ReportAuthorizationFactory.forHostReplay(inputs.capturedSession, inputs.capture)
            }
            val hostReplay = if (hostReplayVTree != null && hostAuthorization!!.evaluate().replayAllowed)
                HostImageVTreeAttachment.build(hostReplayVTree) else null
            val video = if (hostReplayVTree == null && inputs.capture.matchesSession(inputs.capturedSession)) {
                inputs.capture.exportVideo()?.let { NativeVideoAttachment().build(it) }
            } else null
            val replayPart = hostReplay?.second ?: video?.part
            val replayEnvelopeAttachment = hostReplay?.first ?: video?.envelope

            // 5. Build envelope — same EnvelopeBuilder call shape as
            //    ReporterDialog.kt:325-349 with the metadata gate applied via
            //    `excluded` so the parity remains visible.
            val builder = EnvelopeBuilder(EnvelopeBuilder.DefaultRedactor)
            // Defense-in-depth: clamp title/description to the Zod protocol caps
            // even if a programmatic caller bypassed the UI maxLength. take()
            // matches the Compose reporter's onValueChange filter so we never
            // ship envelopes the receiver would reject for length.
            val titleClamped = inputs.title.take(TITLE_MAX_CHARS)
            val descriptionClamped = inputs.description.take(DESCRIPTION_MAX_CHARS)
            val encoded = builder.buildEncoded(
                sdkVersion = Everframe.SDK_VERSION,
                sdkName = inputs.sdkName,
                title = titleClamped,
                description = descriptionClamped,
                formFactor = DeviceMetadata.formFactor(device),
                logs = capturedLogs,
                networkRows = capturedNetwork,
                networkBodies = capturedNetworkBodies,
                appName = (device["bundleIdentifier"] as? String) ?: "unknown",
                appVersion = (device["appVersion"] as? String) ?: "0.0.0",
                appBuild = (device["appBuild"] as? Number)?.toString(),
                appDebug = device["appDebug"] == "true",
                jsBundle = cfg.loadedJsBundle?.metadata,
                deviceOs = (device["os"] as? String) ?: "Android",
                deviceOsVersion = (device["osVersion"] as? String) ?: "0.0",
                deviceModel = device["model"] as? String,
                deviceLocale = (device["locale"] as? String)
                    ?: java.util.Locale.getDefault().toLanguageTag(),
                deviceTimezone = (device["timezone"] as? String)
                    ?: java.util.TimeZone.getDefault().id,
                deviceScreenWidth = (device["screenWidth"] as? Number)?.toDouble()
                    ?: inputs.captureBitmap.width.toDouble(),
                deviceScreenHeight = (device["screenHeight"] as? Number)?.toDouble()
                    ?: inputs.captureBitmap.height.toDouble(),
                devicePixelRatio = (device["pixelRatio"] as? Number)?.toDouble() ?: 1.0,
                attachments = listOfNotNull(screenshotAttachment, replayEnvelopeAttachment) + extraShotAttachments,
                // External review, finding 3 (Serious) — the snapshot taken at
                // the submit boundary, NEVER a live `Everframe.currentUser`
                // read. Everything above this line (PNG encode, device
                // metadata, ring-buffer snapshots, replay serialization) runs
                // after the capture; a live read here attributed the
                // report to whoever `setUser` named by the time composition
                // got round to it.
                //
                // External review, finding 1 (Serious) — `resolve()`, not the
                // raw snapshot. `cfg` (read at the top of this function)
                // carries the SDK key, i.e. the PROJECT this envelope is
                // uploaded to. A `start(projectB)` between the capture and that
                // read leaves the snapshot perfectly intact — `start()` clears
                // the LIVE user, not one already captured — so A's
                // id/email/display name would have shipped under B's key.
                // `resolve()` returns the user only while the session it was
                // captured in is still installed. Ordering is load-bearing: it
                // must stay AFTER the `cfg` read, because a still-matching
                // epoch is exactly what proves `cfg` belongs to that session.
                user = EnvelopeBuilder.TXUserExtras.from(inputs.capturedSession.user.resolve()),
                userExtra = inputs.hostExtra,
                excluded = inputs.excluded,
                // Ancillary data belongs to the exact reporter-open owner.
                breadcrumbs = if (inputs.capture.matchesSession(inputs.capturedSession)) inputs.capture.takeBreadcrumbs() else null,
                state = if (inputs.capture.matchesSession(inputs.capturedSession)) inputs.capture.takeState() else null,
                // Report Resource Window (spec 2026-09-05) — gap class 3: quick
                // capture is a user-submitted-report build site too
                // (the feature's primary use case), so it must stamp
                // resources the same as ReporterDialog.kt. `snapshot()` never
                // throws and returns an empty list when the sampler is
                // off/never started.
                resources = sharedResourceBuffer.snapshot(),
                quickCapture = inputs.quickCapture,
            )

            // 6. Ship via ReportSubmitter (isolated OkHttpClient — no
            //    self-capture).
            val outbox = JSONLOutbox(inputs.activity.applicationContext)
            val submitter = __submitterFactoryForTesting?.invoke(cfg, outbox)
                ?: ReportSubmitter(cfg, outbox).__observingDelivery(inputs.capturedSession.user.startEpoch)

            // FOLLOW-UPS ITEM 9, FIFTH ROUND (external review 2026-08-13,
            // codex). THIS is the authoritative revocation check — immediately
            // before the upload, after every expensive assembly stage.
            //
            // The check near the top of this function is a FAST PATH only: it
            // avoids seconds of baking, encoding, hashing and replay
            // serialization for a report that is already revoked. It cannot be
            // the guarantee, because all of that work happens after it, and a
            // `kill()` landing during it would sail straight past. Earlier
            // rounds of this item placed only that early check here while the
            // comment claimed "the submit boundary" — the comment described
            // iOS's placement, not this one.
            //
            // Not covered by anything downstream: `ReportSubmitter`'s own
            // `captureGate` read is a boolean, and `start()` re-opens it, so a
            // `kill()` -> `start(B)` sequence during assembly leaves the gate
            // open. Only the monotonic counter behind `isRevoked` sees it.
            if (inputs.capturedSession.isRevoked) return@txGuardSuspend ReportResult.Cancelled("revoked")
            val screenshotPart = ReportSubmitter.Attachment(
                name = "screenshot",
                filename = "screenshot.png",
                contentType = "image/png",
                data = pngBytes,
                sha256Hex = sha,
            )
            val extraShotParts = extraShotEncoded.map { (name, bytes, hex) ->
                ReportSubmitter.Attachment(
                    name = name,
                    filename = "$name.png",
                    contentType = "image/png",
                    data = bytes,
                    sha256Hex = hex,
                )
            }
            // Native identity Task 8b — the live submit boundary. Resolve the
            // `X-Everframe-Identity-Token` value HERE, against the subject captured
            // at `report.request` time
            // (`inputs.capturedSession.user.identitySubject`), NEVER a live
            // `Everframe._identityHolder.cachedSubject(...)` read — same
            // capture-time-not-submit-time rule
            // `capturedSession.user.resolve()` enforces for the self-declared
            // user just above, for the identical reason: an identity change
            // landing in the seconds-to-minutes this composer can run for
            // must not repoint an in-flight report. `resolveIdentityHeader`
            // itself is what refuses the header on any subject mismatch.
            //
            // Merge note (native-identity x captured-session): the identity
            // subject rides the SAME `TXCapturedSession.user` field the
            // self-declared-user resolution above already reads, not a
            // second, independently-captured value.
            //
            // Final whole-branch review, Important 2 — routed through
            // `Everframe.__resolveIdentityToken`, not a direct
            // `resolveIdentityHeader` call, so
            // `inputs.capturedSession.user.startEpoch` is also checked: a
            // `start(projectB)` landing since this report's submit boundary
            // must withhold the header outright, exactly like
            // `capturedSession.user.resolve()` already withholds the
            // self-declared user in that case — a subject match alone is not
            // enough (`sub` is the host's own user id, typically unchanged
            // across a tenant or dev/prod switch).
            // Independent review, P1 — the PERSISTED `identitySubject` (what
            // survives onto a queued `OutboxEntry` on transient failure) must
            // be gated by the SAME epoch decision as the token, not the raw
            // captured value unconditionally: an epoch mismatch means the
            // SDK already concluded the whole snapshot is untrustworthy — the
            // same conclusion `capturedSession.user.resolve()` acts on for
            // the user above. Without this, a queued entry could carry a
            // subject the live check had already decided to distrust, and a
            // LATER drain could attach a header on the strength of it.
            val identity = Everframe.__resolveIdentityToken(
                capturedSubject = inputs.capturedSession.user.identitySubject,
                capturedEpoch = inputs.capturedSession.user.startEpoch,
            )
            submitter.submit(
                envelopeBytes = encoded.bytes,
                idempotencyKey = encoded.idempotencyKey,
                attachments = listOfNotNull(screenshotPart, replayPart) + extraShotParts,
                identitySubject = if (identity.epochStillCurrent) inputs.capturedSession.user.identitySubject else null,
                identityToken = identity.token,
                authorization = hostAuthorization
                    ?: ReportAuthorizationFactory.forCapture(inputs.capturedSession, inputs.capture),
                // SECURITY: never log. Live upload only; see ReportSubmitter.submit.
                captureToken = inputs.captureToken,
                deviceLink = inputs.deviceLink,
            )
        } ?: ReportResult.Cancelled("submit_guard_failed")
        } finally { inputs.capture.finishConsumption() }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(bytes)
        return buildString(digest.size * 2) {
            for (b in digest) {
                val v = b.toInt() and 0xFF
                append(HEX[v ushr 4])
                append(HEX[v and 0x0F])
            }
        }
    }

    private val HEX = charArrayOf(
        '0', '1', '2', '3', '4', '5', '6', '7',
        '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
    )
}
