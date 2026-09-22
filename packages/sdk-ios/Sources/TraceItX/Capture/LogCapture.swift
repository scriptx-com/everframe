// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public log-capture surface.
//
//   • `txLogger` — host-facing os.Logger; calling `txLogger.log(...)` emits to
//     unified logging AND, because os.Logger writes default-level messages to
//     stderr in DEBUG builds, also flows through StderrIntercept.
//
//   • `LogCapture.install()` / `LogCapture.uninstall()` — standalone install
//     surface. Wave-3 file-ownership invariant: this plan does NOT modify
//     `TraceItX.swift`. Plan 04-06 owns the `start()` detached Task wiring
//     (gated on `config.capture.logs`) and the `kill()` uninstall wiring.
//
// Per RESEARCH Finding 5 W1 outcome — primary capture path is stderr
// intercept; OSLogStore is sim-only and is treated as a supplemental
// diagnostic only.
import Foundation
import os

/// Public logger emitted via os.Logger; subsystem `com.traceitx`.
/// Customer code that calls `txLogger.log(...)` automatically routes through
/// the stderr intercept once `LogCapture.install()` has run.
public let txLogger = Logger(subsystem: "com.traceitx", category: "captured")

public enum LogCapture {
    /// Install log capture (stderr intercept). Idempotent.
    /// Wired from TraceItX.start()'s detached Task by plan 04-06
    /// (gated on `config.capture.logs`).
    public static func install() {
        StderrIntercept.install()
    }

    /// Uninstall log capture. Wired from TraceItX.kill() by plan 04-06.
    /// Idempotent.
    public static func uninstall() {
        StderrIntercept.uninstall()
    }
}
