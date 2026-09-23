// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device-metadata → SessionSummaryDims mapping, extracted out of
// Everframe.start()'s heavyInit block so the platform/appVersion/fallback
// rules are unit-testable without booting the whole SDK.
package dev.everframe.vitals

import dev.everframe.vitals.wire.SessionSummaryDims

internal fun vitalsDimsFrom(device: Map<String, Any?>, sdkVersion: String): SessionSummaryDims =
    SessionSummaryDims(
        platform = if (device["isTv"] == true) "androidtv" else "android",
        appVersion = (device["appVersion"] as? String) ?: "0.0.0",
        sdkVersion = sdkVersion,
        deviceModel = device["model"] as? String,
        osVersion = device["osVersion"] as? String,
    )
