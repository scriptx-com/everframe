// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.flutter

import android.app.Activity
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.SensitiveRectRegistry
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.config.ReportResult
import dev.everframe.config.TXUser
import dev.everframe.crash.CrashReporter
import dev.everframe.quickcapture.QuickCaptureHostEvidence
import dev.everframe.ui.EFReporterFromImage
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.android.FlutterView
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/**
 * The masked Flutter evidence Dart sends with `openReporter` and returns for `quickCaptureEvidence`.
 * One decoder for both, so they cannot drift.
 */
private class FlutterMaskedEvidence(
    val maskedPng: ByteArray,
    val pixelRatio: Double?,
    val replayVTree: ByteArray?,
) {
    /**
     * The same checks and decode `EFReporterFromImage.open` applies to `maskedPng` before it builds the
     * reporter's capture: PNG signature and size bound, bounds-only decode, `image/png`, positive size,
     * longest edge at most 2048. Decodes off the main thread.
     */
    suspend fun screenshot(): ScreenshotCapture.CaptureResult? {
        if (maskedPng.size !in 8..10_000_000 ||
            !maskedPng.copyOf(8).contentEquals(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
        ) return null
        val bitmap = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(maskedPng, 0, maskedPng.size, bounds)
            if (bounds.outMimeType != "image/png" ||
                bounds.outWidth <= 0 || bounds.outHeight <= 0 ||
                maxOf(bounds.outWidth, bounds.outHeight) > 2048) null
            else BitmapFactory.decodeByteArray(maskedPng, 0, maskedPng.size)
        } ?: return null
        return ScreenshotCapture.CaptureResult(bitmap, bitmap.width, bitmap.height, maskedPng)
    }

    companion object {
        fun from(args: Any?): FlutterMaskedEvidence? {
            val map = args as? Map<*, *> ?: return null
            val maskedPng = map["maskedPng"] as? ByteArray ?: return null
            return FlutterMaskedEvidence(
                maskedPng,
                (map["pixelRatio"] as? Number)?.toDouble(),
                map["replayVTree"] as? ByteArray,
            )
        }
    }
}

/** Android bridge to the native Everframe reporter. */
class EverframeFlutterPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var appContext: Context
    private var activity: Activity? = null
    private lateinit var scope: CoroutineScope
    private var activeMarkers: List<View> = emptyList()
    /** Dart's `enableQuickCapture` registration. Survives `kill` so a later `start` reinstalls the provider. */
    private var quickCaptureHostEnabled = false

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "dev.everframe/flutter")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        if (quickCaptureHostEnabled) {
            quickCaptureHostEnabled = false
            Everframe.__setQuickCaptureEvidenceProvider(null)
        }
        clearMarkers()
        scope.cancel()
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onDetachedFromActivityForConfigChanges() { clearMarkers(); activity = null }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onDetachedFromActivity() { clearMarkers(); activity = null }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "start" -> {
                    val appId = call.argument<String>("appId")?.takeIf { it.isNotEmpty() }
                        ?: return result.error("invalid_arguments", "appId required", null)
                    val sdkKey = call.argument<String>("sdkKey")?.takeIf { it.isNotEmpty() }
                        ?: return result.error("invalid_arguments", "sdkKey required", null)
                    val environment = call.argument<String>("environment")
                        ?.let { Environment.entries.firstOrNull { entry -> entry.name == it } }
                        ?: return result.error("invalid_arguments", "environment invalid", null)
                    // Flutter pixels are captured only through the masked Dart boundary.
                    // Crash capture (JVM, native and ANR) also gates explicit handled Dart errors.
                    val crash = call.argument<Boolean>("crash") ?: true
                    Everframe.start(appContext, EverframeConfig(
                        appId = appId,
                        sdkKey = sdkKey,
                        environment = environment,
                        capture = CaptureConfig(screenshot = false, crash = crash),
                        releaseHealth = ReleaseHealthConfig(enabled = crash && call.argument<Boolean>("releaseHealth") != false),
                        debugBuild = call.argument<Boolean>("debugBuild"),
                        quickCaptureEnabled = call.argument<Boolean>("quickCapture") ?: true,
                    ), activity)
                    // `start` keeps no provider from an earlier session's `kill`.
                    if (quickCaptureHostEnabled) installQuickCaptureProvider()
                    result.success(null)
                }
                "openReporter" -> {
                    if (!Everframe.captureGate) {
                        result.error("not_started", "Everframe is not started", null)
                        return
                    }
                    val host = activity ?: return result.error("no_activity", "Reporter needs an Activity", null)
                    if (host !is ComponentActivity) {
                        return result.error("unsupported_host", "Reporter requires FlutterFragmentActivity", null)
                    }
                    if (activeMarkers.isNotEmpty()) {
                        return result.error("reporter_busy", "Reporter is already open", null)
                    }
                    val evidence = FlutterMaskedEvidence.from(call.arguments)
                        ?: return result.error("privacy_unverified", "Masked Flutter screenshot is unavailable", null)
                    val markers = installSensitiveMarkers(evidence.pixelRatio, call.argument<Any>("sensitiveRects"), host)
                        ?: return result.error("privacy_unverified", "Sensitive Flutter geometry is unavailable", null)
                    activeMarkers = markers
                    scope.launch {
                        try {
                            val outcome = EFReporterFromImage.open(host, evidence.maskedPng,
                                evidence.replayVTree, sdkName = "everframe-flutter")
                            result.success(when (outcome) {
                                is ReportResult.Submitted -> mapOf("status" to "submitted", "reportId" to outcome.reportId.toString())
                                is ReportResult.Queued -> mapOf("status" to "queued", "reportId" to outcome.reportId.toString())
                                is ReportResult.Cancelled -> mapOf("status" to "cancelled", "reason" to outcome.reason)
                            })
                        } catch (error: Throwable) {
                            result.error("reporter_failed", error.message, null)
                        } finally {
                            clearMarkers()
                        }
                    }
                }
                "setUser" -> {
                    val id = call.argument<String>("id")
                    val email = call.argument<String>("email")
                    val displayName = call.argument<String>("displayName")
                    Everframe.setUser(if (id == null && email == null && displayName == null) null else TXUser(id, email, displayName))
                    result.success(null)
                }
                "recordScreen" -> {
                    val name = call.argument<String>("name")
                        ?: return result.error("invalid_arguments", "name required", null)
                    Everframe.recordScreen(name)
                    result.success(null)
                }
                "addBreadcrumb" -> {
                    val message = call.argument<String>("message")
                        ?: return result.error("invalid_arguments", "message required", null)
                    @Suppress("UNCHECKED_CAST")
                    val data = call.argument<Map<String, Any?>>("data")
                    Everframe.addBreadcrumb(message, call.argument("kind"), call.argument("level"), data)
                    result.success(null)
                }
                "captureException" -> {
                    val type = call.argument<String>("exceptionType")?.takeIf { it.isNotBlank() }
                        ?: return result.error("invalid_arguments", "exceptionType required", null)
                    val message = call.argument<String>("message")
                        ?: return result.error("invalid_arguments", "message required", null)
                    val frames = call.argument<List<String>>("framesRaw")
                        ?: return result.error("invalid_arguments", "framesRaw required", null)
                    val accepted = CrashReporter.captureHandledFacts(
                        type.take(256), message.take(4096), frames.take(256).map { it.take(1024) },
                        java.time.Instant.now().toString(), jsBundle = null,
                        sdkName = "everframe-flutter")
                    if (accepted) Everframe.requestOutboxDrain()
                    result.success(accepted)
                }
                "setQuickCaptureHost" -> {
                    val enabled = call.argument<Boolean>("enabled")
                        ?: return result.error("invalid_arguments", "enabled required", null)
                    quickCaptureHostEnabled = enabled
                    if (enabled) installQuickCaptureProvider() else Everframe.__setQuickCaptureEvidenceProvider(null)
                    result.success(null)
                }
                "kill" -> {
                    clearMarkers()
                    Everframe.__setQuickCaptureEvidenceProvider(null)
                    Everframe.kill()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        } catch (error: Throwable) {
            result.error("native_failure", error.message, null)
        }
    }

    /**
     * Quick capture asks Dart for the masked Flutter frame instead of taking a native screenshot. The SDK
     * runs the provider off the main thread and bounds it; the channel call hops to the main thread. A null,
     * invalid or failed reply yields null, which fails the capture: the SDK never falls back to an unmasked
     * image.
     */
    private fun installQuickCaptureProvider() {
        val channel = channel
        Everframe.__setQuickCaptureEvidenceProvider {
            val reply = withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Any?> { continuation ->
                    channel.invokeMethod("quickCaptureEvidence", null, object : MethodChannel.Result {
                        override fun success(result: Any?) { if (continuation.isActive) continuation.resume(result) }
                        override fun error(code: String, message: String?, details: Any?) {
                            if (continuation.isActive) continuation.resume(null)
                        }
                        override fun notImplemented() { if (continuation.isActive) continuation.resume(null) }
                    })
                }
            }
            val evidence = FlutterMaskedEvidence.from(reply) ?: return@__setQuickCaptureEvidenceProvider null
            val screenshot = evidence.screenshot() ?: return@__setQuickCaptureEvidenceProvider null
            QuickCaptureHostEvidence(screenshot, evidence.replayVTree)
        }
    }

    private fun installSensitiveMarkers(pixelRatio: Double?, sensitiveRects: Any?, host: Activity): List<View>? {
        val ratio = pixelRatio ?: return null
        val nativeRatio = host.resources.displayMetrics.density.toDouble()
        if (!ratio.isFinite() || ratio <= 0 || abs(ratio - nativeRatio) > 0.02) return null
        val rects = sensitiveRects as? List<*> ?: return null
        val content = host.findViewById<FrameLayout>(android.R.id.content) ?: return null
        val flutterView = findFlutterView(content) ?: return null
        if (content.width <= 0 || content.height <= 0 || flutterView.width <= 0 || flutterView.height <= 0) return null
        val contentOrigin = IntArray(2).also(content::getLocationInWindow)
        val flutterOrigin = IntArray(2).also(flutterView::getLocationInWindow)
        val installed = mutableListOf<View>()
        for (item in rects) {
            val rect = item as? Map<*, *> ?: run { installed.forEach(content::removeView); return null }
            val left = (rect["left"] as? Number)?.toDouble() ?: run { installed.forEach(content::removeView); return null }
            val top = (rect["top"] as? Number)?.toDouble() ?: run { installed.forEach(content::removeView); return null }
            val right = (rect["right"] as? Number)?.toDouble() ?: run { installed.forEach(content::removeView); return null }
            val bottom = (rect["bottom"] as? Number)?.toDouble() ?: run { installed.forEach(content::removeView); return null }
            if (!left.isFinite() || !top.isFinite() || !right.isFinite() || !bottom.isFinite() ||
                left < 0 || top < 0 || right <= left || bottom <= top) {
                installed.forEach(content::removeView); return null
            }
            val x0 = floor(left * ratio).toInt() + flutterOrigin[0] - contentOrigin[0]
            val y0 = floor(top * ratio).toInt() + flutterOrigin[1] - contentOrigin[1]
            val x1 = ceil(right * ratio).toInt() + flutterOrigin[0] - contentOrigin[0]
            val y1 = ceil(bottom * ratio).toInt() + flutterOrigin[1] - contentOrigin[1]
            if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > content.width || y1 > content.height) {
                installed.forEach(content::removeView); return null
            }
            val marker = View(host).apply {
                setBackgroundColor(Color.TRANSPARENT)
                isClickable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            content.addView(marker, FrameLayout.LayoutParams(x1 - x0, y1 - y0).apply {
                leftMargin = x0
                topMargin = y0
            })
            marker.layout(x0, y0, x1, y1)
            Everframe.markSensitive(marker)
            if (!SensitiveRectRegistry.isSensitive(marker)) {
                content.removeView(marker)
                installed.forEach(content::removeView)
                return null
            }
            installed += marker
        }
        return installed
    }

    private fun findFlutterView(view: View): FlutterView? {
        if (view is FlutterView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findFlutterView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    private fun clearMarkers() {
        activeMarkers.forEach { (it.parent as? ViewGroup)?.removeView(it) }
        activeMarkers = emptyList()
    }
}
