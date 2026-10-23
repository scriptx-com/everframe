// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device link hello and attempt check (wire contract: "Linking endpoints").
//
// Runs on `ReportSubmitter.buildIsolatedClient()`, which carries no
// `EverframeInterceptor`, so this traffic never becomes host network
// breadcrumbs. Bodies are never logged. Redirects are never followed: the
// nonce rides the POST body, which a 307/308 would re-send to the new origin.
// A call is cancelled with its coroutine, so the attempt loop can bound each
// check by what is left of the attempt's window.
//
// SECURITY: never log the nonce or a minted token.

package dev.everframe.devicelink

import android.content.Context
import dev.everframe.Everframe
import dev.everframe.capture.DeviceMetadata
import dev.everframe.transport.ReportSubmitter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resumeWithException

/** The `device` object of a hello. */
internal data class HelloDevice(
    val model: String,
    val os: String = "Android",
    val osVersion: String,
    val appVersion: String,
    val sdk: String,
    val formFactor: String,
) {
    companion object {
        fun collect(context: Context, debugBuild: Boolean?): HelloDevice {
            val meta = DeviceMetadata.collect(context, debugBuild)
            return HelloDevice(
                model = (meta["model"] as? String)?.takeIf { it.isNotBlank() } ?: "Android device",
                osVersion = (meta["osVersion"] as? String).orEmpty(),
                appVersion = (meta["appVersion"] as? String).orEmpty(),
                sdk = "android/${Everframe.SDK_VERSION}",
                formFactor = DeviceMetadata.formFactor(meta),
            )
        }
    }
}

internal sealed interface HelloResult {
    /** No teammate is listening on this app's project. */
    data object None : HelloResult

    /** Show the banner with [number] and check [attemptId]. */
    data class Pending(val attemptId: String, val number: Int) : HelloResult

    /** Rate limited, failed, or unreadable: do nothing more. */
    data object Stop : HelloResult
}

internal sealed interface CheckResult {
    data object Pending : CheckResult

    /** SECURITY: never log. [toString] redacts the token. */
    class Linked(val token: String, val owner: DeviceLinkOwner) : CheckResult {
        override fun toString(): String = "Linked(token=<redacted>, owner=$owner)"
    }

    /** The window closed, another candidate was picked, or the nonce was wrong. */
    data object Expired : CheckResult

    /** Rate limited: stop checking. */
    data object Stop : CheckResult

    /** A server or network failure: check again on the next tick. */
    data object Retry : CheckResult
}

/** The two link calls, as [DeviceLink] uses them. A seam so the attempt loop is testable without HTTP. */
internal interface DeviceLinkApi {
    suspend fun hello(nonce: String, device: HelloDevice): HelloResult
    suspend fun check(attemptId: String, nonce: String): CheckResult
}

internal class DeviceLinkClient(
    baseUrl: String,
    private val sdkKey: String,
    http: OkHttpClient = ReportSubmitter.buildIsolatedClient(),
) : DeviceLinkApi {
    private val client: OkHttpClient = http.newBuilder().followRedirects(false).followSslRedirects(false).build()

    private val base: HttpUrl? = run {
        val trimmed = baseUrl.trim().trimEnd('/')
        val root = if (trimmed.endsWith(INGEST_SUFFIX)) trimmed.removeSuffix(INGEST_SUFFIX) else trimmed
        root.toHttpUrlOrNull()
    }

    override suspend fun hello(nonce: String, device: HelloDevice): HelloResult = withContext(Dispatchers.IO) {
        val url = base?.newBuilder()?.addPathSegments("api/device-link/hello")?.build()
            ?: return@withContext HelloResult.Stop
        val body = buildJsonObject {
            put("attemptNonce", nonce)
            put(
                "device",
                buildJsonObject {
                    put("model", device.model)
                    put("os", device.os)
                    put("osVersion", device.osVersion)
                    put("appVersion", device.appVersion)
                    put("sdk", device.sdk)
                    put("formFactor", device.formFactor)
                },
            )
        }
        try {
            post(url, body).use { resp ->
                if (resp.code != 200) return@use HelloResult.Stop
                val obj = parseObject(resp.peekBody(MAX_BODY_BYTES).string()) ?: return@use HelloResult.Stop
                when (obj.string("status")) {
                    "none" -> HelloResult.None
                    "pending" -> {
                        val attemptId = obj.string("attemptId")?.takeIf(::isAttemptId)
                        val number = obj.matchNumber()
                        if (attemptId == null || number == null) HelloResult.Stop else HelloResult.Pending(attemptId, number)
                    }
                    else -> HelloResult.Stop
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            HelloResult.Stop
        }
    }

    override suspend fun check(attemptId: String, nonce: String): CheckResult = withContext(Dispatchers.IO) {
        val url = base?.newBuilder()
            ?.addPathSegments("api/device-link/attempts")
            ?.addPathSegment(attemptId)
            ?.addPathSegment("check")
            ?.build()
            ?: return@withContext CheckResult.Stop
        try {
            post(url, buildJsonObject { put("attemptNonce", nonce) }).use { resp ->
                when {
                    resp.code == 429 -> CheckResult.Stop
                    resp.code >= 500 -> CheckResult.Retry
                    resp.code != 200 -> CheckResult.Expired
                    else -> {
                        val obj = parseObject(resp.peekBody(MAX_BODY_BYTES).string()) ?: return@use CheckResult.Retry
                        when (obj.string("status")) {
                            "pending" -> CheckResult.Pending
                            "expired" -> CheckResult.Expired
                            "linked" -> linked(obj)
                            else -> CheckResult.Retry
                        }
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // IOException (network) or anything unexpected: try again on the next tick, bounded by the window.
            CheckResult.Retry
        }
    }

    /** A token that is not a valid `evf_dev_` token, or an owner this SDK can't name, counts as expired. */
    private fun linked(obj: JsonObject): CheckResult {
        val token = obj.string("token") // SECURITY: never log
        if (!DeviceLinkToken.isValid(token)) return CheckResult.Expired
        val owner = obj["owner"] as? JsonObject ?: return CheckResult.Expired
        val parsed = when (owner.string("kind")) {
            "user" -> DeviceLinkOwner.User(owner.string("name") ?: "")
            "team" -> DeviceLinkOwner.Team
            else -> return CheckResult.Expired
        }
        return CheckResult.Linked(token!!, parsed)
    }

    /** Cancelling the caller cancels the HTTP call, so a deadline ends a hung request at once. */
    private suspend fun post(url: HttpUrl, body: JsonObject): Response = suspendCancellableCoroutine { cont ->
        val call = client.newCall(
            Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody(JSON))
                .header("Authorization", "Bearer $sdkKey")
                .header("Accept", "application/json")
                .build(),
        )
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                cont.resume(response) { _ -> response.close() }
            }
        })
    }

    private fun parseObject(text: String): JsonObject? =
        runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonObject.matchNumber(): Int? =
        (this["number"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 0..99 }

    private companion object {
        const val INGEST_SUFFIX = "/api/ingest"
        const val MAX_BODY_BYTES = 4096L
        val JSON = "application/json; charset=utf-8".toMediaType()

        fun isAttemptId(raw: String): Boolean = raw.length in 1..64 && raw.all { it.code in 0x21..0x7E }
    }
}
