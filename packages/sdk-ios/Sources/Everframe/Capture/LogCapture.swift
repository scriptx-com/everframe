// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public log-capture surface.
//
//   • `everframeLogger` — host-facing os.Logger; calling `everframeLogger.log(...)` emits to
//     unified logging AND, because os.Logger writes default-level messages to
//     stderr in DEBUG builds, also flows through StderrIntercept.
//
//   • `LogCapture.install()` / `LogCapture.uninstall()` — standalone install
//     surface. Wave-3 file-ownership invariant: this plan does NOT modify
//     `Everframe.swift`. Plan 04-06 owns the `start()` detached Task wiring
//     (gated on `config.capture.logs`) and the `kill()` uninstall wiring.
//
// Per RESEARCH Finding 5 W1 outcome — primary capture path is stderr
// intercept; OSLogStore is sim-only and is treated as a supplemental
// diagnostic only.
import Foundation
import os

/// Public logger emitted via os.Logger; subsystem `dev.everframe`.
/// Customer code that calls `everframeLogger.log(...)` automatically routes through
/// the stderr intercept once `LogCapture.install()` has run.
public let everframeLogger = Logger(subsystem: "dev.everframe", category: "captured")

public enum LogCapture {
    /// Install log capture (stderr intercept). Idempotent.
    /// Wired from Everframe.start()'s detached Task by plan 04-06
    /// (gated on `config.capture.logs`).
    public static func install() {
        StderrIntercept.install()
    }

    /// Uninstall log capture. Wired from Everframe.kill() by plan 04-06.
    /// Idempotent.
    public static func uninstall() {
        StderrIntercept.uninstall()
    }
}
