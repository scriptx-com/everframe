// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MultipartUploader — POST envelope + per-attachment parts via OkHttp's
// `MultipartBody.Builder`. Mirrors `packages/sdk-ios/Sources/Everframe/Transport/
// MultipartUploader.swift` (98 lines) but body construction is library-driven
// (RESEARCH "Don't Hand-Roll" table — iOS hand-rolls the RFC-7578 wire format
// because URLSession lacks a multipart helper; OkHttp ships one).
//
// Wire format (LOCKED for ingest-service parity, PROTO-02):
//   POST <endpoint>
//   Authorization: Bearer <sdkKey>
//   X-Everframe-Idempotency-Key: <uuid>
//   Content-Type: multipart/form-data; boundary=...
//
//   --boundary
//   Content-Disposition: form-data; name="envelope"; filename="envelope.json"
//   Content-Type: application/json
//
//   {"reportId":...}
//   --boundary
//   Content-Disposition: form-data; name="<attachment-name>"; filename="..."
//   Content-Type: <attachment-content-type>
//
//   <bytes>
//   --boundary--
//
// Body-grep gate scope (Plan 05-04 line 386-390):
//   The CI gate `grep -r 'request\.body\|response\.body'
//   packages/sdk-android/android/everframe-core/src/main/kotlin/com/everframe/okhttp/` is intentionally
//   scoped to the okhttp/ directory only. This file lives in transport/ and is
//   exempt because (a) the body access here is on OUR OWN server response, not
//   customer traffic, and (b) the preview is bounded to 512 chars and goes only
//   to internal logger gated on BuildConfig.DEBUG.
package dev.everframe.transport

import android.util.Log
import dev.everframe.BuildConfig
import dev.everframe.envelope.txGuard
import dev.everframe.identity.IDENTITY_TOKEN_HEADER
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.*
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

// Plan 05-06 — exposed `public` so ReportSubmitter (now `public` for cross-module
// :reporter-ui usage) can declare a public default-arg constructor. Body-grep gate
// scope is unchanged: this file lives in transport/ and continues to be exempt
// from the okhttp/-scoped PRIV-03 body grep (see file-level doc-comment).
class MultipartUploader(private val client: OkHttpClient) {

    /** One form-data part. Caller supplies name, filename, content-type, bytes. */
    data class Part(
        val name: String,
        val filename: String?,
        val data: ByteArray,
        val contentType: String,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Part) return false
            return name == other.name && filename == other.filename &&
                data.contentEquals(other.data) && contentType == other.contentType
        }
        override fun hashCode(): Int {
            var r = name.hashCode()
            r = 31 * r + (filename?.hashCode() ?: 0)
            r = 31 * r + data.contentHashCode()
            r = 31 * r + contentType.hashCode()
            return r
        }
    }

    /**
     * HTTP outcome of one upload attempt. Note this is a value-object — not a
     * thrown exception — because RetryPolicy.classify() needs both status and
     * headers (for 429 Retry-After). The submitter throws on Terminal outcomes.
     */
    data class UploadResult(
        val statusCode: Int,
        val headers: Map<String, String>,
        val responseBodyPreview: String?,
        internal val effectiveEnvelope: ByteArray? = null,
        internal val effectiveParts: List<Part>? = null,
    )

    /**
     * Builds the multipart body, sets headers, executes the request on
     * Dispatchers.IO. Returns the HTTP status + headers + (DEBUG-only) bounded
     * response-body preview. IOException propagates so the submitter can
     * classify network failures via RetryPolicy.classify(error=...).
     */
    suspend fun upload(
        endpoint: String,
        sdkKey: String,
        idempotencyKey: String,
        envelopeBytes: ByteArray,
        attachments: List<Part>,
        /**
         * Companion attribution token (spec 2026-08-07) for a report filed
         * from the dashboard rather than by scanning the QR. When non-null it
         * rides this POST as `X-TX-Companion-Attribution` so ingest can credit
         * the report to the dashboard user who requested it. Null — the
         * default, and every non-companion submit — sends no header at all.
         * SECURITY: never log this value.
         */
        companionAttribution: String? = null,
        /**
         * Verified-identity JWT (recognition spec 2026-08-06), already
         * resolved by the caller via `resolveIdentityHeader` — this function
         * does no gating of its own, it only attaches whatever it is handed.
         * Rides as [IDENTITY_TOKEN_HEADER]. `null` sends the report
         * anonymously. Unlike [companionAttribution], the subject this token
         * proves IS persisted (on `OutboxEntry.identitySubject`) — the token
         * itself never is; only what to compare a future token against.
         * SECURITY: never log this value.
         */
        identityToken: String? = null,
        authorization: ReportAuthorization? = null,
    ): UploadResult = withContext(Dispatchers.IO) {

        var expected = authorization?.evaluate() ?: ReportAuthorizationDecision(true, true)
        if (!expected.reportAllowed) throw ReportAuthorizationCancelled()
        var payload = preparePayload(envelopeBytes, attachments, expected.replayAllowed)
        repeat(2) { attempt ->
            validatePayload(payload.first, payload.second)
            listOfNotNull(endpoint, sdkKey, idempotencyKey, identityToken, companionAttribution).forEach {
                require(it.length <= 16_384 && it.toByteArray(Charsets.UTF_8).size <= 16_384) { "Routing/header field exceeds limit" }
            }
            val body = multipartBody(payload.first, payload.second)
            requireBodyLength(body.contentLength())

            // Append /api/ingest to the configured BASE endpoint (matches
            // @everframe/react contract; sdk-ios MultipartUploader does the
            // same). Hosts that already pass a fully-qualified /api/ingest URL
            // are tolerated — we don't double-append.
            val ingestUrl = run {
                val trimmed = endpoint.trimEnd('/')
                if (trimmed.endsWith("/api/ingest")) trimmed else "$trimmed/api/ingest"
            }

            val req = Request.Builder()
                .url(ingestUrl)
                .header("Authorization", "Bearer $sdkKey")
                .header("X-Everframe-Idempotency-Key", idempotencyKey)
                .apply {
                    // SECURITY: never log companionAttribution — it is only ever
                    // written into this header.
                    if (companionAttribution != null) {
                        header("X-TX-Companion-Attribution", companionAttribution)
                    }
                    // SECURITY: never log identityToken — same posture as
                    // companionAttribution above.
                    if (identityToken != null) {
                        header(IDENTITY_TOKEN_HEADER, identityToken)
                    }
                }
                .post(body)
                .build()

            if (BuildConfig.DEBUG) {
                Log.d("Everframe", "POST $ingestUrl envelopeBytes=${envelopeBytes.size} parts=${attachments.size}")
            }

            val call = client.newCall(req)
            val result = suspendCancellableCoroutine<UploadResult?> { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                val callback = object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        continuation.resumeWithException(UploadIOException(e, payload.first, payload.second))
                    }
                    override fun onResponse(call: Call, response: Response) {
                        response.use { resp ->
                            try {
                                val headers = resp.headers.toMultimap().mapValues { it.value.firstOrNull().orEmpty() }
                                val preview = if (resp.code !in 200..299 || BuildConfig.DEBUG) {
                                    txGuard("upload.body-preview") { resp.peekBody(2048).string().take(512) }
                                } else null
                                continuation.resume(UploadResult(resp.code, headers, preview, payload.first, payload.second))
                            } catch (failure: Exception) { continuation.resumeWithException(failure) }
                        }
                    }
                }
                try {
                    val started = if (!continuation.isActive) false else if (authorization == null) {
                        call.enqueue(callback); true
                    } else authorization.tryStart(expected) { call.enqueue(callback) }
                    if (!started) { call.cancel(); continuation.resume(null) }
                } catch (failure: Exception) { continuation.resumeWithException(failure) }
            }
            if (result != null) return@withContext result
            val current = authorization?.evaluate() ?: throw ReportAuthorizationCancelled()
            if (attempt != 0 || !current.reportAllowed || !expected.replayAllowed || current.replayAllowed) {
                throw ReportAuthorizationCancelled()
            }
            expected = current
            payload = preparePayload(payload.first, payload.second, replayAllowed = false)
        }
        throw ReportAuthorizationCancelled()
    }

    internal companion object {
        internal fun multipartBody(envelope: ByteArray, parts: List<Part>): MultipartBody =
            MultipartBody.Builder().setType(MultipartBody.FORM).apply {
                addFormDataPart("envelope", "envelope.json", envelope.toRequestBody("application/json".toMediaType()))
                parts.forEach { addFormDataPart(it.name, it.filename, it.data.toRequestBody(it.contentType.toMediaType())) }
            }.build()

        internal fun requireBodyLength(length: Long) {
            require(length in 0..25_000_000L) { "Multipart body exceeds limit or has unknown length" }
        }

        internal fun validateRawInput(envelope: ByteArray, attachmentCount: Int) {
            require(envelope.size <= 1_000_000) { "Envelope exceeds limit" }
            // Accept the historical six-attachment input/storage shape so optional video can be removed.
            require(attachmentCount in 0..6) { "Too many attachments" }
        }

        internal fun validatePayload(envelope: ByteArray, parts: List<Part>) {
            validateRawInput(envelope, parts.size)
            // Ingest permits six file parts INCLUDING envelope.json.
            require(parts.size <= 5) { "Too many attachments" }
            require(envelope.size.toLong() + parts.sumOf { it.data.size.toLong() } <= 24_000_000L) { "Payload exceeds limit" }
            require(parts.map { it.name }.toSet().size == parts.size && parts.none { it.name == "envelope" }) { "Duplicate/reserved part name" }
            parts.forEach { part ->
                listOfNotNull(part.name, part.filename, part.contentType).forEach {
                    require(it.length <= 1024 && it.toByteArray(Charsets.UTF_8).size <= 1024) { "Part metadata exceeds limit" }
                }
            }
        }

        /**
         * Retains the captured report/idempotency and all non-video evidence. Applied before
         * live admission and again on upload so historical encrypted entries also fit ingest.
         * Final validation measures the rewritten envelope; omission never bypasses a limit.
         */
        internal fun preparePayload(envelope: ByteArray, parts: List<Part>, replayAllowed: Boolean): Pair<ByteArray, List<Part>> {
            // Caller input must be bounded even when optional-video omission would shrink it.
            validateRawInput(envelope, parts.size)
            val budgetReason = when {
                parts.size > 5 -> "replay_part_limit"
                envelope.size.toLong() + parts.sumOf { it.data.size.toLong() } > 24_000_000L -> "replay_report_budget"
                else -> null
            }
            if (replayAllowed && budgetReason == null) return envelope to parts
            val videoNames = parts.filter { it.contentType.substringBefore(';') == "video/mp4" }.map { it.name }.toMutableSet()
            val root = Json.parseToJsonElement(envelope.decodeToString()) as? JsonObject
                ?: return envelope to parts.filterNot { it.name in videoNames }
            val metadata = root["attachments"] as? JsonArray
            val kept = metadata?.filterNot { element ->
                val item = element as? JsonObject ?: return@filterNot false
                val format = (item["format"] as? JsonPrimitive)?.content
                val video = format == "everframe-video-v1" ||
                    format == "traceitx-video-v1" ||
                    (item["contentType"] as? JsonPrimitive)?.content == "video/mp4" ||
                    (item["partName"] as? JsonPrimitive)?.content in videoNames
                if (video) (item["partName"] as? JsonPrimitive)?.content?.let(videoNames::add)
                video
            }
            if (videoNames.isEmpty() && kept == metadata) return envelope to parts
            val updated = JsonObject(root.toMutableMap().apply {
                if (kept != null) put("attachments", JsonArray(kept))
                if (budgetReason != null && replayAllowed) {
                    val control = (root["captureControl"] as? JsonObject)?.toMutableMap() ?: mutableMapOf()
                    val priorReason = (control["degradedReason"] as? JsonPrimitive)?.contentOrNull
                    control["degradedReason"] = JsonPrimitive(listOfNotNull(priorReason, budgetReason).joinToString(";"))
                    control.putIfAbsent("included", JsonArray(emptyList()))
                    control.putIfAbsent("excluded", JsonArray(emptyList()))
                    put("captureControl", JsonObject(control))
                }
            })
            return updated.toString().toByteArray() to parts.filterNot { it.name in videoNames }
        }
    }
}

internal class ReportAuthorizationCancelled : Exception("Report authorization revoked")

internal class UploadIOException(val networkFailure: IOException, val envelope: ByteArray, val parts: List<MultipartUploader.Part>) : IOException(networkFailure)
