// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 10 — synchronous crash capture (spec 2026-07-18). Everything on this
// path is sync + lock-bounded: DeviceMetadata.collect, buildEncoded,
// RedactionEngine, snapshotForCrash(tryLock), CrashSidecar.appendSync. Runs
// INSIDE the uncaught-exception handler before the previous handler chains —
// must never throw (callers wrap in txGuardVoid) and never recurse
// (AtomicBoolean latch).
//
// Adaptations vs. the original sketch (real generated-type names differ):
//   • protocol types are `Crash`/`Frame`/`ReportEnvelopeSource`, not
//     `CrashPayload`/`CrashFrame`/`Source`.
//   • `fingerprintOf` caps `frameKeys` to the first 5 entries INTERNALLY
//     (verified against packages/protocol/__tests__/fixtures/crash-fingerprint.json,
//     whose 4th case includes a deliberately-ignored 6th frame) — the caller
//     no longer needs to pre-truncate.
package com.traceitx.crash

import android.content.Context
import androidx.annotation.VisibleForTesting
import com.traceitx.capture.DeviceMetadata
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.IngestEndpoint
import com.traceitx.envelope.EnvelopeBuilder
import com.traceitx.outbox.CrashSidecar
import com.traceitx.outbox.OutboxEntry
import com.traceitx.protocol.generated.Crash
import com.traceitx.protocol.generated.CrashDetails
import com.traceitx.protocol.generated.JSBundle
import com.traceitx.protocol.generated.JVMCrashMetadata
import com.traceitx.protocol.generated.Frame
import com.traceitx.protocol.generated.ReportEnvelopeSource
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

object CrashReporter {

    private val handling = AtomicBoolean(false)
    // Host getters can block indefinitely; native handled extraction must not own
    // the automatic collector latch until its entire Throwable graph is extracted.
    private val handlingNativeHandled = AtomicBoolean(false)
    private val acceptedHermesFatal = AcceptedHermesFatal()
    private var handledAdmission = HandledThrowableAdmission { com.traceitx.TraceItX.currentStartEpochVolatile() }

    @Volatile private var appContext: Context? = null

    /**
     * Context only. The config is NOT cached here any more: a second copy
     * written outside `TraceItX.stateLock` is what let `start()` swap the crash
     * path's destination with no lock and no epoch (follow-ups item 6). The
     * config now arrives with the crash-entry snapshot, from the same critical
     * section as the user.
     */
    fun configure(context: Context) {
        this.appContext = context.applicationContext
    }

    /**
     * Test-only seam. Invoked inside [capture], immediately after the
     * re-entrancy latch closes and INSIDE the window a concurrent
     * `setUser`/`start()` has to land in for the round-5 finding-2 defect —
     * i.e. after the crash-entry user snapshot its callers take and before the
     * redaction/fingerprint/device/encode work that follows. Production leaves
     * it null; the cost on the crash path is one volatile null check.
     */
    @VisibleForTesting
    @Volatile
    @JvmStatic
    var __afterUserSnapshotHookForTesting: (() -> Unit)? = null

    // ECMAScript whitespace, matching the JS/protocol nonblank check exactly.
    private const val JS_WHITESPACE = "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680" +
        "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
        "\u2028\u2029\u202F\u205F\u3000\uFEFF"

    private fun validJsBundle(bundle: JSBundle): Boolean {
        val id = bundle.buildID
        if (id.isEmpty() || id.length > 200 || id.all { it in JS_WHITESPACE } || '\u0000' in id) return false
        var i = 0
        while (i < id.length) {
            val c = id[i++]
            if (Character.isHighSurrogate(c)) {
                if (i == id.length || !Character.isLowSurrogate(id[i++])) return false
            } else if (Character.isLowSurrogate(c)) return false
        }
        return Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}").matches(bundle.bundleName)
    }

    /** Native path — the process is dying; source = crash, handled = false. */
    fun captureThrowable(thread: Thread, throwable: Throwable) {
        // CRASH ENTRY — round-5 external review, finding 2 (Serious). See
        // [capture]'s `captured` parameter for the full defect. Taken as
        // the FIRST statement, before the stack-frame mapping below: that maps
        // up to 256 StackTraceElements into Frame objects, and everything after
        // it is prep for a crash that has already happened.
        val captured = com.traceitx.TraceItX.captureSessionSnapshot()
        if (acceptedHermesFatal.consume(throwable, captured.user.startEpoch, captured.killGeneration)) return
        val details = normalizeCrashDetails(null)
        val frames = throwable.stackTrace.take(256).map { el ->
            Frame(
                raw = el.toString().take(1024),
                file = el.fileName,
                function = el.methodName,
                line = if (el.lineNumber >= 0) el.lineNumber.toLong() else null,
            )
        }
        capture(
            exceptionType = throwable.javaClass.name.take(256),
            message = throwable.message ?: throwable.javaClass.name,
            frames = frames,
            mechanism = "uncaught-exception-handler",
            handled = false,
            fatal = true,
            threadName = thread.name,
            occurredAt = Instant.now().toString(),
            captured = captured,
            jvmThrowable = throwable,
            details = details,
        )
    }

    /** Deliberate native capture acknowledges synchronous encrypted storage. */
    internal fun captureHandledThrowable(throwable: Throwable): Boolean = captureHandledThrowable(throwable, null)

    /** Deliberate native capture with per-call details owned before assembly. */
    internal fun captureHandledThrowable(
        throwable: Throwable,
        options: com.traceitx.CaptureExceptionOptions?,
    ): Boolean {
        // Snapshot before any overridable accessor, and close reentrancy before extraction.
        val captured = com.traceitx.TraceItX.captureSessionSnapshot()
        if (!captured.captureConsent || captured.config?.capture?.crash != true) return false
        if (handling.get() || !handlingNativeHandled.compareAndSet(false, true)) return false
        var reservation: HandledThrowableAdmission.Reservation? = null
        var accepted = false
        try {
            reservation = handledAdmission.reserve(throwable, captured.user.startEpoch) ?: return false
            val type = redactAndCap(throwable.javaClass.name, 256)
            val message = runCatching { throwable.message }.getOrNull() ?: type
            val frames = runCatching { throwable.stackTrace }.getOrNull()
                ?.take(256)?.map(::captureFrame).orEmpty()
            val jvm = runCatching { captureJvmContext(throwable, captured.config.r8MappingId) }.getOrNull()
            val details = normalizeCrashDetails(options)
            accepted = capture(
                exceptionType = type,
                message = redactAndCap(message, 4096),
                frames = frames,
                mechanism = "captureException",
                handled = true,
                fatal = false,
                threadName = redactAndCap(Thread.currentThread().name, 256),
                occurredAt = Instant.now().toString(),
                captured = captured,
                preparedJvm = jvm,
                details = details,
                requireCurrentStart = true,
                waitForStorage = true,
            )
            return accepted
        } catch (_: Throwable) {
            return false
        } finally {
            reservation?.let { handledAdmission.settle(it, accepted) }
            handlingNativeHandled.set(false)
        }
    }

    /** Existing Unit API; keep its JVM descriptor and Kotlin default bridge. */
    fun captureFacts(
        exceptionType: String,
        message: String,
        framesRaw: List<String>,
        mechanism: String,
        fatal: Boolean,
        occurredAt: String,
        jsBundle: JSBundle? = null,
    ) {
        captureFactsAccepted(exceptionType, message, framesRaw, mechanism, fatal, occurredAt, jsBundle)
    }

    /** Automatic RN capture acknowledges completed synchronous storage. */
    fun captureFactsAccepted(
        exceptionType: String,
        message: String,
        framesRaw: List<String>,
        mechanism: String,
        fatal: Boolean,
        occurredAt: String,
        jsBundle: JSBundle? = null,
    ): Boolean = captureFactsAcceptedWithDetails(exceptionType, message, framesRaw, mechanism, fatal, occurredAt, jsBundle, null)

    /** RN wire details are transient and projected only inside eligible guarded capture. */
    fun captureFactsAcceptedWithDetails(
        exceptionType: String,
        message: String,
        framesRaw: List<String>,
        mechanism: String,
        fatal: Boolean,
        occurredAt: String,
        jsBundle: JSBundle?,
        details: Any?,
    ): Boolean {
        val attempt = if (fatal) acceptedHermesFatal.beginAttempt() else null
        val captured = com.traceitx.TraceItX.captureSessionSnapshot()
        val accepted = runCatching {
            capture(
                exceptionType = exceptionType.take(256),
                message = message,
                frames = framesRaw.take(256).map { Frame(raw = it.take(1024)) },
                mechanism = mechanism,
                handled = false,
                fatal = fatal,
                threadName = null,
                occurredAt = occurredAt,
                captured = captured,
                jsBundle = jsBundle?.takeIf { validJsBundle(it) },
                rnDetails = details,
            )
        }.getOrDefault(false)
        if (accepted && fatal && mechanism == "errorutils" && jsBundle != null && validJsBundle(jsBundle) &&
            jsBundle.platform == com.traceitx.protocol.generated.JSBundlePlatform.Android) {
            // Optional correlation must never change successful persistence acknowledgement.
            runCatching {
                acceptedHermesFatal.remember(attempt!!, exceptionType, message, framesRaw, jsBundle.bundleName,
                    captured.user.startEpoch, captured.killGeneration)
            }
        }
        return accepted
    }

    /** Explicit RN capture enforces classification independently of caller facts. */
    fun captureHandledFacts(
        exceptionType: String,
        message: String,
        framesRaw: List<String>,
        occurredAt: String,
        jsBundle: JSBundle? = null,
    ): Boolean = captureHandledFactsWithDetails(exceptionType, message, framesRaw, occurredAt, jsBundle, null)

    /** Keeps the original handled facts descriptor/default bridge for old RN binaries. */
    fun captureHandledFactsWithDetails(
        exceptionType: String,
        message: String,
        framesRaw: List<String>,
        occurredAt: String,
        jsBundle: JSBundle?,
        details: Any?,
    ): Boolean {
        val captured = com.traceitx.TraceItX.captureSessionSnapshot()
        return runCatching {
            capture(
                exceptionType = exceptionType.take(256),
                message = message,
                frames = framesRaw.take(256).map { Frame(raw = it.take(1024)) },
                mechanism = "captureException",
                handled = true,
                fatal = false,
                threadName = null,
                occurredAt = occurredAt,
                captured = captured,
                jsBundle = jsBundle?.takeIf { validJsBundle(it) },
                rnDetails = details,
                requireCurrentStart = true,
                waitForStorage = true,
            )
        }.getOrDefault(false)
    }

    /**
     * @param captured the session — user, config and revocation counter —
     *   snapshotted in ONE `TraceItX.stateLock` critical section at CRASH
     *   ENTRY, by the public entry point above. The user half still carries its
     *   own session epoch (see [com.traceitx.TXCapturedSession]).
     *
     *   Round-5 external review, finding 2 (Serious): this used to be a live
     *   `TraceItX.currentUser` read down at the `buildEncoded` call — after
     *   redaction had run over the message and every frame, after
     *   fingerprinting, and after `DeviceMetadata.collect`. A `setUser(B)`
     *   landing in that window attributed A's crash to B, and a
     *   `start(projectB)` crossed a project boundary outright because the user
     *   was bound to no session. Snapshotting at entry and [TXCapturedUser
     *   .resolve]-ing at encode time is the same mechanism the reporter-dialog
     *   and companion submit paths already use.
     *
     *   Blocking: `captureSessionSnapshot()` takes `TraceItX.stateLock` for a
     *   handful of uncontended field reads — the SAME lock the removed
     *   `currentUser` read took, so this is a move, not a new acquisition, and
     *   it cannot make the uncaught-exception handler block where it did not
     *   before.
     *   `stateLock.withLock` is reentrant and always released in a `finally`,
     *   so a throw that unwound out of a critical section on this very thread
     *   cannot deadlock us here either.
     */
    private fun capture(
        exceptionType: String,
        message: String,
        frames: List<Frame>,
        mechanism: String,
        handled: Boolean,
        fatal: Boolean,
        threadName: String?,
        occurredAt: String,
        captured: com.traceitx.TXCapturedSession,
        jsBundle: JSBundle? = null,
        jvmThrowable: Throwable? = null,
        preparedJvm: JVMCrashMetadata? = null,
        details: CrashDetails? = null,
        rnDetails: Any? = null,
        requireCurrentStart: Boolean = false,
        waitForStorage: Boolean = false,
    ): Boolean {
        val context = appContext ?: return false
        // From the crash-entry snapshot, not a field: same critical section as
        // the user, so there is no second read for a start() to land in front
        // of. See TXCapturedSession.
        val cfg = captured.config ?: return false
        if (!cfg.capture.crash) return false
        if (!handling.compareAndSet(false, true)) return false
        try {
            // Automatic JVM capture retains its existing reentrancy protection.
            // Native handled capture supplies only prepared data here: none of its
            // outer or cause getters may hold this shared automatic collector latch.
            val jvm = preparedJvm ?: jvmThrowable?.let { throwable ->
                runCatching { captureJvmContext(throwable, cfg.r8MappingId) }.getOrNull()
            }
            // Inside the try so the `finally` below still clears the latch if a
            // test hook throws.
            __afterUserSnapshotHookForTesting?.invoke()
            // Redaction can EXPAND text (e.g. SSN `123-45-6789` -> `[REDACTED:SSN]`),
            // so re-cap AFTER redact() — caps applied only pre-redaction (at
            // capture-site truncation above) are not sufficient; an expanding
            // replacement could push message/frame raw past the protocol's
            // wire caps (message <= 4096, frames[].raw <= 1024) and fail Zod
            // validation for the whole envelope at ingest.
            val redactedMessage = redactAndCap(message, 4096)
            val redactedFrames = frames.map { it.copy(raw = redactAndCap(it.raw, 1024)) }
            val fingerprint = fingerprintOf(
                exceptionType,
                redactedFrames.map { f -> frameKey(f) },
            )
            val crash = Crash(
                exceptionType = exceptionType,
                message = redactedMessage,
                frames = redactedFrames,
                threadName = threadName?.take(256),
                mechanism = mechanism,
                handled = handled,
                fatal = fatal,
                occurredAt = occurredAt,
                fingerprint = fingerprint,
                jsBundle = jsBundle,
                jvm = jvm,
                details = details ?: normalizeRNCrashDetails(rnDetails),
            )
            val device = DeviceMetadata.collect(context)
            val reportId = UUID.randomUUID()
            val encoded = EnvelopeBuilder(EnvelopeBuilder.DefaultRedactor).buildEncoded(
                reportId = reportId,
                sdkVersion = com.traceitx.TraceItX.SDK_VERSION,
                title = redactAndCap("$exceptionType: $redactedMessage", 50),
                description = "",
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
                excluded = listOf("screenshot", "uiTree", "focus", "logs", "network"),
                degradedReason = "crash-capture",
                breadcrumbs = sharedBreadcrumbBuffer.snapshotForCrash(),
                // Report Resource Window (spec 2026-09-05) — the crash-path
                // build site that feeds CrashSidecar.appendSync. `snapshot()`
                // is ReentrantLock-guarded with no lock held across it and
                // never throws — safe under this function's no-throw
                // contract even though `capture()` runs on the (ordinary
                // JVM) thread that just crashed.
                resources = sharedResourceBuffer.snapshot(),
                source = if (fatal) ReportEnvelopeSource.Crash else ReportEnvelopeSource.Error,
                crash = crash,
                // Round-5 external review, finding 2 (Serious) — the snapshot
                // taken at crash ENTRY, resolved against its own session here.
                // `cfg` now comes from that SAME snapshot, so the two can no
                // longer disagree about which session this crash belongs to;
                // the epoch recheck is what still degrades the user to
                // anonymous once a start()/kill() has superseded it. NEVER a
                // live `TraceItX.currentUser` read: by this line redaction,
                // fingerprinting and device collection have all run.
                user = EnvelopeBuilder.TXUserExtras.from(captured.user.resolve()),
            )
            // Checked HERE, not at capture time: a kill() arriving during
            // redaction/fingerprinting/device assembly must still suppress the
            // report. Monotonic, so a start() that re-opened captureGate in the
            // meantime cannot resurrect this.
            //
            // Admission also retains this original kill generation across facade construction.
            if (com.traceitx.TraceItX.killGenerationChanged(captured.killGeneration)) return false

            // Independent review, P1 — gate the PERSISTED identity subject on
            // the SAME epoch check `captured.user.resolve()` just used for the
            // self-declared user above: an epoch mismatch means the SDK has
            // already decided the WHOLE captured snapshot is untrustworthy,
            // not just the user half of it. Computed once, right before use,
            // same as `resolve()`'s own read — this is the identical
            // `captured.user.startEpoch == <live epoch>` comparison
            // `TraceItX.resolveCapturedUser` performs internally, made
            // explicit here because a raw `TXCapturedUser` field (unlike
            // `.user`) has no built-in gate of its own to fall back on.
            val capturedEpochStillCurrent = captured.user.startEpoch == com.traceitx.TraceItX.currentStartEpoch()
            val entry = OutboxEntry(
                    reportId = reportId.toString(),
                    createdAt = System.currentTimeMillis(),
                    envelopeBytes = encoded.bytes,
                    idempotencyKey = encoded.idempotencyKey,
                    attachmentRefs = emptyList(),
                    sdkKey = cfg.sdkKey,
                    endpoint = IngestEndpoint.url,
                    // Native identity Task 8b — thread the ALREADY-CAPTURED
                    // subject (snapshotted atomically with `captured.user` at
                    // crash entry, in `captureThrowable`/`captureFacts` above)
                    // onto the entry. Without this a crash can never be
                    // attributed, however identity is otherwise configured:
                    // whichever drain eventually submits this entry
                    // (`TraceItX.requestOutboxDrain()` for a non-fatal RN
                    // error, or the next `start()` for a native crash) only
                    // ever resolves a header from `entry.identitySubject` — no
                    // subject on the entry means no header, permanently. This
                    // is a passthrough only: no config is read here, and the
                    // critical section above this point is unchanged
                    // (follow-up item 6 owns that race).
                    //
                    // Independent review, P1 — but only while the captured
                    // session is STILL current: an epoch mismatch means a
                    // LATER drain must never attach a header on the strength
                    // of a subject the SDK had already concluded it should
                    // not rely on, the same conclusion `captured.user.resolve()`
                    // just acted on for the user two lines above.
                    identitySubject = if (capturedEpochStillCurrent) captured.user.identitySubject else null,
                )
            val authorization = object : com.traceitx.outbox.OutboxAuthorization {
                override fun isAllowed() = com.traceitx.TraceItX.captureGate &&
                    !com.traceitx.TraceItX.killGenerationChangedVolatile(captured.killGeneration) &&
                    (!requireCurrentStart || captured.user.startEpoch == com.traceitx.TraceItX.currentStartEpochVolatile())
            }
            val sidecar = sidecarFactory(context)
            return if (waitForStorage) sidecar.appendHandledSyncAccepted(entry, authorization)
            else sidecar.appendSyncAccepted(entry, authorization)
        } catch (_: Throwable) {
            return false
        } finally {
            handling.set(false)
        }
    }

    /**
     * Fingerprint-parity key for one frame: `"function|file"` when both are
     * known, else the raw frame text with digits stripped (so line numbers /
     * addresses don't fragment the fingerprint across otherwise-identical
     * crashes). Mirrors the cross-SDK fixture's derivation.
     */
    private fun frameKey(f: Frame): String {
        val fn = f.function
        val file = f.file
        return if (fn != null && file != null) "$fn|$file" else f.raw.replace(Regex("[0-9]+"), "")
    }

    /**
     * sha256(exceptionType + "\n" + first-5-frameKeys.joined("\n")), first 16
     * lowercase hex chars. The 5-frame cap lives HERE (not at call sites) —
     * verified against crash-fingerprint.json's 4th fixture case, which
     * supplies 6 frames and expects the 6th to be ignored.
     */
    fun fingerprintOf(exceptionType: String, frameKeys: List<String>): String {
        val input = exceptionType + "\n" + frameKeys.take(5).joinToString("\n")
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(16)
    }

    /** Construction dependency; production always resolves the app-scoped encrypted store. */
    internal var sidecarFactory: (Context) -> CrashSidecar = { CrashSidecar(it) }

    @VisibleForTesting
    fun __resetForTesting() {
        handling.set(false)
        handlingNativeHandled.set(false)
        acceptedHermesFatal.clear()
        handledAdmission = HandledThrowableAdmission { com.traceitx.TraceItX.currentStartEpochVolatile() }
        appContext = null
        __afterUserSnapshotHookForTesting = null
        sidecarFactory = { CrashSidecar(it) }
    }

    @VisibleForTesting
    fun __enterForTesting() {
        handling.set(true)
    }
}
