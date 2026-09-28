// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

/** Unreleased mobile integration contract. Native reporters remain owned by the host platform. */
class EverframeKmpConfig(
    val appId: String,
    val sdkKey: String,
    val environment: String = "development",
)

class EverframeReportOutcome(
    val status: String,
    val reportId: String? = null,
    val reason: String? = null,
) {
    init {
        require(status in setOf("submitted", "queued", "cancelled", "failed"))
        require(status !in setOf("submitted", "queued") || !reportId.isNullOrBlank())
    }
}

/** Swift hosts implement this protocol to call the existing Swift-only Everframe SDK. */
interface EverframeNativeDriver {
    fun start(appId: String, sdkKey: String): Boolean
    fun setUser(id: String?, email: String?, displayName: String?)
    fun recordScreen(name: String)
    fun addBreadcrumb(message: String, kind: String?, level: String?)
    fun openReporter(completion: (EverframeReportOutcome) -> Unit)
    fun kill()
}

class EverframeKmp(private val driver: EverframeNativeDriver) {
    private var started = false

    fun start(config: EverframeKmpConfig): Boolean {
        if (config.environment != "development" || config.appId.isBlank() || config.sdkKey.isBlank()) return false
        started = driver.start(config.appId, config.sdkKey)
        return started
    }

    fun setUser(id: String? = null, email: String? = null, displayName: String? = null) {
        check(started) { "Everframe is not started" }
        driver.setUser(id, email, displayName)
    }

    fun recordScreen(name: String) {
        check(started) { "Everframe is not started" }
        require(name.isNotBlank()) { "screen name is required" }
        driver.recordScreen(name)
    }

    fun addBreadcrumb(message: String, kind: String? = null, level: String? = null) {
        check(started) { "Everframe is not started" }
        require(message.isNotBlank()) { "breadcrumb message is required" }
        driver.addBreadcrumb(message, kind, level)
    }

    fun openReporter(completion: (EverframeReportOutcome) -> Unit) {
        check(started) { "Everframe is not started" }
        driver.openReporter(completion)
    }

    fun kill() {
        if (started) driver.kill()
        started = false
    }
}
