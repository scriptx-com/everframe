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
    private val appVersion: String,
) : EverframeNativeDriver {
    private companion object {
        // @everframe/web owns one page singleton. A new driver must retire its previous owner.
        var activeDriver: EverframeBrowserDriver? = null
    }

    private data class StartConfiguration(
        val appId: String,
        val sdkKey: String,
        val environment: String,
        val debugBuild: Boolean?,
        val releaseHealth: Boolean,
    )

    private var handle: dynamic = null
    private var startConfiguration: StartConfiguration? = null

    init {
        require(jsTypeOf(initWeb) == "function") { "KMP web requires @everframe/web init" }
        require(jsTypeOf(visualCapture?.captureScreenshot) == "function") {
            "KMP web requires a renderer-owned captureScreenshot provider"
        }
        require(sdkVersion.isNotBlank()) { "KMP SDK version is required" }
        require(appVersion.isNotBlank()) { "KMP web requires the host app version" }
    }

    override fun start(appId: String, sdkKey: String, environment: String, debugBuild: Boolean?, releaseHealth: Boolean): Boolean {
        // @everframe/web fixes its ingest endpoint when the browser bundle is built.
        // Never silently send a staging/development request to a production bundle.
        if (environment != "production") return false
        val requested = StartConfiguration(appId, sdkKey, environment, debugBuild, releaseHealth)
        if (handle != null && startConfiguration == requested) return true
        val config = js("({})")
        config.sdkKey = sdkKey
        config.appVersion = appVersion
        config.releaseHealth = js("({})")
        config.releaseHealth.enabled = releaseHealth
        config.sdkName = "everframe-kmp"
        config.sdkVersion = sdkVersion
        config.visualCapture = visualCapture
        // Left out, @everframe/web detects a debug build itself.
        if (debugBuild != null) config.debugBuild = debugBuild
        return try {
            activeDriver?.takeIf { it !== this }?.kill()
            kill()
            handle = initWeb(config)
            startConfiguration = requested
            activeDriver = this
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
        startConfiguration = null
        if (activeDriver === this) activeDriver = null
    }
}
