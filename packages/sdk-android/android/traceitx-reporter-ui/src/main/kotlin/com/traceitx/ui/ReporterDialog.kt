// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReporterDialog — bridges the imperative `presenter.openReporter(activity)`
// suspend call to the Compose ReporterRoot. Constructs a Material 3
// AlertDialog-style modal hosted by ComponentActivity's Compose surface,
// then suspends the caller until the user submits or cancels.
//
// At submit time:
//   • Annotation strokes + blur rects are baked into the screenshot bitmap
//   • Envelope is built via EnvelopeBuilder.buildEncoded
//   • ReportSubmitter.submit() ships the envelope + baked PNG attachment
//   • The suspending caller resolves to ReportResult.{Submitted|Queued|Cancelled}
package com.traceitx.ui

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.traceitx.TraceItX
import com.traceitx.capture.ScreenshotCapture
import com.traceitx.capture.video.FrozenReportCapture
import com.traceitx.capture.video.NativeVideoAttachment
import com.traceitx.transport.ReportAuthorizationFactory
import com.traceitx.capture.DeviceMetadata
import com.traceitx.capture.sharedLogBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.ReportResult
import com.traceitx.envelope.EnvelopeBuilder
import com.traceitx.envelope.buildAttachmentPlan
import com.traceitx.envelope.txGuardSuspend
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.transport.ReportSubmitter
import com.traceitx.ui.annotation.Annotation
import com.traceitx.ui.annotation.AnnotationWireFormat
import com.traceitx.ui.annotation.BakeRenderer
import com.traceitx.ui.annotation.toJsonArrayOrNull
import com.traceitx.ui.theme.ProvideReporterTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * One screenshot as handed off from [ReporterRoot] to [ReporterDialog.submitBaked]
 * at submit time (Task 9 — multi-shot wire format). [bitmap] is the shot's
 * RAW source pixels (never pre-baked) — submitBaked bakes fresh per shot on
 * Dispatchers.Default (DEFE-02-wrapped) so the wire never depends on the UI's
 * `bakedPreview` cache.
 */
internal data class SubmittedShot(
    val bitmap: Bitmap,
    val annotations: List<Annotation>,
)

internal object ReporterDialog {

    /**
     * Test seam (final whole-branch review, Important 2) — when non-null,
     * `submitBaked` constructs its `ReportSubmitter` through this factory
     * instead of `ReportSubmitter(cfg, outbox)` directly. Production leaves
     * it null. Mirrors `CompanionSubmissionComposer.__submitterFactoryForTesting`
     * one module up — it exists so a test can point the real submit at a
     * local server and assert on the request it receives (in particular,
     * that `X-TX-Identity-Token` is withheld when the captured session's
     * epoch no longer matches the live one). Nothing is short-circuited: the
     * dialog still builds the whole envelope and still calls `submit(...)`
     * on whatever submitter it is handed.
     */
    internal var __submitterFactoryForTesting: ((com.traceitx.config.TraceItXConfig, JSONLOutbox) -> ReportSubmitter)? = null

    /**
     * Show the reporter dialog and suspend until the user submits or cancels.
     *
     * Implementation: attach a transient ComposeView to the Activity's
     * `android.R.id.content` ViewGroup. The ComposeView hosts an
     * `androidx.compose.ui.window.Dialog` (with `DialogProperties(
     * dismissOnClickOutside = false, dismissOnBackPress = true)` per UI-SPEC)
     * containing `ReporterRoot`. A `BackHandler` intercepts the system Back
     * gesture: if title or description is non-empty, a Material 3 AlertDialog
     * confirms discard before resolving `Cancelled("user_cancelled")`;
     * otherwise the back press dismisses silently.
     */
    suspend fun show(
        activity: Activity,
        capture: ScreenshotCapture.CaptureResult,
        reportCapture: FrozenReportCapture,
        hostExtra: String? = null,
    ): ReportResult {
        val deferred = CompletableDeferred<ReportResult>()

        // Attach the ComposeView on the main thread.
        withContext(Dispatchers.Main) {
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
                ?: run {
                    deferred.complete(ReportResult.Cancelled("no_content_view"))
                    return@withContext
                }
            val composeView = ComposeView(activity).apply {
                // DisposeOnDetachedFromWindow — when we removeView() this host,
                // the Composition (and its child Compose Dialog window) disposes
                // synchronously. The previous strategy
                // (DisposeOnViewTreeLifecycleDestroyed) waited for Activity
                // DESTROYED, which never fires during normal submit, leaving the
                // Dialog window open and the host app looking "frozen" behind it.
                setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setContent {
                    MaterialTheme {
                        ReporterDialogContent(
                            activity = activity,
                            capture = capture,
                            reportCapture = reportCapture,
                            hostExtra = hostExtra,
                            onCancel = {
                                content.removeView(this)
                                // Discard the frozen replay window and resume
                                // buffering for the next report (no-op when OFF).
                                reportCapture.cancel()
                                deferred.complete(ReportResult.Cancelled("user_cancelled"))
                            },
                            onSubmit = { title, description, shots, includes ->
                                content.removeView(this)
                                // External review, finding 3 (Serious) — THE
                                // SUBMIT BOUNDARY. Read synchronously here, on
                                // the Send tap, BEFORE the coroutine launch
                                // below: `submitBaked` bakes every shot,
                                // encodes to WebP/JPEG/PNG, hashes, serializes
                                // the replay timeline and builds the envelope,
                                // which can span hundreds of milliseconds to
                                // seconds. A `setUser` landing anywhere in that
                                // window used to repoint the finished report at
                                // the new account. `TXUser` is an immutable
                                // data class, so this is a snapshot by
                                // construction — the native counterpart of
                                // web's `captureUserSnapshot`.
                                //
                                // External review, finding 1 (Serious) —
                                // `captureUserSnapshot()`, not `currentUser`:
                                // it reads the user and the SESSION EPOCH in
                                // one `stateLock` critical section, so the
                                // snapshot knows which session (and therefore
                                // which project's SDK key) it belongs to.
                                // `submitBaked` reads the config on the other
                                // side of the launch below; a `start(projectB)`
                                // in that window would otherwise have uploaded
                                // this user under B's key. See
                                // `TXCapturedUser.kt`.
                                val capturedSession = TraceItX.captureSessionSnapshot()
                                // Default dispatcher for the CPU-bound stages
                                // (per-shot bake + PNG/WebP/JPEG encode, SHA-256,
                                // EnvelopeBuilder.buildEncoded JSON serialization).
                                // The MultipartUploader inside ReportSubmitter
                                // already hops to Dispatchers.IO for the network leg.
                                MainScope().launch(Dispatchers.Default) {
                                    val r = submitBaked(
                                        activity = activity,
                                        capture = capture,
                                        reportCapture = reportCapture,
                                        shots = shots,
                                        title = title,
                                        description = description,
                                        capturedSession = capturedSession,
                                        hostExtra = hostExtra,
                                        includes = includes,
                                    )
                                    deferred.complete(r)
                                }
                            },
                        )
                    }
                }
            }
            content.addView(composeView)
        }

        return deferred.await()
    }

    /**
     * Wraps ReporterRoot in a Compose Dialog with the UI-SPEC properties
     * and a dirty-check BackHandler (T-05-06-D mitigation parity).
     */
    @Composable
    private fun ReporterDialogContent(
        activity: Activity,
        capture: ScreenshotCapture.CaptureResult,
        reportCapture: FrozenReportCapture,
        hostExtra: String?,
        onCancel: () -> Unit,
        onSubmit: (
            title: String,
            description: String,
            shots: List<SubmittedShot>,
            includes: com.traceitx.ui.details.ReporterIncludes,
        ) -> Unit,
    ) {
        var lastTitle by remember { mutableStateOf("") }
        var lastDescription by remember { mutableStateOf("") }
        var showDiscardConfirm by remember { mutableStateOf(false) }

        Dialog(
            onDismissRequest = {
                // System back triggers this when dismissOnBackPress = true.
                if (lastTitle.isNotBlank() || lastDescription.isNotBlank()) {
                    showDiscardConfirm = true
                } else {
                    onCancel()
                }
            },
            properties = DialogProperties(
                dismissOnBackPress = true,
                dismissOnClickOutside = false,
                usePlatformDefaultWidth = false,
                // Review finding (Task 6 IME regression): without this, the
                // Dialog's child Window keeps SOFT_INPUT_ADJUST_UNSPECIFIED
                // and WindowInsets.ime always reads 0 inside it, so Task 6's
                // keyboard-avoidance (FocusedAnnotation's canvasShift +
                // TextEditOverlay's imePadding()) is inert on-device. Setting
                // this to false lets Compose dispatch real IME insets into
                // this window. Trade-off: the window no longer auto-fits
                // system bars either, so ReporterRoot now explicitly insets
                // the composer's top bar (statusBarsPadding) and floating
                // Send footer (navigationBarsPadding + imePadding) — see
                // ReporterRoot.kt. FocusedAnnotation is a deliberate
                // fullscreen takeover and is NOT inset by this change (its
                // top bar already reserves a fixed 60dp for the status bar
                // by design).
                decorFitsSystemWindows = false,
            ),
        ) {
            // BackHandler is redundant with dismissOnBackPress + onDismissRequest,
            // but listed in the plan's <action> step 3; included for parity.
            BackHandler(enabled = true) {
                if (lastTitle.isNotBlank() || lastDescription.isNotBlank()) {
                    showDiscardConfirm = true
                } else {
                    onCancel()
                }
            }
            ReporterRoot(
                capture = capture,
                reportCapture = reportCapture,
                activity = activity,
                hostExtra = hostExtra,
                onCancel = {
                    if (lastTitle.isNotBlank() || lastDescription.isNotBlank()) {
                        showDiscardConfirm = true
                    } else {
                        onCancel()
                    }
                },
                onSubmit = { title, description, shots, includes ->
                    lastTitle = title
                    lastDescription = description
                    onSubmit(title, description, shots, includes)
                },
                trackText = { t, d ->
                    lastTitle = t
                    lastDescription = d
                },
            )
        }

        if (showDiscardConfirm) {
            // Phase 13 D10: brand-styled discard dialog replaces the prior
            // Material 3 AlertDialog. Same dirty-state trigger
            // (lastTitle / lastDescription tracked via trackText), same
            // T-05-06-D mitigation surface — only the visual changes.
            //
            // External review finding 2 (2026-08-26): this dialog is a
            // sibling of the Dialog(...) block above, not a descendant of
            // ReporterRoot's composition — so it sat outside
            // ReporterRoot's theme provider and always rendered DEFAULT
            // colors for themed (paid) customers, ignoring a theme that
            // landed while the dialog was open. ProvideReporterTheme
            // (com.traceitx.ui.theme) is the same provider ReporterRoot's
            // body wraps in, so this now resolves and stays live-in-sync
            // with it.
            ProvideReporterTheme {
                com.traceitx.ui.details.DiscardConfirmDialog(
                    onKeepEditing = { showDiscardConfirm = false },
                    onDiscard = {
                        showDiscardConfirm = false
                        onCancel()
                    },
                )
            }
        }
    }

    /**
     * Build the envelope from the submitted shots + Activity-derived
     * metadata and ship it via ReportSubmitter. Errors become
     * ReportResult.Cancelled so the suspending caller never throws
     * (DEFE-02 surface).
     *
     * Multi-shot wire format (Task 9): one screenshot/annotated-screenshot
     * multipart part + envelope Attachment PER shot in [shots], in order.
     * `buildAttachmentPlan` derives each shot's AttachmentKind (annotated
     * iff that shot carries >=1 annotation) and part name (shot 1 bare,
     * shots 2+ "-N", N = 1-based index) from a pure `List<Boolean>` — zipped
     * here against the real (byte-carrying) shots to build the actual
     * attachments. Each shot's annotations are baked FRESH here (never from
     * the UI's `bakedPreview` cache — see [SubmittedShot]) and serialized
     * via [AnnotationWireFormat], concatenating into the envelope's
     * `payload.annotations` / `payload.redactions`.
     */
    // `internal` rather than `private` ONLY so this module's own unit tests can
    // drive it directly (`ReporterDialogSubmitBoundaryTest`) — the whole point
    // of `capturedSession` is a behaviour that cannot be observed from outside
    // this function. Still module-private to consumers.
    internal suspend fun submitBaked(
        activity: Activity,
        capture: ScreenshotCapture.CaptureResult,
        reportCapture: FrozenReportCapture,
        shots: List<SubmittedShot>,
        title: String,
        description: String,
        /**
         * Self-declared user (`setUser`) SNAPSHOTTED at the Send tap by the
         * caller — never re-read from `TraceItX.currentUser` in here. See the
         * capture site in [show]'s `onSubmit` for why (external review,
         * finding 3). No default: every caller must state who the report
         * belongs to.
         *
         * External review, finding 1 (Serious) — carries the SESSION it was
         * captured in ([com.traceitx.TXCapturedUser]), not a bare `TXUser?`.
         * `cfg` below carries the SDK key, i.e. the destination PROJECT, and
         * is read on this side of the Send tap; `resolve()` drops the user if
         * a `start()`/`kill()` landed in between.
         */
        capturedSession: com.traceitx.TXCapturedSession,
        hostExtra: String?,
        includes: com.traceitx.ui.details.ReporterIncludes,
    ): ReportResult {
        try {
        // FOLLOW-UPS ITEM 9 — the config comes from the snapshot taken at the
        // Send tap, NOT from a live `TraceItX.currentConfig` read here.
        //
        // `_config` carries the SDK KEY, i.e. the project every byte of this
        // report is uploaded to, and everything between the tap and this line
        // — per-shot bake, WebP/JPEG/PNG encode, SHA-256, replay gzip,
        // ring-buffer snapshotting — runs on `Dispatchers.Default` for
        // hundreds of milliseconds to seconds. A `start(projectB)` landing in
        // that window used to repoint the whole upload at B while the payload
        // was still A's screenshot, UI tree, breadcrumbs and network rows.
        //
        // The epoch guard on the user half never covered this: it made
        // `resolve()` return null and shipped the report anonymously to B,
        // which reads like a mitigation and is not one — an anonymous
        // screenshot of project A's app in project B's inbox is the same
        // disclosure.
        val cfg = capturedSession.config
            ?: return ReportResult.Cancelled("no_config")

        // FOLLOW-UPS ITEM 9 — FAST PATH only. The authoritative check is the
        // one immediately before `submitter.submit(...)` far below; this one
        // exists so an already-revoked report does not pay for baking,
        // encoding, hashing and replay serialization first. A monotonic
        // counter, not `captureGate`, because `start()` re-opens that gate.
        if (capturedSession.isRevoked) return ReportResult.Cancelled("revoked")

        return txGuardSuspend("dialog-submit") {
            // 1. Per-shot bake + encode + wire-format. Cascade per shot:
            //    WEBP_LOSSY (API 30+) → legacy WEBP (24-29, lossy when
            //    quality<100) → JPEG @ q=85 → PNG. WebP is the storage win
            //    (~70-80% byte reduction vs PNG); the cascade lets us serve
            //    every supported Android version without branching at the
            //    call site.
            val plan = buildAttachmentPlan(shots.map { it.annotations.isNotEmpty() })
            val screenshotEnvelopeAttachments = mutableListOf<com.traceitx.protocol.generated.Attachment>()
            val screenshotParts = mutableListOf<ReportSubmitter.Attachment>()
            val allAnnotationsJson = mutableListOf<JsonObject>()
            val allRedactionsJson = mutableListOf<JsonObject>()
            for ((index, shot) in shots.withIndex()) {
                val entry = plan[index]
                val annotated = shot.annotations.isNotEmpty()
                // DEFE-02: bake failure ships the unbaked source bitmap
                // rather than failing the whole submit.
                val bitmap = if (annotated) {
                    runCatching { BakeRenderer.bake(shot.bitmap, shot.annotations) }.getOrDefault(shot.bitmap)
                } else {
                    shot.bitmap
                }
                val (bytes, mime, ext) = encodeBakedImageForStorage(bitmap)
                val sha = sha256Hex(bytes)
                screenshotEnvelopeAttachments.add(
                    com.traceitx.protocol.generated.Attachment(
                        byteLength = bytes.size.toDouble(),
                        contentType = mime,
                        height = bitmap.height.toDouble(),
                        kind = entry.kind,
                        partName = entry.partName,
                        sha256 = sha,
                        width = bitmap.width.toDouble(),
                    )
                )
                screenshotParts.add(
                    ReportSubmitter.Attachment(
                        name = entry.partName,
                        filename = "${entry.partName}.$ext",
                        contentType = mime,
                        data = bytes,
                        sha256Hex = sha,
                    )
                )
                val wire = AnnotationWireFormat.serialize(shot.annotations, entry.partName)
                allAnnotationsJson += wire.annotations
                allRedactionsJson += wire.redactions
            }

            // 2. Device metadata snapshot.
            val device = DeviceMetadata.collect(activity)
            val isTablet = activity.resources.configuration.smallestScreenWidthDp >= 600

            // Select only the reporter-open owner's video; transport revalidates its live generation.
            val video = if (reportCapture.matchesSession(capturedSession)) {
                reportCapture.exportVideo()?.let { NativeVideoAttachment().build(it) }
            } else null
            val replayPart = video?.part
            val replayEnvelopeAttachment = video?.envelope

            // 4. Build envelope.
            // 4a. Pull captured logs + network metadata from the shared ring
            //     buffers. Without this the reporter ships an empty `logs[]` /
            //     `network[]` even when LogCapture and TraceItXInterceptor
            //     have been busy — the buffers are filled but never read.
            //     User-toggled-off sections become empty lists / nil values
            //     so they're absent from the envelope; their keys land in
            //     captureControl.excluded for backend signal.
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
            val capturedLogs: List<EnvelopeBuilder.LogRow> = if (!includes.logs) emptyList() else
                sharedLogBuffer.snapshotForSession(capturedSession.user.startEpoch).map { entry ->
                    EnvelopeBuilder.LogRow(
                        timestamp = entry.timestamp,
                        level = entry.level,
                        tag = entry.tag,
                        message = entry.message,
                    )
                }
            val capturedNetwork: List<EnvelopeBuilder.NetworkRow> = if (!includes.network) emptyList() else
                sharedNetworkBuffer.snapshotForSession(capturedSession.user.startEpoch).map { e ->
                    EnvelopeBuilder.NetworkRow(
                        method = e.method,
                        url = e.url,
                        status = e.status,
                        durationMs = e.durationMs.toDouble(),
                        requestHeaders = e.requestHeaders,
                        responseHeaders = e.responseHeaders,
                    )
                }
            val capturedNetworkBodies = if (includes.network && reportCapture.matchesSession(capturedSession))
                reportCapture.takeNetworkBodies() else null

            // Host-attached sticky payload — threaded through from the
            // presenter (TXReporterPresenter.openReporter), which is the
            // single consume point (matches iOS TXReporterPresenter.swift:72).
            val userExtra: String? = hostExtra.takeIf { includes.extra }

            val builder = EnvelopeBuilder(EnvelopeBuilder.DefaultRedactor)
            val encoded = builder.buildEncoded(
                sdkVersion = TraceItX.SDK_VERSION,
                title = title,
                description = description,
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
                deviceLocale = (device["locale"] as? String) ?: java.util.Locale.getDefault().toLanguageTag(),
                deviceTimezone = (device["timezone"] as? String) ?: java.util.TimeZone.getDefault().id,
                deviceScreenWidth = (device["screenWidth"] as? Number)?.toDouble() ?: capture.widthPx.toDouble(),
                deviceScreenHeight = (device["screenHeight"] as? Number)?.toDouble() ?: capture.heightPx.toDouble(),
                devicePixelRatio = (device["pixelRatio"] as? Number)?.toDouble() ?: 1.0,
                attachments = screenshotEnvelopeAttachments + listOfNotNull(replayEnvelopeAttachment),
                annotations = allAnnotationsJson.toJsonArrayOrNull(),
                redactions = allRedactionsJson.toJsonArrayOrNull(),
                // External review, finding 3 (Serious) — the snapshot taken at
                // the Send tap, NEVER a live `TraceItX.currentUser` read. Every
                // stage above this line (per-shot bake, image encode, SHA-256,
                // replay gzip, ring-buffer snapshots) runs after the user
                // pressed Send; a live read here attributed the report to
                // whoever `setUser` named by the time the envelope was built.
                //
                // External review, finding 1 (Serious) — `resolve()`, not the
                // raw snapshot. `cfg` (read at the top of this function)
                // carries the SDK key, i.e. the PROJECT this envelope is
                // uploaded to. A `start(projectB)` between the Send tap and
                // that read leaves the snapshot perfectly intact — `start()`
                // clears the LIVE user, not one already captured — so A's
                // id/email/display name would have shipped under B's key.
                // `resolve()` returns the user only while the session it was
                // captured in is still installed, and `null` (anonymous)
                // otherwise. Ordering is load-bearing: it must stay AFTER the
                // `cfg` read, because a still-matching epoch is exactly what
                // proves `cfg` belongs to the same session.
                user = EnvelopeBuilder.TXUserExtras.from(capturedSession.user.resolve()),
                userExtra = userExtra,
                excluded = includes.excludedKeys(),
                breadcrumbs = if (reportCapture.matchesSession(capturedSession)) reportCapture.takeBreadcrumbs() else null,
                // Report Resource Window (spec 2026-09-05) — gap class 3: the
                // PRIMARY use case is a user-submitted bug report, so this
                // build site must stamp resources too, not just the crash
                // path. `snapshot()` never throws (ReentrantLock-guarded, no
                // lock held across it) and returns an empty list when the
                // sampler is off/never started.
                resources = sharedResourceBuffer.snapshot(),
            )

            // Native identity Task 8b — the live submit boundary. Resolve the
            // `X-TX-Identity-Token` value HERE, against the subject captured
            // at the Send tap (`capturedSession.user.identitySubject`), never
            // a live re-read — same capture-time-not-submit-time rule
            // `capturedSession.user.resolve()` enforces for the self-declared
            // user just above. `TraceItX.__resolveIdentityToken` (public,
            // unlike the `:traceitx-core`-internal `_identityHolder` it
            // wraps) is the seam this cross-module call goes through — this
            // file lives in `:traceitx-reporter-ui`, a SEPARATE Gradle module
            // from `:traceitx-core`, mirroring why
            // `TraceItX.__replayComplete(reportCapture)` is public despite the
            // double-underscore convention.
            //
            // Merge note (native-identity x captured-session): the identity
            // subject rides the SAME `TXCapturedSession.user` field the
            // self-declared-user resolution above already reads, not a
            // second, independently-captured value.
            //
            // Final whole-branch review, Important 2 — `capturedSession.user
            // .startEpoch` now threads through too, so
            // `__resolveIdentityToken` can refuse the header outright when a
            // `start(projectB)` landed since the Send tap, exactly like
            // `capturedSession.user.resolve()` already refuses the
            // self-declared user in that case.
            //
            // Independent review, P1 — the PERSISTED `identitySubject` (what
            // survives onto a queued `OutboxEntry` on transient failure) must
            // be gated by the SAME epoch decision as the token, not the raw
            // captured value unconditionally: an epoch mismatch means the
            // SDK already concluded the whole snapshot is untrustworthy — the
            // same conclusion `capturedSession.user.resolve()` acts on for
            // the user two lines above. Without this, a queued entry could
            // carry a subject the live check had already decided to distrust,
            // and a LATER drain could attach a header on the strength of it.
            val identity = TraceItX.__resolveIdentityToken(
                capturedSession.user.identitySubject,
                capturedSession.user.startEpoch,
            )

            // 4. Ship via ReportSubmitter (isolated client).
            val outbox = JSONLOutbox(activity.applicationContext)
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
            if (capturedSession.isRevoked) return@txGuardSuspend ReportResult.Cancelled("revoked")
            submitter.submit(
                envelopeBytes = encoded.bytes,
                idempotencyKey = encoded.idempotencyKey,
                attachments = screenshotParts + listOfNotNull(replayPart),
                identitySubject = if (identity.epochStillCurrent) capturedSession.user.identitySubject else null,
                identityToken = identity.token,
                authorization = ReportAuthorizationFactory.forCapture(capturedSession, reportCapture),
            )
        } ?: ReportResult.Cancelled("submit_guard_failed")
        } finally { reportCapture.finishConsumption() }
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

    private val HEX = charArrayOf('0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f')

    /**
     * Encode the baked annotated screenshot for the wire + object storage.
     * Returns the encoded bytes + the matching `image/...` mime + the
     * matching file extension.
     *
     * Encoder cascade (each step accepted only if it actually beats the
     * previous fallback in byte count — never spend more bytes than the
     * baseline PNG):
     *   1. WEBP_LOSSY @ q=85 — API 30+. ~70-80% byte reduction.
     *   2. Legacy WEBP @ q=85 — API 24-29 (lossy when quality<100). Same
     *      mime; encoder is older but the bytes still decode on every
     *      consumer browser + admin UI.
     *   3. JPEG @ q=85 — universal fallback if WebP isn't available.
     *   4. PNG — baseline. Only used when every above attempt failed OR
     *      the encoded output wasn't actually smaller than PNG.
     */
    private fun encodeBakedImageForStorage(baked: Bitmap): Triple<ByteArray, String, String> {
        val png = ByteArrayOutputStream().use { bos ->
            baked.compress(Bitmap.CompressFormat.PNG, 100, bos)
            bos.toByteArray()
        }
        // WEBP_LOSSY (API 30+).
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            val webp = runCatching {
                val out = ByteArrayOutputStream()
                @Suppress("DEPRECATION_ERROR")
                val ok = baked.compress(Bitmap.CompressFormat.WEBP_LOSSY, 85, out)
                if (ok) out.toByteArray() else null
            }.getOrNull()
            if (webp != null && webp.size < png.size) return Triple(webp, "image/webp", "webp")
        }
        // Legacy WEBP (API 24-29 — `WEBP` enum exists but is deprecated on 30+).
        val legacyWebp = runCatching {
            val out = ByteArrayOutputStream()
            @Suppress("DEPRECATION")
            val ok = baked.compress(Bitmap.CompressFormat.WEBP, 85, out)
            if (ok) out.toByteArray() else null
        }.getOrNull()
        if (legacyWebp != null && legacyWebp.size < png.size) {
            return Triple(legacyWebp, "image/webp", "webp")
        }
        // JPEG fallback.
        val jpeg = runCatching {
            val out = ByteArrayOutputStream()
            val ok = baked.compress(Bitmap.CompressFormat.JPEG, 85, out)
            if (ok) out.toByteArray() else null
        }.getOrNull()
        if (jpeg != null && jpeg.size < png.size) return Triple(jpeg, "image/jpeg", "jpg")
        return Triple(png, "image/png", "png")
    }
}
