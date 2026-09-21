// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReportSubmitter — orchestrates the submit pipeline:
//   build envelope → POST → on retryable failure enqueue → on terminal throw.
//
// Wave-3 file-ownership note: this class ships standalone. Plan 05-06 wires
// `TraceItX.report.__resolver = { ... ReportSubmitter(config, outbox).submit(...) }`
// and calls `submitter.drainOutbox()` from TraceItX.start()'s detached coroutine.
// Plan 05-05 does NOT modify TraceItX.kt — single-writer invariant preserved.
//
// CRITICAL invariant (T-05-05-E mitigation):
//   Submitter's internal OkHttpClient is built WITHOUT TraceItXInterceptor.
//   Otherwise our own POST /api/ingest would be captured by our own interceptor
//   → recursive expansion → infinite outbox growth. A source-grep CI gate
//   enforces this — see Plan 05-05 acceptance criteria.
//   Mirrors iOS `ReportSubmitter.makeIsolatedSession()` lines 169-177.
//
// drainOutbox-before-submit ordering (PATTERNS lines 485-486):
//   drain() runs BEFORE the next submit so transient failure during drain
//   re-enqueues without double-counting. Idempotent across crashes.
package com.traceitx.transport

import com.traceitx.TraceItX
import com.traceitx.TXCapturedSession
import com.traceitx.outbox.OutboxAuthorization
import com.traceitx.outbox.OutboxStore
import com.traceitx.outbox.OutboxToken
import com.traceitx.outbox.OutboxWriteException
import com.traceitx.outbox.OutboxFailure
import kotlinx.coroutines.CancellationException
import com.traceitx.config.IngestEndpoint
import com.traceitx.config.ReplayConfig
import com.traceitx.config.ReportResult
import com.traceitx.config.isIdentityEnabled
import com.traceitx.config.TraceItXConfig
import com.traceitx.identity.IDENTITY_TOKEN_HEADER
import com.traceitx.identity.IdentityTokenHolder
import com.traceitx.identity.resolveIdentityHeader
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.outbox.OutboxEntry
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

// Plan 05-06 cross-module entry — :reporter-ui constructs ReportSubmitter inside
// the reporter Dialog's submit handler. The isolated-OkHttpClient invariant is
// still enforced by the source-grep gate (no addTraceItXInterceptor reference
// in this file); making the class public does not relax that gate.
class ReportSubmitter(
    private val config: TraceItXConfig,
    private val outbox: JSONLOutbox,
    private val uploader: MultipartUploader = MultipartUploader(buildIsolatedClient()),
    /**
     * Test seam — production uses [IngestEndpoint.url] (baked at library build
     * time per variant). Tests pass MockWebServer's URL here.
     *
     * Redirects LIVE SUBMITS only (see `endpointUrl` below, used at the submit
     * and enqueue sites). It does NOT affect `drainOutbox()`, which routes each
     * queued entry by the endpoint stamped on it at capture time.
     *
     * That asymmetry is deliberate — a queued report belongs to the project and
     * host that captured it — but it is not obvious, and a test once passed
     * this expecting a drain to follow it, then blocked forever when no request
     * arrived. To redirect what a drain targets, change what gets STAMPED (in
     * debug, `EndpointOverride.current`), not what the submitter is handed.
     */
    private val endpointOverride: String? = null,
) {
    private val endpointUrl: String get() = endpointOverride ?: IngestEndpoint.url

    /**
     * One outbound attachment. Mirrors `OutboxEntry.AttachmentRef` but stays
     * API-friendly with raw `ByteArray` instead of base64.
     */
    data class Attachment(
        val name: String,
        val filename: String,
        val contentType: String,
        val data: ByteArray,
        val sha256Hex: String,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Attachment) return false
            return name == other.name && filename == other.filename &&
                contentType == other.contentType && data.contentEquals(other.data) &&
                sha256Hex == other.sha256Hex
        }
        override fun hashCode(): Int {
            var r = name.hashCode()
            r = 31 * r + filename.hashCode()
            r = 31 * r + contentType.hashCode()
            r = 31 * r + data.contentHashCode()
            r = 31 * r + sha256Hex.hashCode()
            return r
        }
    }

    /**
     * Submit one report. Returns:
     *   - `ReportResult.Submitted(reportId)` on HTTP 2xx
     *   - `ReportResult.Queued(reportId)` on transient/retryable failure
     *     (the entry is enqueued to the outbox for later drain)
     *   - `ReportResult.Cancelled("kill_switch")` if `TraceItX.captureGate` is off
     *
     * Throws `TraceItXTransportError.ServerError(status, body)` on terminal HTTP
     * (4xx other than 408/429) or `TraceItXTransportError.NetworkUnavailable` on
     * a non-retryable transport error.
     */
    suspend fun submit(
        envelopeBytes: ByteArray,
        idempotencyKey: String,
        attachments: List<Attachment>,
        reportId: UUID = UUID.randomUUID(),
        /**
         * Companion attribution token (spec 2026-08-07) — rides the ingest
         * POST as `X-TX-Companion-Attribution`. Null (the default) for every
         * in-process reporter submit; non-null only for a report the dashboard
         * asked this device to file. Deliberately NOT persisted into the
         * outbox: the token is short-lived, so a retried-hours-later drain
         * would present a stale credential rather than an unattributed report.
         * SECURITY: never log.
         */
        companionAttribution: String? = null,
        /**
         * The verified-identity subject this report was CAPTURED under
         * (`TXCapturedUser.identitySubject` on the live path,
         * `OutboxEntry.identitySubject` on drain) — persisted onto the
         * outbox entry if this attempt fails transiently, so a retry keeps
         * the ORIGINAL captured subject rather than losing it. This
         * parameter does not itself decide whether a header is attached; see
         * [identityToken].
         */
        identitySubject: String? = null,
        /**
         * The value to present as `X-TX-Identity-Token`, already resolved by
         * the caller via `resolveIdentityHeader(capturedSubject:holder:
         * config:nowMs:)`. `null` sends the report anonymously. Kept
         * separate from [identitySubject] because the two answer different
         * questions: the subject is what to REMEMBER if this attempt has to
         * be re-queued, the token is what to PRESENT on this attempt.
         */
        identityToken: String? = null,
        authorization: ReportAuthorization? = null,
    ): ReportResult {
        val capturedAuthorization = authorization ?: ReportAuthorizationFactory.forCapture(TraceItX.captureSessionSnapshot(), null)
        if (!TraceItX.captureGate || !capturedAuthorization.evaluate().reportAllowed) return ReportResult.Cancelled("kill_switch")
        // Bound before collection materialization, JSON parsing, or defensive copying.
        MultipartUploader.validateRawInput(envelopeBytes, attachments.size)
        val initialParts = attachments.map { MultipartUploader.Part(it.name, it.filename, it.data, it.contentType) }
        val prepared = MultipartUploader.preparePayload(envelopeBytes, initialParts, capturedAuthorization.evaluate().replayAllowed)
        MultipartUploader.validatePayload(prepared.first, prepared.second)
        val names = prepared.second.map { it.name }.toSet()
        var candidate = toEntry(reportId, prepared.first.copyOf(), idempotencyKey,
            attachments.filter { it.name in names }.map { it.copy(data = it.data.copyOf()) }, identitySubject)
        require(candidate.reportId.length <= 256 && candidate.reportId.toByteArray(Charsets.UTF_8).size <= 256)
        listOfNotNull(candidate.endpoint, candidate.sdkKey, candidate.idempotencyKey, candidate.identitySubject).forEach {
            require(it.length <= 16_384 && it.toByteArray(Charsets.UTF_8).size <= 16_384) { "Captured routing field exceeds limit" }
        }
        val result = try {
            uploader.upload(candidate.endpoint, candidate.sdkKey, candidate.idempotencyKey, candidate.envelopeBytes,
                candidate.parts(), companionAttribution, identityToken, capturedAuthorization)
        } catch (_: ReportAuthorizationCancelled) {
            return ReportResult.Cancelled("kill_switch")
        } catch (failure: IOException) {
            val networkFailure = if (failure is UploadIOException) failure.networkFailure else failure
            if (RetryPolicy.classify(null, emptyMap(), networkFailure) == RetryPolicy.Classification.Terminal) {
                throw TraceItXTransportError.NetworkUnavailable
            }
            if (failure is UploadIOException) candidate = candidate.withPayload(failure.envelope, failure.parts)
            null
        }
        if (result != null) {
            if (result.statusCode in 200..299) return ReportResult.Submitted(reportId)
            if (RetryPolicy.classify(result.statusCode, result.headers, null) == RetryPolicy.Classification.Terminal) {
                throw TraceItXTransportError.ServerError(result.statusCode, result.responseBodyPreview)
            }
            candidate = candidate.withPayload(result.effectiveEnvelope ?: candidate.envelopeBytes,
                result.effectiveParts ?: candidate.parts())
        }
        // Storage exceptions are outside the network catch. Only optional revocation permits
        // a second admission, with the same captured identity/route and permanently omitted video.
        repeat(2) { attempt ->
            val hasReplay = candidate.hasVideo()
            try {
                outbox.enqueue(candidate, object : OutboxAuthorization {
                    override fun isAllowed(): Boolean = capturedAuthorization.evaluate().let {
                        it.reportAllowed && (!hasReplay || it.replayAllowed)
                    }
                })
                return ReportResult.Queued(reportId)
            } catch (failure: OutboxWriteException) {
                if (failure.failure != OutboxFailure.REVOKED) throw failure
                val decision = capturedAuthorization.evaluate()
                if (!decision.reportAllowed) return ReportResult.Cancelled("kill_switch")
                if (attempt != 0 || !hasReplay || decision.replayAllowed) throw failure
                val omitted = MultipartUploader.preparePayload(candidate.envelopeBytes, candidate.parts(), false)
                candidate = candidate.withPayload(omitted.first, omitted.second)
            }
        }
        error("Admission exhausted")
    }

    /**
     * Best-effort drain of the persistent outbox: decode one exact token at a time,
     * attempt in order, drop successes (failures stay queued via the predicate
     * returning false). Safe to invoke from `TraceItX.start()`'s detached
     * coroutine — Plan 05-06 owns that wiring.
     *
     * Drain runs BEFORE the next submit so transient failure during drain
     * re-enqueues without double-counting (PATTERNS lines 485-486).
     *
     * Drains queued entries, each to its OWN stamped endpoint and key.
     * `endpointOverride` is deliberately not consulted here; see its doc above.
     * `OutboxKeyBindingTest` pins this behaviour — it enqueues entries for two
     * different servers, passes an override naming only the first, and asserts
     * each report still reaches its own server.
     *
     * @param identityHolder/currentReplayConfig how this pass resolves each
     *   entry's `X-TX-Identity-Token`, via `resolveIdentityHeader(capturedSubject =
     *   entry.identitySubject, holder =, config =, nowMs =)` — mirroring how
     *   `sdkKey`/`endpoint` above come from each entry rather than the live
     *   config, EXCEPT that the subject is the only piece that is captured:
     *   the holder and the enablement gate are read live because there is
     *   only ever one current token and one current `identity.enabled` —
     *   `resolveIdentityHeader` itself is what keeps a live token from
     *   crossing onto a report captured under a different subject.
     *
     *   Deliberately NO defaults (Task 8b). A default `IdentityTokenHolder()`
     *   / [ReplayConfig.OFF] pair is indistinguishable from a caller that
     *   forgot to pass anything — every production call site used to rely on
     *   exactly that default, which is how this gate shipped wired-but-inert:
     *   reachable, tested, and never actually invoked with a holder capable of
     *   resolving a token. Every caller — `TraceItX.start()`'s launch drain,
     *   `TraceItX.requestOutboxDrain()`'s RN non-fatal drain, and every test —
     *   must now name the real singleton holder and the live [ReplayConfig]
     *   accessor (or an explicit [ReplayConfig.OFF] fixture) so the compiler
     *   forces the decision instead of silently defaulting to "identity never
     *   attaches."
     *
     *   Independent review, round 11, P1(c) — `currentReplayConfig` is a
     *   closure, not a captured value: this drain loop can run for minutes
     *   across many entries (each attempt can spend a full network timeout
     *   before falling back to retryable-queue), and a SINGLE [ReplayConfig]
     *   captured once, before the loop, went stale the moment remote config
     *   disabled identity partway through — later entries in the same pass
     *   kept invoking the provider and attaching tokens on the strength of a
     *   decision that was already reversed. Called FRESH per entry, both
     *   BEFORE `resolveIdentityHeader` (so a config that has already flipped
     *   off by the time this entry's turn comes never even reaches the
     *   holder) and AGAIN immediately after it returns (closing the identical
     *   TOCTOU shape [currentEpoch]'s own before/after pair closes two lines
     *   below). This is ONLY the enablement decision — routing
     *   (`entry.sdkKey`/`entry.endpoint`, compared against THIS submitter's
     *   own frozen `config`/`endpointUrl` a few lines below) stays bound to
     *   the entry's OWN captured project, exactly as rounds 6/7 established:
     *   "which project may this token attach to" is still frozen at capture
     *   time; only "is identity even turned on right now" is re-read live.
     * @param epochAtInitiation independent review, round 8, Serious 1 — the
     *   epoch that was live at the moment THIS DRAIN WAS DECIDED, captured
     *   by the caller synchronously alongside/immediately after the
     *   `config` this submitter was constructed with (e.g. `TraceItX
     *   .start()`'s own captured epoch, or a same-scope
     *   `TraceItX.currentStartEpoch()` read right before constructing the
     *   `ReportSubmitter` for a non-fatal crash's immediate drain). NOT the
     *   same value the OLD `epochAtDrainStart` used to compute by calling
     *   `currentEpoch()` once at the top of THIS function's own body — that
     *   was the bug. Both this function and its callers run inside a
     *   launched coroutine that can sit unscheduled for an arbitrary amount
     *   of time (dispatcher scheduling delay, a suspend call ahead of the
     *   drain, a slow network drain of an earlier entry); a
     *   `start(projectB)` landing ANY time in that gap — before this
     *   function's body ever starts running, not just during it — was
     *   invisible to a baseline sampled from inside this function, because
     *   that baseline would already reflect project B by the time it was
     *   taken. Concretely: a submitter built under project A, whose drain
     *   is initiated but doesn't actually run until after
     *   `start(projectB)` landed, used to sample `epochAtDrainStart` = B's
     *   epoch (correct-looking, but the WRONG reference point), while
     *   `entry.sdkKey == config.sdkKey` still compared against A (this
     *   submitter's own frozen config) and passed — so project B's live
     *   token (same `sub`, plausible) could attach to a request authorized
     *   with project A's SDK key, to project A's endpoint: disclosure of a
     *   live bearer credential to the wrong project's host, not merely
     *   misattribution (`aud` verification stops the latter but not the
     *   former).
     * @param currentEpoch a LIVE read of `TraceItX.currentStartEpoch()`,
     *   supplied as a closure so this file stays decoupled from the
     *   singleton (same reason `identityHolder`/`replayConfig` are passed
     *   in rather than read here). Compared against [epochAtInitiation] —
     *   never against itself/a value it produced — both BEFORE
     *   `resolveIdentityHeader` is ever called (so a mismatch already
     *   known at loop-entry skips the resolve entirely) and again AFTER it
     *   returns, before the result is ever used: `resolveIdentityHeader`
     *   is `suspend`, and its own suspension (the holder's provider
     *   re-ask) gives a `start(projectB)` + `setIdentityToken(B)` landing
     *   DURING resolution — after the pre-check already passed — a second
     *   window to land, the same TOCTOU shape independent review, Serious
     *   2 closed for the live submit path
     *   ([TraceItX.__resolveIdentityToken]).
     */
    suspend fun drainOutbox(
        identityHolder: IdentityTokenHolder,
        currentReplayConfig: () -> ReplayConfig,
        epochAtInitiation: Int,
        currentEpoch: () -> Int,
        drainSession: TXCapturedSession = TraceItX.captureSessionSnapshot(),
        endpointAtInitiation: String = endpointUrl,
    ) {
        if (drainSession.isRevoked || !drainSession.captureConsent) return
        outbox.drainOwned { pending ->
            val entry = pending.entry
            try {
                val authority = OutboxDrainAuthorization(outbox.store, pending.token,
                    ReportAuthorizationFactory.forPending(drainSession, endpointAtInitiation, entry.endpoint, entry.sdkKey))
                val parts = entry.attachmentRefs.map { ref ->
                    MultipartUploader.Part(
                        name = ref.name,
                        filename = ref.filename,
                        data = ref.data,
                        contentType = ref.contentType,
                    )
                }
                // Final whole-branch review, Important 2 — the identity
                // header had no project binding, unlike everything around
                // it. The upload two lines below deliberately uses the
                // ENTRY's own credentials ("a queued report belongs to the
                // project that captured it; draining it under whatever key
                // start() was last handed is a cross-tenant leak of the
                // whole report" — see that comment below). The identity
                // header used to be exempt from that rule — resolved from
                // the LIVE holder/config regardless of which project `entry`
                // actually belongs to.
                //
                // Concretely: start(projectA) queues a report (sdkKey=A,
                // identitySubject="u_42") -> start(projectB) ->
                // setIdentityToken(B's token, whose sub is ALSO "u_42" —
                // likely, since sub is the host's own user id, unchanged
                // across a tenant or dev/prod switch) -> drain fires ->
                // project B's LIVE bearer credential would ship to project
                // A's endpoint, which may be a different host entirely.
                // Server-side `aud` checking stops misattribution, but this
                // is disclosure of a live bearer credential to another
                // tenant's ingest.
                //
                // Independent review, round 4 (Serious 1) — the sdkKey check
                // alone is not the full binding `sdkKey`/`endpoint`
                // themselves already have (`entry.endpoint`/`entry.sdkKey`,
                // a few lines below). PR #63 stored the endpoint alongside
                // the key specifically because "the endpoint is
                // independently redirectable, so a key alone can still
                // reach the wrong host" — a debug `EndpointOverride.current`
                // (or a future per-project endpoint) changing between when
                // this entry was queued and when it drains would otherwise
                // let a live token attach to an entry whose upload
                // destination is a DIFFERENT host, even though its sdkKey
                // still matches. `endpointUrl` (not `entry.endpoint`) is the
                // live comparison target — same accessor `submit()`'s own
                // enqueue-on-failure path uses to stamp a FRESH entry, so
                // this reads as "does entry still belong to what a live
                // submit would stamp right now."
                //
                // Refuse the header outright unless the entry's own sdkKey
                // AND endpoint both still match the live ones — the same
                // binding `sdkKey`/`endpoint` already have, now extended to
                // the header.
                val identityToken = if (
                    entry.sdkKey == config.sdkKey &&
                    entry.endpoint == endpointAtInitiation &&
                    endpointUrl == endpointAtInitiation &&
                    currentEpoch() == epochAtInitiation
                ) {
                    // Round 11, P1(c) — read live, FRESH for THIS entry, not
                    // once for the whole drain: a long drain can span a
                    // remote config change, and only the CURRENT enablement
                    // decision may ever gate a token.
                    val resolved = resolveIdentityHeader(
                        capturedSubject = entry.identitySubject,
                        holder = identityHolder,
                        config = currentReplayConfig(),
                        nowMs = System.currentTimeMillis(),
                    )
                    // Re-read AGAIN after resolution, not just re-check the
                    // epoch: resolveIdentityHeader's own suspension (the
                    // holder's provider re-ask) gives a config flip DURING
                    // resolution a second window to land, the same TOCTOU
                    // shape the epoch re-check closes for project switches.
                    if (currentEpoch() == epochAtInitiation && endpointUrl == endpointAtInitiation &&
                        isIdentityEnabled(currentReplayConfig())) {
                        resolved
                    } else {
                        null
                    }
                } else {
                    null
                }
                val r = uploader.upload(
                    // The entry's OWN credentials, not the live config's. A
                    // queued report belongs to the project that captured it;
                    // draining it under whatever key start() was last handed
                    // is a cross-tenant leak of the whole report.
                    endpoint = entry.endpoint,
                    sdkKey = entry.sdkKey,
                    idempotencyKey = entry.idempotencyKey,
                    envelopeBytes = entry.envelopeBytes,
                    attachments = parts,
                    identityToken = identityToken,
                    authorization = authority,
                )
                // 2xx → drop from outbox. Anything else (transient or terminal)
                // → keep entry; next drain pass will retry. Terminal status on
                // a drained entry is a known oddity (server changed its mind);
                // we accept the small leak rather than silently discarding
                // payloads.
                r.statusCode in 200..299
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: IOException) {
                false  // keep entry; transient failure
            } catch (_: Throwable) {
                false  // defensive: any error keeps the entry
            }
        }
    }

    // MARK: - Private

    private fun toEntry(
        reportId: UUID,
        envelopeBytes: ByteArray,
        idempotencyKey: String,
        attachments: List<Attachment>,
        identitySubject: String? = null,
    ): OutboxEntry = OutboxEntry(
        reportId = reportId.toString(),
        createdAt = System.currentTimeMillis(),
        envelopeBytes = envelopeBytes,
        idempotencyKey = idempotencyKey,
        attachmentRefs = attachments.map {
            OutboxEntry.AttachmentRef(
                name = it.name,
                filename = it.filename,
                contentType = it.contentType,
                data = it.data,
                sha256Hex = it.sha256Hex,
            )
        },
        sdkKey = config.sdkKey,
        endpoint = endpointUrl,
        identitySubject = identitySubject,
    )

    companion object {
        /**
         * Build an OkHttpClient that intentionally excludes TraceItXInterceptor
         * (Plan 04). This is the "isolated client" invariant — submitter's own
         * POST /api/ingest must NOT recurse through our own capture pipeline.
         *
         * SOURCE GREP GATE: this file must contain zero references to the
         * Plan 04 OkHttp extension function that wires the capture interceptor
         * into a host-app client. See Plan 05-05 acceptance criteria.
         *
         * Independent review, round 13, Serious — also installs
         * [IdentityHeaderRedirectGuard] as a NETWORK interceptor (see that
         * object's own doc comment for the full mechanism): without it, a
         * cross-origin redirect of the ingest POST would carry
         * [IDENTITY_TOKEN_HEADER] — a real person's bearer credential — to
         * whatever host the redirect points at, where it could be replayed.
         */
        internal fun buildIsolatedClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .addNetworkInterceptor(IdentityHeaderRedirectGuard)
            .build()
    }
}

internal class OutboxDrainAuthorization(
    private val store: OutboxStore,
    private val token: OutboxToken,
    private val delegate: ReportAuthorization,
) : ReportAuthorization {
    override fun evaluate(): ReportAuthorizationDecision =
        store.withPresent(token) { delegate.evaluate() } ?: ReportAuthorizationDecision(false, false)
    override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean =
        store.withPresent(token) { delegate.tryStart(expected, start) } ?: false
}

private fun OutboxEntry.parts() = attachmentRefs.map { MultipartUploader.Part(it.name, it.filename, it.data, it.contentType) }
private fun OutboxEntry.withPayload(envelope: ByteArray, parts: List<MultipartUploader.Part>): OutboxEntry {
    val names = parts.map { it.name }.toSet()
    return copy(envelopeBytes = envelope, attachmentRefs = attachmentRefs.filter { it.name in names })
}
private fun OutboxEntry.hasVideo(): Boolean = attachmentRefs.any { it.contentType.substringBefore(';') == "video/mp4" } ||
    !MultipartUploader.preparePayload(envelopeBytes, parts(), false).first.contentEquals(envelopeBytes)

/**
 * Independent review, round 13, Serious — [IDENTITY_TOKEN_HEADER] rides the
 * ingest POST (see [MultipartUploader.upload]'s own `identityToken`
 * parameter), but OkHttp follows redirects by default, and its handling of
 * a CUSTOM header on a cross-origin redirect is not the same as its
 * handling of `Authorization`.
 *
 * OkHttp already strips `Authorization` when a redirect crosses origins
 * (`RetryAndFollowUpInterceptor`'s own `followUpRequest` logic) — but it
 * does NOT strip custom headers, so without this guard `IDENTITY_TOKEN_HEADER`
 * would ride straight through to the new host.
 *
 * A NETWORK interceptor, not an application one: an application interceptor
 * (`OkHttpClient.Builder.addInterceptor`) sees only ONE request/response
 * pair per LOGICAL call — OkHttp's own `RetryAndFollowUpInterceptor`
 * resolves every redirect hop transparently BELOW it in the chain — so an
 * application interceptor can never see or modify an individual redirect
 * hop at all. A network interceptor (`addNetworkInterceptor`) runs once per
 * PHYSICAL request, positioned AFTER redirect resolution, which is exactly
 * the seam needed here: `chain.request()` at this point is whatever
 * `RetryAndFollowUpInterceptor` decided the CURRENT hop's request should be
 * — the original request on the first hop, the redirected one on every hop
 * after.
 *
 * `chain.call().request()` is the ORIGINAL request handed to
 * `client.newCall(...)` — a fixed property of the `Call`, unaffected by how
 * many redirects follow. Comparing ITS origin (scheme+host+port; OkHttp's
 * own `HttpUrl.port` already resolves to the scheme's default when the URL
 * didn't specify one explicitly, so no separate default-port handling is
 * needed here the way a raw `java.net.URL`/Swift `URL` would require) to
 * `chain.request()`'s CURRENT origin is what "same-origin" means.
 *
 * A same-origin redirect (a different path, or an http->https upgrade on
 * the SAME host) keeps the header; anything else strips it — but the
 * request itself is still let through via `chain.proceed(...)` either way.
 * Rejecting a cross-origin redirect outright was considered and rejected:
 * recognition must never fail or stall a report — the exact rule this
 * feature has already needed twice on this branch (round 5's malformed-
 * token handling, round 6's provider-cancellation handling) — and an
 * ordinary, legitimate server-side redirect (a load balancer or CDN
 * change) would otherwise turn into a dropped report instead of degrading
 * to the anonymous direction.
 *
 * Deliberately does NOT touch `X-TX-Companion-Attribution` — established to
 * have the identical exposure (verified on iOS; not independently
 * re-verified against OkHttp's specific behaviour here, but there is no
 * reason to expect OkHttp treats it any differently from
 * [IDENTITY_TOKEN_HEADER], another arbitrary custom header) — but it
 * predates this branch and is out of scope for this fix; flagged for its
 * own follow-up.
 */
internal object IdentityHeaderRedirectGuard : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.call().request().url
        val current = chain.request().url
        val sameOrigin = original.scheme == current.scheme &&
            original.host == current.host &&
            original.port == current.port
        val request = if (sameOrigin) {
            chain.request()
        } else {
            chain.request().newBuilder().removeHeader(IDENTITY_TOKEN_HEADER).build()
        }
        return chain.proceed(request)
    }
}
