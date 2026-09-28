// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.flutter

import android.app.Activity
import android.content.Context
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import dev.everframe.config.TXUser
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Android half of the unreleased Flutter native reporter dry run. */
class EverframeFlutterPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var appContext: Context
    private var activity: Activity? = null
    private lateinit var scope: CoroutineScope

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "dev.everframe/flutter")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        scope.cancel()
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onDetachedFromActivityForConfigChanges() { activity = null }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onDetachedFromActivity() { activity = null }

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
                    if (environment != Environment.development) {
                        return result.error("dry_run_only", "development environment required", null)
                    }
                    // Native screenshots and automatic crash capture lack a Flutter privacy proof.
                    Everframe.start(appContext, EverframeConfig(
                        appId = appId,
                        sdkKey = sdkKey,
                        environment = environment,
                        capture = CaptureConfig(screenshot = false, crash = false),
                    ), activity)
                    result.success(null)
                }
                "openReporter" -> {
                    if (!Everframe.captureGate) {
                        result.error("not_started", "Everframe is not started", null)
                        return
                    }
                    scope.launch {
                        try {
                            val outcome = Everframe.report.open()
                            result.success(when (outcome) {
                                is ReportResult.Submitted -> mapOf("status" to "submitted", "reportId" to outcome.reportId.toString())
                                is ReportResult.Queued -> mapOf("status" to "queued", "reportId" to outcome.reportId.toString())
                                is ReportResult.Cancelled -> mapOf("status" to "cancelled", "reason" to outcome.reason)
                            })
                        } catch (error: Throwable) {
                            result.error("reporter_failed", error.message, null)
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
                    Everframe.addBreadcrumb(message, call.argument("kind"), call.argument("level"))
                    result.success(null)
                }
                "kill" -> { Everframe.kill(); result.success(null) }
                else -> result.notImplemented()
            }
        } catch (error: Throwable) {
            result.error("native_failure", error.message, null)
        }
    }
}
