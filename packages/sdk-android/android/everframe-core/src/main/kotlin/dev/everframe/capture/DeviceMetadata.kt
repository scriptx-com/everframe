// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device metadata snapshot used by EnvelopeBuilder when assembling a feedback/
// crash envelope. Reads exclusively from non-permission-gated APIs (Build,
// Configuration, Locale, TimeZone, PackageManager.getPackageInfo).
//
// Mirrors `packages/sdk-ios/Sources/Everframe/Capture/DeviceMetadata.swift`.
// Output format is a Map<String, Any?> — EnvelopeBuilder maps these keys onto
// the protocol's `context.device` / `context.app` fields. A typed Kotlin
// data class would duplicate the Generated.kt schema; the Map keeps things
// schema-agnostic until the protocol stabilizes the device-context shape.
//
// Zero-permission rule (RESEARCH Finding 6 — capture pipeline + Pitfall 2):
//   • No ACCESS_NETWORK_STATE — that's host-app territory. We never declare it.
//   • No READ_PHONE_STATE — we use Build.MODEL/MANUFACTURER (always available).
//   • No GET_ACCOUNTS, no INTERNET (host already declared it).
// The Manifest is empty (Plan 01 — `<manifest />` only).

package dev.everframe.capture

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import dev.everframe.envelope.txGuard
import java.util.TimeZone

// Plan 05-06 cross-module entry — :reporter-ui's ReporterDialog reads
// device metadata at envelope build time.
object DeviceMetadata {

    /** Capture a snapshot of host device metadata. */
    fun collect(context: Context): Map<String, Any?> {
        val cfg = context.resources.configuration
        val pm = context.packageManager
        val (appVersion, appBuild) = readAppVersion(context, pm)

        val isTv = pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            (cfg.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION
        val isTablet = cfg.smallestScreenWidthDp >= 600

        return buildMap {
            put("os", "Android")
            put("osVersion", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("model", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
            put("brand", Build.BRAND)
            put("appVersion", appVersion)
            put("appBuild", appBuild)
            put("bundleIdentifier", context.packageName)
            put("locale", readLocaleTag(cfg))
            put("timezone", TimeZone.getDefault().id)
            put("screenWidthDp", cfg.screenWidthDp)
            put("screenHeightDp", cfg.screenHeightDp)
            put("smallestScreenWidthDp", cfg.smallestScreenWidthDp)
            put("isTv", isTv)
            put("isTablet", isTablet)
        }
    }

    private fun readAppVersion(
        context: Context,
        pm: PackageManager,
    ): Pair<String?, Long?> = txGuard("deviceMetadata.appVersion") {
        @Suppress("DEPRECATION")
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            pm.getPackageInfo(context.packageName, 0)
        }
        val build: Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION") info.versionCode.toLong()
        }
        info.versionName to build
    } ?: (null to null)

    private fun readLocaleTag(cfg: Configuration): String {
        val locales = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            cfg.locales
        } else {
            null
        }
        if (locales != null && !locales.isEmpty) {
            return locales.get(0).toLanguageTag()
        }
        @Suppress("DEPRECATION") val legacy = cfg.locale ?: java.util.Locale.getDefault()
        return legacy.toLanguageTag()
    }
}
