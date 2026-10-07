// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.nativeproof

import android.app.Activity
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.config.VitalsConfig
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.transport.MultipartUploader
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

object NativeFaults {
    init { System.loadLibrary("nativeproof") }
    external fun memoryFault(address: Long)
    external fun abortFault()
}

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "Native crash qualification" })
        val mode = intent.getStringExtra("mode") ?: "recover"
        val marker = intent.getStringExtra("marker") ?: "default"
        require(Regex("[A-Za-z0-9_-]{1,80}").matches(marker))
        val config = EverframeConfig(appId = "native-proof-app", sdkKey = intent.getStringExtra("key") ?: "native-proof-key",
            capture = CaptureConfig(crash = true, logs = false, network = false),
            installIdentifierEnabled = false, vitals = VitalsConfig(enabled = false), shakeToReportEnabled = false)
        Everframe.start(applicationContext, config, this)
        Everframe.setNativeCrashRecoveryEnabled(true)
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    withTimeout(20000) { while (!Everframe.isNativeCrashRecoveryReady()) delay(50) }
                    val root = File(filesDir, "proof").apply { mkdirs() }
                    val outbox = JSONLOutbox(applicationContext)
                    val before = outbox.hydrate()
                    val reports = JSONArray()
                    for (entry in before) {
                        File(root, "${entry.reportId}.json").writeBytes(entry.envelopeBytes)
                        reports.put(JSONObject().put("reportId", entry.reportId).put("sdkKey", entry.sdkKey)
                            .put("endpoint", entry.endpoint).put("sha256", sha(entry.envelopeBytes)))
                    }
                    val attempts = JSONArray()
                    if (mode.startsWith("drain")) {
                        val status = if (mode == "drain503") 503 else 200
                        val client = OkHttpClient.Builder().addInterceptor { chain ->
                            val request = chain.request()
                            check(request.url.host == "everframe.dev") // Release SDK destination remains compiled production.
                            val bytes = Buffer().also { request.body!!.writeTo(it) }.readByteArray()
                            File(root, "$marker-${attempts.length()}.multipart").writeBytes(bytes)
                            attempts.put(JSONObject().put("idempotency", request.header("X-Everframe-Idempotency-Key"))
                                .put("status", status).put("sha256", sha(bytes)))
                            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status)
                                .message("fixture").body("{}".toResponseBody()).build()
                        }.build()
                        val uploader = MultipartUploader(client)
                        outbox.drain { entry ->
                            check(entry.attachmentRefs.isEmpty() && entry.identitySubject == null)
                            val result = uploader.upload(entry.endpoint, entry.sdkKey, entry.idempotencyKey,
                                entry.envelopeBytes, emptyList())
                            result.statusCode in 200..299
                        }
                        client.dispatcher.executorService.shutdown()
                        client.connectionPool.evictAll()
                    }
                    val exits = JSONArray()
                    if (android.os.Build.VERSION.SDK_INT >= 31) {
                        val manager = getSystemService(ACTIVITY_SERVICE) as ActivityManager
                        for (exit in manager.getHistoricalProcessExitReasons(packageName, 0, 16)) {
                            exits.put(JSONObject().put("pid", exit.pid).put("reason", exit.reason).put("timestamp", exit.timestamp))
                            if (exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                                exit.traceInputStream?.use { input ->
                                    val output = java.io.ByteArrayOutputStream()
                                    val buffer = ByteArray(8192)
                                    while (true) {
                                        val count = input.read(buffer)
                                        if (count < 0) break
                                        check(count > 0 && output.size() + count <= 4 * 1024 * 1024)
                                        output.write(buffer, 0, count)
                                    }
                                    val data = output.toByteArray()
                                    File(root, "${exit.pid}-${exit.timestamp}.tombstone.pb").writeBytes(data)
                                }
                            }
                        }
                    }
                    if (mode == "disabled") {
                        Everframe.setNativeCrashRecoveryEnabled(false)
                        check(!Everframe.isNativeCrashRecoveryReady())
                    }
                    File(root, "$marker.json").writeText(JSONObject().put("mode", mode).put("ready", Everframe.isNativeCrashRecoveryReady())
                        .put("pid", android.os.Process.myPid()).put("reports", reports).put("attempts", attempts)
                        .put("queueAfter", outbox.count()).put("exits", exits).toString())
                }
                when (mode) {
                    "abort" -> NativeFaults.abortFault()
                    "segv", "disabled" -> NativeFaults.memoryFault(0)
                    "jvm" -> Handler(Looper.getMainLooper()).post { throw IllegalStateException("Native recovery JVM compatibility") }
                }
            } catch (failure: Throwable) {
                withContext(Dispatchers.IO) {
                    File(filesDir, "proof").mkdirs()
                    File(filesDir, "proof/$marker.failure.txt").writeText(failure.stackTraceToString())
                }
            }
        }
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
