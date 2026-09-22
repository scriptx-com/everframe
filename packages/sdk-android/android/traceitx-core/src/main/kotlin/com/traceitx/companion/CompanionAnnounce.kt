// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// POST /api/companion/announce — the device's one authenticated HTTP hop
// before the relay socket opens (spec 2026-08-07). A WebSocket handshake has
// nowhere safe to carry the SDK key (a key in the socket URL is written into
// every access log), so the key is proven here over ordinary HTTPS and spent
// as a single-use ticket on `/relay/tv/<ticket>`.
//
// EVERY failure returns null. A device that cannot announce — offline, revoked
// key, older server with no such route (404), timeout, malformed body, TLS
// failure — falls back to plain `/relay/tv` and behaves exactly as it did
// before this feature existed: the QR works, pairing works, reports land. It
// is simply absent from the dashboard's device list. Companion auth failing
// must never cost a team their bug reporting; that rule outranks everything
// else in this file. There is deliberately no retry — the fallback IS the
// retry, and the next reconnect attempt announces again.
//
// SECURITY: never log the ticket. It is a bearer credential for exactly one
// relay handshake; it belongs in the socket URL and nowhere else. The SDK key
// and any thrown error (OkHttp messages can echo the request URL) are equally
// off-limits.
//
// Port of `packages/sdk-react/src/companion/announce.ts` and
// `packages/sdk-ios/Sources/TraceItX/Companion/CompanionAnnounce.swift` —
// same contract, same all-failures-are-null disposition.

package com.traceitx.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * A successful announce: the single-use relay ticket plus the short display
 * code the host renders beside the QR so a dashboard user can pick this
 * device out of the project's list.
 *
 * SECURITY: [ticket] is a credential — never log it.
 *
 * `internal`: this is an implementation detail of [RelayWSClient]'s connect
 * path, not SDK surface. It was briefly Kotlin-public, which would have made it
 * public API on a published AAR — and the R8 story for this module already
 * treats it as an internal helper (see `proguard-rules.pro:8-14` and the
 * variant exclusion in `build.gradle.kts`). Nothing outside `:traceitx-core`
 * references it.
 */
internal data class AnnounceResult(
    val ticket: String,
    val code: String,
    /**
     * Server-resolved display name (naming spec 2026-08-24) — a custom
     * rename, falling back to a host label, falling back to a
     * server-composed default from the `device` block. `null` when the
     * response omitted the field (older server), it was JSON `null`, or it
     * was present but blank.
     */
    val resolvedName: String? = null,
)

internal class CompanionAnnounce(
    client: OkHttpClient,
    private val baseUrl: String,
    /** SECURITY: never log. */
    private val sdkKey: String,
    timeoutSeconds: Long = 5,
) {

    /**
     * Wire shape of a 200 body. Decoding through a `@Serializable` class
     * (rather than a loose `JsonObject` lookup) is what makes a non-string
     * `ticket` or a missing `code` fail closed — both throw here and become
     * null.
     */
    @Serializable
    private data class Wire(val ticket: String, val code: String, val resolvedName: String? = null)

    /**
     * The announce response is OURS to widen later (the server may add fields
     * without a protocol bump), so unknown keys are tolerated here. This is a
     * DIFFERENT decoder from `RelayWSClient`'s relay-message decoder, which
     * deliberately keeps `ignoreUnknownKeys = false` as a protocol-safety
     * guard. Do not conflate the two.
     */
    private val responseJson = Json { ignoreUnknownKeys = true }

    /**
     * A hung announce would stall companion start indefinitely and leave the
     * host with no QR at all, so the call is bounded and falls back instead.
     * `newBuilder()` shares the caller's dispatcher and connection pool, so
     * this costs nothing beyond the timeout override.
     */
    private val timedClient: OkHttpClient =
        client.newBuilder().callTimeout(timeoutSeconds, TimeUnit.SECONDS).build()

    private val announceUrl: String = baseUrl.trimEnd('/') + "/api/companion/announce"

    /**
     * Announce this device and return its ticket + display code, or null on
     * ANY failure. Callers must treat null as "connect ticketless" — never as
     * an error worth surfacing or retrying here.
     *
     * @param supportsAttachPin Advertises that this device will render an
     *   incoming `attach.challenge` for a human to read off-screen (spec
     *   2026-08-19). Defaults false so the announce leg's other call sites and
     *   tests are unaffected; `RelayWSClient` computes the real value per the
     *   `AttachPinUi` capability rule and always passes it explicitly. Omitted
     *   from the wire body entirely when false — see [encodeBody] — so an
     *   older server sees byte-identical requests.
     * @param device Stable device identity + facts (naming spec 2026-08-24).
     *   Defaults to `null`, which omits the `device` key entirely — an old
     *   server ignores the absent key, and a client that failed to resolve
     *   one (storage unavailable, no explicit override) sends a
     *   byte-identical body to before this feature.
     */
    suspend fun announce(
        label: String?,
        supportsAttachPin: Boolean = false,
        device: AnnounceDevice? = null,
    ): AnnounceResult? =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url(announceUrl)
                    // SECURITY: the key rides one HTTPS header and is never logged.
                    .header("Authorization", "Bearer $sdkKey")
                    .post(encodeBody(label, supportsAttachPin, device).toRequestBody(JSON_MEDIA_TYPE))
                    .build()
                timedClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    val text = response.body?.string() ?: return@use null
                    val wire = responseJson.decodeFromString(Wire.serializer(), text)
                    // Present-but-empty is not a usable answer. `{"ticket":"",
                    // "code":""}` decodes fine, and a blank ticket would compose
                    // the socket URL `/relay/tv/` — which the relay rejects as
                    // 4004, i.e. a terminal close instead of the clean ticketless
                    // fallback this contract promises. Fail closed here so the
                    // caller takes the fallback it is entitled to.
                    if (wire.ticket.isBlank() || wire.code.isBlank()) return@use null
                    // Same blank-guard as ticket/code, but not-fatal: an
                    // unusable `resolvedName` just falls back to the host's
                    // own default-name rendering, it never invalidates the
                    // whole announce.
                    val resolvedName = wire.resolvedName?.takeIf { it.isNotBlank() }
                    AnnounceResult(ticket = wire.ticket, code = wire.code, resolvedName = resolvedName)
                }
            }.getOrNull()
            // Offline, timeout, TLS failure, malformed JSON — one answer, and the
            // error is deliberately swallowed rather than logged.
        }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()

        /**
         * `{"label":"…","supportsAttachPin":true,"device":{…}}` with each key
         * omitted when absent/false/null — in particular `supportsAttachPin`
         * is omitted (not sent as `false`) and `device` is omitted entirely
         * when null, so a body from a device that cannot render the built-in
         * PIN dialog or failed to resolve an identity stays byte-identical to
         * every pre-2026-08-19 (respectively pre-2026-08-24) request an older
         * server has already seen.
         *
         * Built through kotlinx.serialization rather than string
         * interpolation: a device label containing `"` or `\` must not be
         * able to produce a body the server rejects as malformed (which would
         * silently cost this device its dashboard listing).
         */
        internal fun encodeBody(
            label: String?,
            supportsAttachPin: Boolean = false,
            device: AnnounceDevice? = null,
        ): String =
            buildJsonObject {
                if (label != null) put("label", label)
                if (supportsAttachPin) put("supportsAttachPin", true)
                if (device != null) {
                    putJsonObject("device") {
                        put("id", device.id)
                        put("platform", device.platform)
                        if (device.model != null) put("model", device.model)
                        if (device.osName != null) put("osName", device.osName)
                        if (device.osVersion != null) put("osVersion", device.osVersion)
                        // Non-optional on `AnnounceDevice` (mirrors iOS's
                        // `let emulator: Bool`) — always sent, true or false,
                        // never omitted like the nullable fact fields above.
                        put("emulator", device.emulator)
                    }
                }
            }.toString()
    }
}
