// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

import kotlin.js.Promise

/**
 * Browser driver for the shared KMP API. [visualCapture] must supply a
 * renderer-owned, already-masked PNG and may supply an image replay provider.
 * The Web SDK refuses capture when that provider cannot return a safe frame.
 */
class EverframeBrowserDriver(
    private val initWeb: dynamic,
    private val visualCapture: dynamic,
    private val sdkVersion: String,
    private val appVersion: String = "0.0.0",
) : EverframeNativeDriver {
    private var handle: dynamic = null

    init {
        require(jsTypeOf(initWeb) == "function") { "KMP web requires @everframe/web init" }
        require(jsTypeOf(visualCapture?.captureScreenshot) == "function") {
            "KMP web requires a renderer-owned captureScreenshot provider"
        }
        require(sdkVersion.isNotBlank()) { "KMP SDK version is required" }
    }

    override fun start(appId: String, sdkKey: String, environment: String): Boolean {
        // @everframe/web fixes its ingest endpoint when the browser bundle is built.
        // Never silently send a staging/development request to a production bundle.
        if (environment != "production") return false
        if (handle != null) return true
        val config = js("({})")
        config.sdkKey = sdkKey
        config.appVersion = appVersion
        config.sdkName = "everframe-kmp"
        config.sdkVersion = sdkVersion
        config.visualCapture = visualCapture
        return try {
            handle = initWeb(config)
            true
        } catch (_: Throwable) {
            false
        }
    }

    override fun setUser(id: String?, email: String?, displayName: String?) {
        val user = js("({})")
        if (id != null) user.id = id
        if (email != null) user.email = email
        if (displayName != null) user.displayName = displayName
        handle.setUser(if (id == null && email == null && displayName == null) null else user)
    }

    override fun recordScreen(name: String) { handle.recordScreen(name) }

    override fun addBreadcrumb(message: String, kind: String?, level: String?) {
        val breadcrumb = js("({})")
        breadcrumb.message = message
        if (kind != null) breadcrumb.kind = kind
        if (level != null) breadcrumb.level = level
        handle.addBreadcrumb(breadcrumb)
    }

    override fun captureHandledError(code: String) {
        val message = code
        handle.captureException(js("new Error(message)"))
    }

    override fun captureException(error: Throwable) {
        val message = error.message ?: error::class.simpleName ?: "Kotlin error"
        val nativeError = error.asDynamic()
        handle.captureException(if (jsTypeOf(nativeError.stack) == "string")
            nativeError else js("new Error(message)"))
    }

    override fun openReporter(completion: (EverframeReportOutcome) -> Unit) {
        (handle.open() as Promise<dynamic>).then<Unit>({ result: dynamic ->
            val status = result.status as String
            val reportId = result.reportId as? String
            val reason = result.reason as? String
            completion(EverframeReportOutcome(status, reportId, reason))
        }, { error: dynamic ->
            completion(EverframeReportOutcome("failed", reason = error?.message as? String))
        })
    }

    override fun kill() {
        handle?.destroy()
        handle = null
    }
}
