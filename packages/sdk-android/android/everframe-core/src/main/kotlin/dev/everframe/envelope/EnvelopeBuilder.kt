// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Concrete envelope composition for the Android SDK. Wraps Plan 01's
// kotlinx-serialization Generated.kt `ReportEnvelope` with redaction +
// PIPE-03 size-cap enforcement + SHA-256 idempotency-key derivation.
//
// Mirrors `packages/sdk-ios/Sources/Everframe/Envelope/EnvelopeBuilder.swift`.
//
// Generated.kt is used DIRECTLY (no hand-rolled wrapper). Per Plan 05-02
// SUMMARY rationale: Generated.kt is already kotlinx-serialization-annotated;
// wrapping would add drift surface against the codegen output.
package dev.everframe.envelope

import dev.everframe.capture.ResourceRingBuffer
import dev.everframe.config.TXUser
import dev.everframe.config.EverframeEnvelopeError
import dev.everframe.protocol.generated.App
import dev.everframe.protocol.generated.Attachment
import dev.everframe.protocol.generated.AttachmentKind
import dev.everframe.protocol.generated.Breadcrumb
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.protocol.generated.CaptureControl
import dev.everframe.protocol.generated.Captures
import dev.everframe.protocol.generated.Context as ProtocolContext
import dev.everframe.protocol.generated.Crash
import dev.everframe.protocol.generated.Device
import dev.everframe.protocol.generated.FormFactor
import dev.everframe.protocol.generated.Name
import dev.everframe.protocol.generated.NetworkBody
import dev.everframe.protocol.generated.Payload
import dev.everframe.protocol.generated.Platform
import dev.everframe.protocol.generated.ProtocolVersion
import dev.everframe.protocol.generated.ReportEnvelope
import dev.everframe.protocol.generated.ReportEnvelopeSource
import dev.everframe.protocol.generated.Reporter
import dev.everframe.protocol.generated.Resource
import dev.everframe.protocol.generated.SDK
import dev.everframe.protocol.generated.ScreenSize
import dev.everframe.protocol.generated.User
import dev.everframe.vitals.VitalsRuntime
import dev.everframe.vitals.VitalsStamp
import dev.everframe.vitals.wire.VitalsLimits
import dev.everframe.vitals.wire.toGeneratedVitals
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Wire part name for shot `index` of kind `kind` ("screenshot" or
 * "annotated-screenshot"). Shot 1 (index 0) keeps the bare kind name for
 * backward wire compatibility with the pre-multi-shot single attachment;
 * shots 2+ get a 1-based `-N` suffix (second shot -> `-2`, matching web/iOS).
 * Lives here (not in :everframe-reporter-ui's ReporterDialog, which consumes
 * it) so [EnvelopePartNamingTest] — a plain-JUnit, network-free test — can
 * exercise it from :everframe-core without depending on the UI module.
 */
fun partName(kind: String, index: Int): String = if (index == 0) kind else "$kind-${index + 1}"

/** One entry of a [buildAttachmentPlan] result: a shot's derived part name + [AttachmentKind]. */
data class AttachmentPlanEntry(val partName: String, val kind: AttachmentKind)

/**
 * Pure helper (network-free, hence unit-testable): for each shot's annotated
 * flag, pick its [AttachmentKind] and derive its part name. Callers zip this
 * plan against the real (byte-carrying) shots to build the actual
 * attachments. Mirrors iOS `ReporterSubmission.buildAttachmentPlan`.
 */
fun buildAttachmentPlan(annotatedFlags: List<Boolean>): List<AttachmentPlanEntry> =
    annotatedFlags.mapIndexed { index, annotated ->
        val kind = if (annotated) AttachmentKind.AnnotatedScreenshot else AttachmentKind.Screenshot
        AttachmentPlanEntry(partName = partName(kind.value, index), kind = kind)
    }

class EnvelopeBuilder(
    private val redactor: Redactor = NoOpRedactor,
    /** Session Vitals (spec 2026-09-05 §2): the running collector's session id + recent ring; null when vitals are off. */
    private val vitalsStamp: () -> VitalsStamp? = { VitalsRuntime.currentStamp() },
) {

    interface Redactor {
        fun redact(s: String): String
        fun filterHeaders(h: Map<String, String>): Map<String, String>
    }

    object NoOpRedactor : Redactor {
        override fun redact(s: String): String = s
        override fun filterHeaders(h: Map<String, String>): Map<String, String> = h
    }

    /** Adapter so RedactionEngine (object) can be passed where a Redactor is expected. */
    object DefaultRedactor : Redactor {
        override fun redact(s: String): String = RedactionEngine.redact(s)
        override fun filterHeaders(h: Map<String, String>): Map<String, String> =
            RedactionEngine.filterHeaders(h)
    }

    data class NetworkRow(
        val method: String,
        val url: String,
        val status: Int? = null,
        val durationMs: Double? = null,
        val requestHeaders: Map<String, String> = emptyMap(),
        val responseHeaders: Map<String, String> = emptyMap(),
    )

    /**
     * One log entry as it lands in the envelope JSON. `timestamp` is the per-entry
     * capture time (epoch ms); the builder serializes it as ISO-8601. `tag` is
     * optional — present for Timber-sourced lines on Android, always null on iOS.
     */
    data class LogRow(
        val timestamp: Long,
        val level: String,
        val tag: String?,
        val message: String,
    )

    /**
     * Trim captured logs to the most recent rows that fit within [maxChars]
     * total message characters; everything older collapses into ONE "REDACTED"
     * marker at the front. The newest row is always kept (truncated if it alone
     * exceeds the budget) so we never emit zero logs.
     *
     * Mirrors sdk-core's `trimLogs` (TypeScript) and iOS's
     * `EnvelopeBuilder.trimLogs` (Swift) — keep the three in lockstep.
     */
    internal fun trimLogs(logs: List<LogRow>, maxChars: Int = MAX_LOG_CHARS): List<LogRow> {
        if (logs.isEmpty()) return emptyList()
        val kept = ArrayList<LogRow>()
        var total = 0
        var i = logs.size - 1
        while (i >= 0) {
            val row = logs[i]
            val len = row.message.length
            if (kept.isEmpty()) {
                if (len > maxChars) {
                    kept.add(row.copy(message = row.message.substring(0, maxChars)))
                    total = maxChars
                } else {
                    kept.add(row)
                    total = len
                }
                i--
                continue
            }
            if (total + len > maxChars) break
            kept.add(row)
            total += len
            i--
        }
        kept.reverse()
        val dropped = logs.size - kept.size
        if (dropped > 0) {
            val markerTs = logs[dropped - 1].timestamp
            kept.add(0, LogRow(timestamp = markerTs, level = "info", tag = null, message = "REDACTED"))
        }
        return kept
    }

    /**
     * Build and JSON-encode an envelope. Returns the raw bytes plus the
     * SHA-256 idempotency key (hex). Throws [EverframeEnvelopeError.PayloadTooLarge]
     * if the encoded envelope (without attachments) exceeds the 25 MB cap.
     */
    fun buildEncoded(
        reportId: UUID = UUID.randomUUID(),
        sdkVersion: String,
        sdkName: String = "everframe-android",
        platform: String = "android",
        formFactor: String = "phone",
        title: String = "",
        description: String = "",
        user: TXUserExtras? = null,
        logs: List<LogRow> = emptyList(),
        networkRows: List<NetworkRow> = emptyList(),
        /**
         * `payload.networkBodies` — captured request/response bodies (spec
         * network-body-capture / Task 15), independent of [networkRows]'s
         * metadata-only rows. The caller (CompanionSubmissionComposer /
         * ReporterDialog) supplies the reporter's frozen snapshot
         * ([sharedNetworkBodyBuffer.takeFrozen]) when the network include
         * toggle is ON, or `null` (after [sharedNetworkBodyBuffer.discardAndResume])
         * when it's OFF. Entries arrive ALREADY REDACTED — bodies are masked
         * at capture time (NetworkBodyCapture / interceptor), unlike
         * [networkRows]'s url/headers above — so this builder must NOT run
         * them through [redactor] a second time. Null/empty coerces to
         * `payload.networkBodies: null` and leaves `captureControl.included`
         * untouched, mirroring the breadcrumbs no-op path.
         */
        networkBodies: List<NetworkBody>? = null,
        attachments: List<Attachment> = emptyList(),
        /**
         * `payload.annotations[]` — one wire entry per baked annotation
         * across every shot (Task 9), each tagged with its owning shot's
         * `partName` (server join key, parser.ts:338). Built by
         * `AnnotationWireFormat.serialize` per shot and concatenated by the
         * caller. Empty coerces to `null` (pre-annotations wire shape).
         */
        annotations: JsonArray? = null,
        /**
         * `payload.redactions[]` — the blur-shape mirror (kind `"blur"`,
         * no `id`/`color`/`thickness`) from the same per-shot serialization
         * pass. Empty coerces to `null`.
         */
        redactions: JsonArray? = null,
        appName: String = "unknown",
        appVersion: String = "0.0.0",
        appBuild: String? = null,
        deviceModel: String? = null,
        deviceOs: String = "Android",
        deviceOsVersion: String = "0.0",
        deviceScreenWidth: Double = 0.0,
        deviceScreenHeight: Double = 0.0,
        devicePixelRatio: Double = 1.0,
        deviceLocale: String = Locale.getDefault().toLanguageTag(),
        deviceTimezone: String = TimeZone.getDefault().id,
        route: String? = null,
        degradedReason: String? = null,
        /**
         * Host-supplied opaque metadata string (PROTO 2026-05-11). Callers
         * JSON.stringify nested data themselves. Capped at 2000 chars by the
         * native SDK's [dev.everframe.Everframe.setExtra] truncation; the JSON
         * schema enforces the same ceiling. Survives into `payload.extra`.
         */
        userExtra: String? = null,
        /**
         * Sections the user explicitly toggled off in the reporter UI.
         * Lands in `captureControl.excluded` so the backend (and downstream
         * AI consumers) know what's missing wasn't a capture failure.
         */
        excluded: List<String> = emptyList(),
        /**
         * Trimmed breadcrumb chain (spec §4) for `payload.breadcrumbs`. The
         * caller (CompanionSubmissionComposer / ReporterDialog) supplies the
         * frozen ring-buffer snapshot ([sharedBreadcrumbBuffer.takeFrozen]);
         * null/empty ships an envelope byte-identical to the pre-breadcrumbs
         * builder EXCEPT `Captures.breadcrumbs`, which now always comes back
         * an explicit `false` (was previously omitted/null) — mirrors iOS
         * Task 6's `trimmedBreadcrumbs != nil` Bool. `captureControl.included`
         * stays untouched (empty) in that case. Trim options default to the
         * Task-4 constants ("from live config, defaulted" — no config-
         * threading plumbing added here for v1). Android keeps its
         * independent Log/Network buffers — breadcrumbs are NOT derived from
         * logs/network here.
         */
        breadcrumbs: List<Breadcrumb>? = null,
        breadcrumbByteBudget: Int = BreadcrumbTrim.byteBudget,
        breadcrumbConsoleEntryCap: Int = BreadcrumbTrim.consoleEntryCap,
        /**
         * Envelope-level discriminator (spec 2026-07-18): `null` for a manual
         * reporter-driven report (pre-crash-reporting wire shape, `source`
         * omitted via `explicitNulls = false`); `Crash`/`Error` for automatic
         * crash/error reports (Tasks 9/10/12).
         */
        source: ReportEnvelopeSource? = null,
        /** `payload.crash` — populated only for automatic crash reports. */
        crash: Crash? = null,
        /**
         * Report Resource Window (spec 2026-09-05) — CPU/memory samples for
         * `payload.resources`. Same no-op-when-absent contract as
         * `breadcrumbs`/`networkBodies` above: an empty list ships an
         * envelope byte-identical to the pre-resources builder. Re-capped at
         * [ResourceRingBuffer.MAX_SAMPLES] here, keeping the NEWEST entries —
         * the ring itself is already capped, but re-applying the cap at this
         * encode boundary (like the trim helpers above) keeps this call site
         * from silently drifting apart from the ring's own limit; a stamp
         * exceeding the server's cap rejects the WHOLE report,
         * non-retryably. The caller (ReporterDialog / CompanionSubmission
         * Composer / CrashReporter) supplies `sharedResourceBuffer.snapshot()`.
         */
        resources: List<ResourceRingBuffer.Entry> = emptyList(),
    ): EncodedEnvelope {
        val redactedLogs = trimLogs(logs.map { it.copy(message = redactor.redact(it.message)) })
        val redactedNetwork = networkRows.map {
            it.copy(
                url = redactor.redact(it.url),
                requestHeaders = redactor.filterHeaders(it.requestHeaders),
                responseHeaders = redactor.filterHeaders(it.responseHeaders),
            )
        }

        // Breadcrumbs already passed through mask-before-bytes redaction at
        // add-time (BreadcrumbRingBuffer) — no redactor pass here, mirrors
        // sdk-core/iOS (trim is the only transform left before the wire).
        val trimmedBreadcrumbs: List<Breadcrumb>? = if (breadcrumbs.isNullOrEmpty()) {
            null
        } else {
            BreadcrumbTrim.trim(breadcrumbs, byteBudget = breadcrumbByteBudget, consoleEntryCap = breadcrumbConsoleEntryCap)
        }

        val now = Instant.now().toString()

        val logsJson: JsonArray? = if (redactedLogs.isEmpty()) null else buildJsonArray {
            redactedLogs.forEach { row ->
                add(
                    buildJsonObject {
                        put("timestamp", JsonPrimitive(Instant.ofEpochMilli(row.timestamp).toString()))
                        put("level", JsonPrimitive(row.level))
                        if (row.tag != null) put("tag", JsonPrimitive(row.tag))
                        put("message", JsonPrimitive(row.message))
                    }
                )
            }
        }

        val networkJson: JsonArray? = if (redactedNetwork.isEmpty()) null else buildJsonArray {
            redactedNetwork.forEach { row ->
                add(
                    buildJsonObject {
                        put("method", JsonPrimitive(row.method))
                        put("url", JsonPrimitive(row.url))
                        if (row.status != null) put("status", JsonPrimitive(row.status))
                        if (row.durationMs != null) put("durationMs", JsonPrimitive(row.durationMs))
                        put("requestHeaders", row.requestHeaders.toJsonObject())
                        put("responseHeaders", row.responseHeaders.toJsonObject())
                    }
                )
            }
        }

        // Re-cap at the encode boundary, keeping the NEWEST samples — same
        // doctrine as the network-body filter below: never trust an upstream
        // caller (or a future ring-buffer bug) to have already enforced the
        // limit the SERVER enforces, since exceeding it drops the WHOLE
        // report rather than merely this field.
        val cappedResources: List<ResourceRingBuffer.Entry> =
            if (resources.size > ResourceRingBuffer.MAX_SAMPLES) {
                resources.takeLast(ResourceRingBuffer.MAX_SAMPLES)
            } else {
                resources
            }

        // `payload.resources` is now a generated, typed `List<Resource>?`
        // (envelope.v1.schema.json regenerated to include the resources
        // block) — unlike logs/network above, no hand-built `JsonArray` is
        // needed. `cpu` staying OMITTED rather than an explicit null when
        // absent is enforced by kotlinx.serialization's `explicitNulls =
        // false` on `Resource.cpu`'s own Kotlin `null`, not by anything in
        // this builder.
        val resourcesList: List<Resource>? = if (cappedResources.isEmpty()) null else cappedResources.map { entry ->
            Resource(cpu = entry.cpu, mem = entry.mem.toDouble(), t = entry.t.toDouble())
        }

        val nameEnum = Name.entries.firstOrNull { it.value == sdkName } ?: Name.EverframeAndroid
        val platformEnum = Platform.entries.firstOrNull { it.value == platform } ?: Platform.Android
        val formFactorEnum = FormFactor.entries.firstOrNull { it.value == formFactor } ?: FormFactor.Phone

        // Task 15: bodies arrive ALREADY REDACTED (masked at capture time by
        // NetworkBodyCapture / the interceptor) — do NOT re-redact here,
        // unlike networkRows.url/headers above.
        //
        // Invariant (network-body-capture spec §11 test 8, inherited from the
        // web spec): every shipped `payload.networkBodies[].ref` must match
        // exactly one shipped `kind == network` crumb's `data.reqId`. Body
        // capture and breadcrumb capture are gated/evicted independently
        // upstream (breadcrumbs may be off or `kinds` may omit `network`; the
        // body ring and the crumb ring trim on unrelated budgets) — so a body
        // can outlive the crumb that gave it request context. Filter HERE,
        // at the encode boundary where both channels converge and AFTER
        // breadcrumb trimming has produced the final shipped chain, down to
        // the reqIds that actually made it onto the wire. A body without a
        // shipped crumb carries no request context for the reporter/backend,
        // so it must never upload — crumbs are the side that's authoritative
        // here and are never mutated to "rescue" an orphaned body.
        val shippedNetworkReqIds: Set<Double> = trimmedBreadcrumbs
            .orEmpty()
            .asSequence()
            .filter { it.kind == BreadcrumbKind.Network }
            .mapNotNull { reqIdOf(it.data) }
            .toSet()
        val bodiesJson: List<NetworkBody>? = networkBodies
            ?.filter { shippedNetworkReqIds.contains(it.ref) }
            ?.takeIf { it.isNotEmpty() }

        // Breadcrumbs and networkBodies are the ONLY intentional deviations
        // from a byte-identical no-crumbs/no-bodies envelope (task 10 / iOS
        // Task 6 parity, extended by Task 15): `included` gains "breadcrumbs"
        // / "networkBodies" only when a non-empty payload ships; `excluded`
        // and every other CaptureControl/Captures field are untouched
        // otherwise.
        val includedCaptures: List<String> = buildList {
            if (trimmedBreadcrumbs != null) add("breadcrumbs")
            if (bodiesJson != null) add("networkBodies")
        }

        // Tap-to-identify and UI-tree capture were removed entirely (spec
        // 2026-08-29): nothing on this platform walks a view hierarchy for the
        // envelope any more, so `payload.uiTree`, `payload.reactTree` and
        // `payload.reportTarget` are always absent.
        //
        // `captures.uiTree` is NOT dropped with them. The protocol schema
        // declares it a REQUIRED boolean, so omitting the key fails envelope
        // validation at ingest — it stays, hardcoded `false`, exactly as
        // `buildEnvelope` in sdk-core does on the JS side.

        // Vitals stamp — a bounded copy of the recent ring; a failure here
        // degrades to "no vitals", never to a lost report.
        //
        // `sessionId` and `payload.vitals` are stamped independently on
        // purpose: a running collector with an empty ring (nothing sampled
        // yet, or the whole ring pruned) still stamps `sessionId` below —
        // only `vitalsGenerated` itself collapses to null when there is
        // nothing to ship.
        val stamp = txGuard("envelope.vitalsStamp") { vitalsStamp() }
        val vitalsGenerated = stamp?.entries
            ?.takeLast(VitalsLimits.MAX_ENVELOPE_VITALS_ENTRIES)
            ?.toGeneratedVitals()
            ?.takeIf { it.isNotEmpty() }

        val envelope = ReportEnvelope(
            attachments = attachments,
            captureControl = CaptureControl(
                degradedReason = degradedReason,
                excluded = excluded,
                included = includedCaptures,
            ),
            captures = Captures(
                breadcrumbs = trimmedBreadcrumbs != null,
                focus = false,
                logs = redactedLogs.isNotEmpty(),
                network = redactedNetwork.isNotEmpty(),
                screenshot = false,
                uiTree = false,
            ),
            context = ProtocolContext(
                app = App(build = appBuild, name = appName, version = appVersion),
                device = Device(
                    locale = deviceLocale,
                    model = deviceModel,
                    os = deviceOs,
                    osVersion = deviceOsVersion,
                    pixelRatio = devicePixelRatio,
                    screenSize = ScreenSize(height = deviceScreenHeight, width = deviceScreenWidth),
                    timezone = deviceTimezone,
                ),
                route = route,
            ),
            payload = Payload(
                annotations = annotations?.takeIf { it.isNotEmpty() },
                breadcrumbs = trimmedBreadcrumbs,
                crash = crash,
                extra = userExtra,
                focus = null,
                logs = logsJson,
                network = networkJson,
                networkBodies = bodiesJson,
                redactions = redactions?.takeIf { it.isNotEmpty() },
                resources = resourcesList,
                vitals = vitalsGenerated,
            ),
            protocolVersion = ProtocolVersion.The10,
            reporter = Reporter(
                description = description,
                title = title,
                user = user?.toGenerated(),
            ),
            reportID = reportId.toString(),
            sdk = SDK(
                formFactor = formFactorEnum,
                name = nameEnum,
                platform = platformEnum,
                version = sdkVersion,
            ),
            sessionID = stamp?.sessionId,
            source = source,
            submittedAt = now,
        )

        val bytes = JSON.encodeToString(envelope).toByteArray(Charsets.UTF_8)
        val totalAttachmentBytes = attachments.sumOf { it.byteLength.toLong() }
        val total = bytes.size.toLong() + totalAttachmentBytes
        if (total > SIZE_CAP_BYTES) {
            throw EverframeEnvelopeError.PayloadTooLarge(bytes = total.toInt(), limit = SIZE_CAP_BYTES.toInt())
        }

        val sha256 = MessageDigest.getInstance("SHA-256").digest(bytes)
        val hex = sha256.joinToString("") { "%02x".format(it) }
        return EncodedEnvelope(bytes = bytes, idempotencyKey = hex, envelope = envelope)
    }

    data class TXUserExtras(
        val id: String? = null,
        val email: String? = null,
        val displayName: String? = null,
    ) {
        fun toGenerated(): User = User(displayName = displayName, email = email, id = id)

        companion object {
            /**
             * Maps the host-declared [TXUser] (self-declared identity, spec
             * 2026-08-12) into the wire shape this builder consumes. Single
             * source of truth for all three real `buildEncoded` call sites
             * (`CompanionSubmissionComposer`, `CrashReporter`,
             * `ReporterDialog`) — this used to be copy-pasted verbatim at
             * each one, which risks one silently diverging from the other
             * two while the tested paths stay green.
             *
             * Fields are copied 1:1 and only when non-null — a `TXUser`
             * carrying only an email must survive as a partially-populated
             * user, not empty strings. (`explicitNulls = false` on [JSON]
             * below then omits the absent fields as missing keys, never
             * `"id":null`.)
             */
            fun from(user: TXUser?): TXUserExtras? =
                user?.let { TXUserExtras(id = it.id, email = it.email, displayName = it.displayName) }
        }
    }

    data class EncodedEnvelope(
        val bytes: ByteArray,
        val idempotencyKey: String,
        val envelope: ReportEnvelope,
    ) {
        override fun equals(other: Any?): Boolean =
            other is EncodedEnvelope && idempotencyKey == other.idempotencyKey
        override fun hashCode(): Int = idempotencyKey.hashCode()
    }

    private fun Map<String, String>.toJsonObject(): JsonObject = buildJsonObject {
        this@toJsonObject.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
    }

    /**
     * Extract a network crumb's `data.reqId` as a [Double], tolerant of
     * whatever numeric `JsonPrimitive` representation it was stored with.
     * Mirrors the read pattern already used by
     * `NetworkBodyCaptureTest.crumb gains reqId matching body ref`
     * (`(data?.get("reqId") as? JsonPrimitive)?.content?.toDoubleOrNull()`).
     * `NetworkBody.ref` is generated as `Double` (minted from the same `Int`
     * reqId via `reqId.toDouble()`), so normalizing both sides to `Double`
     * here lets the encode-boundary filter compare them directly. Returns
     * `null` when the key is absent or not numeric.
     */
    private fun reqIdOf(data: JsonObject?): Double? =
        (data?.get("reqId") as? JsonPrimitive)?.content?.toDoubleOrNull()

    companion object {
        /** PIPE-03 hard ceiling — matches receiver-side ingest cap. */
        const val SIZE_CAP_BYTES = 25 * 1024 * 1024

        /** Max total characters of captured-log messages shipped in an envelope. */
        const val MAX_LOG_CHARS = 4000

        @JvmField
        val JSON = Json {
            encodeDefaults = true
            explicitNulls = false
            ignoreUnknownKeys = false
            prettyPrint = false
        }
    }
}
