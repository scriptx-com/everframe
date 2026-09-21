// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-13 Task 2 — shared envelope-build + submit pipeline for the
// Android companion path.
//
// Mirrors iOS `ReporterSubmission.swift` (Plan 06.2-12). On iOS the companion
// bridge and the in-process modal call the SAME `ReporterSubmission.submit(...)`
// because both live in the `TraceItX` module. On Android the modal's submit
// composition lives inline inside `ReporterDialog.kt:285-325` in the
// `:traceitx-reporter-ui` module — which `:traceitx-core` (where the companion
// bridge lives) CANNOT depend on without inverting the module graph.
//
// Design choice (Plan 06.2-13 §<tasks> Task 2 step 4): leave ReporterDialog
// inline composition UNTOUCHED for now and ship this composer as a near-copy
// specifically for the companion path. Rationale:
//   • ReporterDialog's submit codepath is already shipping and exercised
//     end-to-end (Plan 04, 05, 06.1). Refactoring it to consume this composer
//     would touch a regression-sensitive path during a UAT-driven plan.
//   • The composer is in :traceitx-core; ReporterDialog is in :traceitx-
//     reporter-ui. To have ReporterDialog call this composer we'd need to
//     either move the `ReporterIncludes` data class down into :traceitx-core
//     (touches the UI module's public surface) or shape the composer's
//     `Inputs` to avoid the UI type (which is what we do below — raw booleans).
//   • The duplication is small (~40 lines of envelope-build glue). When a
//     third caller appears we can promote.
//
// Documented as a deliberate, time-boxed duplication in 06.2-13-SUMMARY.md.
//
// ENVELOPE PARITY INVARIANT: this file's `submit(...)` MUST produce a
// byte-identical envelope to ReporterDialog.kt's inline composition for the
// same Inputs. Any field added there must be added here. A CI grep could
// later enforce that both call EnvelopeBuilder().buildEncoded with the same
// argument list — for now, code review + the documented duplication is the
// guardrail.

package com.traceitx.companion

import android.app.Activity
import android.graphics.Bitmap
import com.traceitx.TraceItX
import com.traceitx.capture.video.FrozenReportCapture
import com.traceitx.capture.video.NativeVideoAttachment
import com.traceitx.transport.ReportAuthorizationFactory
import com.traceitx.capture.DeviceMetadata
import com.traceitx.capture.sharedLogBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.ReportResult
import com.traceitx.config.TraceItXConfig
import com.traceitx.envelope.EnvelopeBuilder
import com.traceitx.envelope.partName
import com.traceitx.envelope.txGuardSuspend
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.protocol.generated.Attachment
import com.traceitx.protocol.generated.AttachmentKind
import com.traceitx.transport.ReportSubmitter
import kotlinx.serialization.json.Json
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * Singleton submit pipeline for the companion path. Stateless — every call
 * builds a fresh `EnvelopeBuilder` + `ReportSubmitter`. Mirrors iOS
 * `ReporterSubmission` (an `enum` without cases — Swift's idiom for a
 * namespace; Kotlin's idiom is `object`).
 */
/** Hard cap on report title length. Matches the Zod protocol schema and every UI surface. */
private const val TITLE_MAX_CHARS: Int = 200
/** Hard cap on report description length. Matches the Zod protocol schema and every UI surface. */
private const val DESCRIPTION_MAX_CHARS: Int = 600

object CompanionSubmissionComposer {

    /**
     * Test seam — supplies the [ReportSubmitter] this composer ships through.
     * Production leaves it null and the composer builds its own (whose ingest
     * endpoint is the build-time-baked [com.traceitx.config.IngestEndpoint.url]
     * and therefore not redirectable at runtime).
     *
     * It exists so a test can point the real submit at a local server and
     * assert on the request it receives — in particular that the
     * `X-TX-Companion-Attribution` header carries the token snapshotted for
     * that report. Nothing is short-circuited: the composer still builds the
     * whole envelope and still calls `submit(…, companionAttribution =
     * inputs.companionAttribution)` on whatever submitter it is handed.
     */
    @JvmStatic
    internal var __submitterFactoryForTesting: ((TraceItXConfig, JSONLOutbox) -> ReportSubmitter)? = null

    /**
     * One companion submit's inputs. Field order + types mirror iOS
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
         * Baked PNGs for the EXTRA shots of a multi-shot submit, in the order
         * the phone announced them in `report.submit.shots[]`.
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
        /** Host-attached opaque metadata string. Consumed by the bridge at
         *  `report.request` time via `TraceItX.consumePendingAttachments()`
         *  and threaded through here. */
        val hostExtra: String?,
        /**
         * Companion attribution token for THIS report — snapshotted by
         * `RelayWSClient` when the report's `report.request` arrived and
         * carried here by `CompanionCaptureBridge.__submitProvider`. Null on
         * an ordinary QR bond, and null whenever the snapshot could not be
         * matched; both mean "ship unattributed", never an error.
         *
         * Deliberately has NO default: every caller must state what this
         * report is attributed to. A default of null would let a new call
         * site silently drop attribution, and a default of "read the live
         * session" is the exact defect this parameter exists to prevent.
         *
         * SECURITY: never log.
         */
        val companionAttribution: String?,
        /**
         * Self-declared user (`setUser`, spec 2026-08-12) SNAPSHOTTED at the
         * moment this report's submission began — when the paired
         * `report.submit` + binary frames arrived, before any decode/bake.
         *
         * External review, finding 3 (Serious). This composer used to read
         * `TraceItX.currentUser` inline, after PNG encoding, device-metadata
         * collection, ring-buffer snapshotting and replay serialization. Those
         * stages can span hundreds of milliseconds to seconds, and a `setUser`
         * call landing in that window (sign-out/sign-in, account switch)
         * permanently grouped A's report under B.
         *
         * Deliberately has NO default, for exactly the reason spelled out on
         * [companionAttribution] above: every caller must state who this report
         * belongs to. A default of "read the live singleton" is the precise
         * defect this field exists to prevent, and a default of `null` would
         * let a new submit surface silently ship anonymous.
         *
         * `TXUser` is an immutable data class, so holding it here is already a
         * snapshot; the native counterpart of web's `captureUserSnapshot`.
         *
         * External review, finding 1 (Serious) — carries the SESSION it was
         * captured in ([com.traceitx.TXCapturedUser]), not a bare `TXUser?`.
         * `cfg` below carries the SDK key, i.e. the destination PROJECT, and is
         * read asynchronously after the capture; `resolve()` drops the user if
         * a `start()`/`kill()` landed in between, so a snapshot can never be
         * uploaded under another project's key.
         */
        val capturedSession: com.traceitx.TXCapturedSession,
        /** Sections the user explicitly toggled off in the reporter UI.
         *  Lands in `captureControl.excluded`. Companion currently does not
         *  surface toggles per-section (the phone reporter SPA sends a flat
         *  `includes` map), so this is derived from the booleans above. */
        val excluded: List<String> = emptyList(),
    )

    /**
     * Compose + submit. Returns the same `ReportResult` that
     * `ReportSubmitter.submit` returns. Wrapped in `txGuardSuspend` so any
     * internal failure surfaces as `ReportResult.Cancelled(...)` rather than
     * a thrown exception (DEFE-02 — submit guarantees never crash the host).
     */
    suspend fun submit(inputs: Inputs): ReportResult {
        try {
        // FOLLOW-UPS ITEM 9 — the config comes from the snapshot taken when the
        // paired submit frames arrived, NOT from a live `TraceItX.currentConfig`
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

        return txGuardSuspend("companion-submit") {
            // 1. Encode baked PNG.
            val pngBytes = ByteArrayOutputStream().use { bos ->
                inputs.captureBitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)
                bos.toByteArray()
            }
            val sha = sha256Hex(pngBytes)

            // 2. Device metadata + form-factor classification (mirrors
            //    ReporterDialog.kt:259-261).
            val device = DeviceMetadata.collect(inputs.activity)
            val isTablet =
                inputs.activity.resources.configuration.smallestScreenWidthDp >= 600

            // 3. Declare the screenshot attachment so parser.ts can pair the
            //    multipart 'screenshot' part with envelope.attachments[]
            //    (ReporterDialog.kt:267-275 parity).
            val screenshotAttachment = Attachment(
                byteLength = pngBytes.size.toDouble(),
                contentType = "image/png",
                height = null,
                kind = AttachmentKind.AnnotatedScreenshot,
                partName = "screenshot",
                sha256 = sha,
                width = null,
            )

            // 3b. The extra shots of a multi-shot submit. Named with the
            //     shared `partName` helper so the suffixes match what the web
            //     reporter and iOS produce, and what the admin payload card
            //     parses (`/^(annotated-screenshot|screenshot)(?:-(\d+))?$/`).
            //     Before this the phone's extra shots were dropped on the
            //     device and the report completed with only the primary image.
            // Shared transport admits the measured aggregate, including replay and envelope.
            val extraShotEncoded = inputs.extraShotPngs.take(3).mapIndexed { i, bytes ->
                Triple(partName("screenshot", i + 1), bytes, sha256Hex(bytes))
            }
            val extraShotAttachments = extraShotEncoded.map { (name, bytes, hex) ->
                Attachment(
                    byteLength = bytes.size.toDouble(),
                    contentType = "image/png",
                    height = null,
                    kind = AttachmentKind.AnnotatedScreenshot,
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
            val video = if (inputs.capture.matchesSession(inputs.capturedSession)) {
                inputs.capture.exportVideo()?.let { NativeVideoAttachment().build(it) }
            } else null
            val replayPart = video?.part
            val replayEnvelopeAttachment = video?.envelope

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
                sdkVersion = TraceItX.SDK_VERSION,
                title = titleClamped,
                description = descriptionClamped,
                formFactor = if (isTablet) "tablet" else "phone",
                logs = capturedLogs,
                networkRows = capturedNetwork,
                networkBodies = capturedNetworkBodies,
                appName = (device["bundleIdentifier"] as? String) ?: "unknown",
                appVersion = (device["appVersion"] as? String) ?: "0.0.0",
                appBuild = (device["appBuild"] as? Number)?.toString(),
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
                // the submit boundary, NEVER a live `TraceItX.currentUser`
                // read. Everything above this line (PNG encode, device
                // metadata, ring-buffer snapshots, replay serialization) runs
                // after the phone tapped Send; a live read here attributed the
                // report to whoever `setUser` named by the time composition
                // got round to it. Sibling of `inputs.companionAttribution`,
                // pinned for the same class of reason.
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
                // Report Resource Window (spec 2026-09-05) — gap class 3: the
                // companion widget is a user-submitted-report build site too
                // (the feature's primary use case), so it must stamp
                // resources the same as ReporterDialog.kt. `snapshot()` never
                // throws and returns an empty list when the sampler is
                // off/never started.
                resources = sharedResourceBuffer.snapshot(),
            )

            // 6. Ship via ReportSubmitter (isolated OkHttpClient — no
            //    self-capture).
            val outbox = JSONLOutbox(inputs.activity.applicationContext)
            val submitter = __submitterFactoryForTesting?.invoke(cfg, outbox)
                ?: ReportSubmitter(cfg, outbox)

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
            // `X-TX-Identity-Token` value HERE, against the subject captured
            // at `report.request` time
            // (`inputs.capturedSession.user.identitySubject`), NEVER a live
            // `TraceItX._identityHolder.cachedSubject(...)` read — same
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
            // `TraceItX.__resolveIdentityToken`, not a direct
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
            val identity = TraceItX.__resolveIdentityToken(
                capturedSubject = inputs.capturedSession.user.identitySubject,
                capturedEpoch = inputs.capturedSession.user.startEpoch,
            )
            submitter.submit(
                envelopeBytes = encoded.bytes,
                idempotencyKey = encoded.idempotencyKey,
                attachments = listOfNotNull(screenshotPart, replayPart) + extraShotParts,
                // Companion attribution (spec 2026-08-07) — the token minted
                // for THIS report's `report.request`, snapshotted there and
                // carried through the bridge into `Inputs`. Null on an
                // ordinary QR bond. Rides the ingest POST as
                // `X-TX-Companion-Attribution`.
                //
                // MUST NOT be re-read from the live relay session here
                // (PR-fix 1): this line runs seconds-to-minutes after the
                // report was requested, and by then the pair may have been
                // released and re-bonded to a different dashboard user. A
                // late read hands this report that user's single-use token —
                // mis-crediting this report and burning the token their own
                // next report needed.
                // SECURITY: never log.
                companionAttribution = inputs.companionAttribution,
                identitySubject = if (identity.epochStillCurrent) inputs.capturedSession.user.identitySubject else null,
                identityToken = identity.token,
                authorization = ReportAuthorizationFactory.forCapture(inputs.capturedSession, inputs.capture),
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
