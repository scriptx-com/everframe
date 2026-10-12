// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.stallproof

import android.app.Activity
import android.os.Bundle
import android.os.Debug
import android.os.Process
import android.os.SystemClock
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

/** Credential-free consumer of the actual published Release AAR. */
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "Recovered main-thread delay qualification" })
        val mode = intent.getStringExtra("mode") ?: "observe"
        val marker = intent.getStringExtra("marker") ?: "default"
        val enabled = intent.getBooleanExtra("enabled", true)
        require(Regex("[A-Za-z0-9_-]{1,80}").matches(marker))
        Everframe.start(applicationContext, EverframeConfig(appId = "stall-proof-app", sdkKey = "stall-proof-key",
            capture = CaptureConfig(crash = true, logs = false, network = false), installIdentifierEnabled = false,
            vitals = VitalsConfig(enabled = false), shakeToReportEnabled = false), this)
        if (enabled) Everframe.setRecoveredStallObserverEnabled(true)
        scope.launch {
            val root = File(filesDir, "proof")
            try {
                if (enabled) withTimeout(20_000) { while (!Everframe.isRecoveredStallObserverReady()) delay(50) }
                delay(2_500) // leave a healthy sampling interval before the controlled workload
                if (mode == "disabled") Everframe.setRecoveredStallObserverEnabled(false)
                if (mode == "background" || mode == "measure-background") { moveTaskToBack(true); delay(2_000) }
                withContext(Dispatchers.IO) {
                    root.mkdirs()
                    File(root, "$marker.armed.json").writeText(JSONObject().put("ready", Everframe.isRecoveredStallObserverReady())
                        .put("pid", Process.myPid()).put("mode", mode).toString())
                }
                val cpu = Process.getElapsedCpuTime()
                val elapsed = SystemClock.elapsedRealtime()
                val pss = Debug.getPss()
                val disk = withContext(Dispatchers.IO) { privateBytes() }
                if (mode.startsWith("measure")) delay(30_000)
                else if (mode in listOf("observe", "disabled", "background", "terminate")) {
                    Thread.sleep(if (mode == "terminate") 120_000 else 6_500)
                    delay(2_500) // acknowledge and let the worker perform durable admission
                }
                val measurement = JSONObject().put("cpuMs", Process.getElapsedCpuTime() - cpu)
                    .put("elapsedMs", SystemClock.elapsedRealtime() - elapsed).put("pssBeforeKb", pss).put("pssAfterKb", Debug.getPss())
                withContext(Dispatchers.IO) {
                    measurement.put("diskBeforeBytes", disk).put("diskAfterBytes", privateBytes())
                    val outbox = JSONLOutbox(applicationContext)
                    val reports = JSONArray()
                    for (entry in outbox.hydrate()) {
                        File(root, "${entry.reportId}.json").writeBytes(entry.envelopeBytes)
                        reports.put(JSONObject().put("reportId", entry.reportId).put("sdkKey", entry.sdkKey)
                            .put("endpoint", entry.endpoint).put("sha256", sha(entry.envelopeBytes)))
                    }
                    val attempts = JSONArray()
                    if (mode.startsWith("drain")) {
                        val status = if (mode == "drain503") 503 else 200
                        val client = OkHttpClient.Builder().addInterceptor { chain ->
                            val request = chain.request()
                            check(request.url.host == "everframe.dev")
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
                            uploader.upload(entry.endpoint, entry.sdkKey, entry.idempotencyKey, entry.envelopeBytes, emptyList()).statusCode in 200..299
                        }
                        client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
                    }
                    File(root, "$marker.json").writeText(JSONObject().put("mode", mode).put("enabled", enabled)
                        .put("pid", Process.myPid()).put("ready", Everframe.isRecoveredStallObserverReady())
                        .put("reports", reports).put("attempts", attempts).put("queueAfter", outbox.count())
                        .put("measurement", measurement).toString())
                }
            } catch (failure: Throwable) {
                withContext(Dispatchers.IO) { root.mkdirs(); File(root, "$marker.failure.txt").writeText(failure.stackTraceToString()) }
            }
        }
    }
    private fun privateBytes() = listOf(filesDir, noBackupFilesDir).sumOf { root ->
        root.walkTopDown().filter { it.isFile && !it.path.contains("/proof/") }.sumOf { it.length() }
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
