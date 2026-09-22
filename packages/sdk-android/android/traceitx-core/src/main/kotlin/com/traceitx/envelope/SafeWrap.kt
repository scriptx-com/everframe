// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// txGuard{} — DEFE-02 foundation. All SDK entry points wrap their internal work
// in `txGuard("label") { ... }` so an unexpected throw is recorded internally
// rather than propagating into the host app. Three overloads:
//   • txGuard       — sync, returns T?
//   • txGuardSuspend — coroutine, returns T?
//   • txGuardVoid   — sync Unit; disambiguates Unit-returning closures
//
// Mirrors `packages/sdk-ios/Sources/TraceItX/Envelope/SafeWrap.swift`.
package com.traceitx.envelope

inline fun <T> txGuard(label: String = "unspecified", work: () -> T): T? =
    try {
        work()
    } catch (t: Throwable) {
        InternalLogger.recordSafeWrapFailure(label, t)
        null
    }

suspend inline fun <T> txGuardSuspend(label: String = "unspecified", crossinline work: suspend () -> T): T? =
    try {
        work()
    } catch (t: Throwable) {
        InternalLogger.recordSafeWrapFailure(label, t)
        null
    }

inline fun txGuardVoid(label: String = "unspecified", work: () -> Unit) {
    try {
        work()
    } catch (t: Throwable) {
        InternalLogger.recordSafeWrapFailure(label, t)
    }
}
