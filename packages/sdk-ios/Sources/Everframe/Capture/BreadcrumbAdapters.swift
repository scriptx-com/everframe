// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 7 — converts platform events into `.console` / `.network` /
// `.lifecycle` / `.error` breadcrumbs. Mirrors the web bridge's binding
// mappings EXACTLY (Plan 2 Task 4 — source of truth):
//   - console: packages/sdk-react/src/capture/logs.ts:133
//     `crumb({ kind: 'console', level: CRUMB_LEVEL[l], message })`.
//   - network: packages/sdk-react/src/capture/network.ts:19 (shape) and
//     :26-28 (`statusLevel`: status===0 -> error, >=500 -> error,
//     >=400 -> warn, else info). iOS has no HTTP status when the completion
//     has no HTTPURLResponse (network failure/abort) — that `nil` is the iOS
//     analogue of web's `status === 0`.
//
// Console/network are PASSIVE dual-writes: `ConsoleBreadcrumbAdapter` and
// `NetworkBreadcrumbAdapter` are called directly from the existing capture
// call sites (StderrIntercept.swift, NetworkCaptureProtocol.swift) — nothing
// here needs an "install" step for those two kinds.
//
// Lifecycle + error ARE installed (once) from `Everframe.start(config:)`,
// after the kill-gate is set. All four adapters rely on
// `BreadcrumbRingBuffer.shared.add` for their actual gating (kill-switch +
// live per-kind config, Task 1/5) — the `isKindEnabled` pre-checks below are
// a hot-path optimization only (skip building the crumb when the kind is
// off), never the source of correctness.
//
// Never crash the host: every adapter body only calls non-throwing APIs
// (String formatting, `BreadcrumbRingBuffer.add`, `NotificationCenter`); the
// exception handler additionally never lets a chained-handler exception
// propagate back out unexpectedly since `handle` is a plain sequential call.
import Foundation
import EverframeProtocol
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Console (kind: .console)

enum ConsoleBreadcrumbAdapter {
    /// Maps a `LogEntry.level` string (StderrIntercept/os.Logger vocabulary:
    /// "debug" | "default" | "log" | "info" | "warn" | "error" | "fault") to
    /// the protocol `EverframeLevel`. "debug" -> `.debug` (mirrors sdk-react's
    /// `CRUMB_LEVEL` mapping). "default"/"log" -> `.info` (mirrors
    /// sdk-react's `CRUMB_LEVEL` default-console-method mapping); "fault" (an
    /// os.Logger-only severity with no web analogue) also maps to `.error`
    /// since it is strictly more severe than "error". Unrecognized strings
    /// fall back to `.info` rather than being dropped — a crumb with a
    /// slightly-wrong level is far better than a silently-lost console line.
    ///
    /// Console-level fidelity is platform-inherent: iOS stderr-sourced
    /// console crumbs are always `.info` (stderr carries no level); Android
    /// Timber-sourced crumbs carry real priorities (VERBOSE..ASSERT). This
    /// function only ever sees the StderrIntercept vocabulary above, so the
    /// richer per-priority mapping lives on the Android twin
    /// (`BreadcrumbAdapters.kt`'s `ConsoleBreadcrumbAdapter.mapLevel`), not
    /// here.
    static func mapLevel(_ raw: String) -> EverframeLevel {
        switch raw {
        case "debug": return .debug
        case "warn": return .warn
        case "error", "fault": return .error
        case "info": return .info
        default: return .info  // "default" | "log" | anything else
        }
    }

    /// Dual-write call site — StderrIntercept calls this immediately after
    /// `LogRingBuffer.shared.append(...)`, passing the SAME already-redacted
    /// message. Never re-invokes `RedactionEngine` here (buffer-level
    /// redaction in `BreadcrumbRingBuffer.add` is idempotent by design, but
    /// there is no reason to do the work twice on the hot console path).
    /// The `isKindEnabled` short-circuit avoids minting a crumb at all when
    /// console breadcrumbs are off; `add` itself would no-op anyway.
    static func dualWrite(rawLevel: String, redactedMessage: String) {
        guard BreadcrumbRingBuffer.shared.isKindEnabled(.console) else { return }
        BreadcrumbRingBuffer.shared.add(
            kind: .console, message: redactedMessage, level: mapLevel(rawLevel))
    }
}

// MARK: - Network (kind: .network)

enum NetworkBreadcrumbAdapter {
    struct Mapped {
        let message: String
        let level: EverframeLevel
        let data: [String: EverframeJSONAny]
    }

    /// Pure mapping helper — mirrors sdk-react network.ts's `statusLevel`
    /// (status===0 -> error; >=500 -> error; >=400 -> warn; else info). A
    /// `nil` status (no `HTTPURLResponse` — request failed/aborted before a
    /// response arrived) is iOS's analogue of web's `status === 0` and maps
    /// the same way. `url` is expected ALREADY redacted by the caller
    /// (`NetworkCaptureProtocol` redacts at capture time); this function
    /// does not redact again.
    static func map(method: String, url: String, status: Int?, durationMs: Double?) -> Mapped {
        let message: String
        let level: EverframeLevel
        if let status {
            message = "\(method) \(url) \(status)"
            level = status >= 500 ? .error : (status >= 400 ? .warn : .info)
        } else {
            message = "\(method) \(url) failed"
            level = .error
        }
        let data = BreadcrumbRingBuffer.coerceHostData([
            "method": method,
            "url": url,
            "status": jsonValue(status),
            "durationMs": jsonValue(durationMs),
        ])
        return Mapped(message: message, level: level, data: data)
    }

    /// Dual-write call site — `NetworkCaptureProtocol` calls this immediately
    /// after `NetworkRingBuffer.shared.append(entry)`, from the same
    /// already-built `NetworkLogEntry` (its `url` is already redacted).
    /// `reqId` (spec network-body-capture) is the id minted for a
    /// just-buffered body entry, correlating this crumb with its body row in
    /// `NetworkBodyRingBuffer`; `nil` (the default) when no body was
    /// captured for this request — the crumb's `data` then has no `reqId`
    /// key at all, matching pre-body-capture behavior exactly.
    static func dualWrite(entry: NetworkLogEntry, reqId: Int? = nil) {
        guard BreadcrumbRingBuffer.shared.isKindEnabled(.network) else { return }
        let mapped = map(
            method: entry.method, url: entry.url, status: entry.status, durationMs: entry.durationMs)
        var data = mapped.data
        if let reqId {
            data.merge(BreadcrumbRingBuffer.coerceHostData(["reqId": reqId])) { _, new in new }
        }
        BreadcrumbRingBuffer.shared.add(
            kind: .network, message: mapped.message, level: mapped.level, data: data)
    }

    /// `coerceHostData` takes `[String: Any]` and drops values that don't
    /// round-trip through `JSONSerialization` — an `Optional` wrapped
    /// directly in `Any` does NOT round-trip, so `nil` status/durationMs are
    /// represented as `NSNull()` (JSON `null`), matching how a host-supplied
    /// `nil` inside `addBreadcrumb(data:)` would be represented.
    private static func jsonValue<T>(_ value: T?) -> Any {
        value.map { $0 as Any } ?? NSNull()
    }
}

// MARK: - Lifecycle (kind: .lifecycle)

#if canImport(UIKit)
/// Bridges `UIApplication` background/foreground transitions into
/// `.lifecycle` crumbs. Pattern: RelayWSClient's `willResignActive` /
/// `didBecomeActive` observer pair
/// (Companion/RelayWSClient.swift:86-92) — a `NotificationCenter` observer
/// object with `@objc` selectors, `removeObserver` in `deinit`. A single
/// process-lifetime instance (`shared`) so install-once semantics hold
/// across repeated `Everframe.start()` calls (mirrors `LogCapture.install()`'s
/// idempotency).
final class LifecycleBreadcrumbObserver: NSObject {
    static let shared = LifecycleBreadcrumbObserver()

    private let lock = NSLock()
    private var installed = false

    /// Test-only flag.
    var installedForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    func install() {
        lock.lock(); defer { lock.unlock() }
        guard !installed else { return }
        installed = true
        NotificationCenter.default.addObserver(
            self, selector: #selector(onDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(onWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    /// Test-only reset seam — lets BreadcrumbAdaptersTests re-drive
    /// `install()` against a fresh subscription per test without leaking
    /// duplicate observers across the (serialized) test suite.
    func __uninstallForTesting() {
        lock.lock(); defer { lock.unlock() }
        guard installed else { return }
        installed = false
        NotificationCenter.default.removeObserver(self)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onDidEnterBackground() {
        BreadcrumbRingBuffer.shared.add(
            kind: .lifecycle, message: "background",
            data: BreadcrumbRingBuffer.coerceHostData(["state": "background"]))
    }

    @objc private func onWillEnterForeground() {
        BreadcrumbRingBuffer.shared.add(
            kind: .lifecycle, message: "foreground",
            data: BreadcrumbRingBuffer.coerceHostData(["state": "foreground"]))
    }
}
#endif

// MARK: - Error (kind: .error)

/// Top-level (NOT a method/closure) so it satisfies
/// `NSSetUncaughtExceptionHandler`'s `@convention(c)` function-pointer
/// requirement, which forbids captured context. It reads/writes only static
/// storage (`ErrorBreadcrumbAdapter`'s statics), which a non-capturing
/// top-level function may reference directly.
func everframeUncaughtExceptionHandler(_ exception: NSException) {
    ErrorBreadcrumbAdapter.handle(exception)
}

enum ErrorBreadcrumbAdapter {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed = false

    /// The handler registered before ours, captured at install time and
    /// CHAINED — called LAST, after our crumb has already landed — so any
    /// other exception handler (a crash reporter installed earlier) keeps
    /// receiving every exception exactly as before we existed.
    nonisolated(unsafe) private(set) static var previousHandler: NSUncaughtExceptionHandler?

    /// Install-once. Wired from `Everframe.start(config:)` after the
    /// kill-gate is set.
    static func install() {
        lock.lock(); defer { lock.unlock() }
        guard !installed else { return }
        installed = true
        previousHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler(everframeUncaughtExceptionHandler)
    }

    /// Test-only reset seam.
    static func __resetForTesting() {
        lock.lock(); defer { lock.unlock() }
        installed = false
        previousHandler = nil
    }

    /// Builds + adds the `.error` crumb, then chains to `previousHandler`
    /// LAST. Called both by `everframeUncaughtExceptionHandler` in production
    /// and directly by tests (there is no headless way to trigger a real
    /// `NSSetUncaughtExceptionHandler` invocation from a test runner — see
    /// BreadcrumbAdaptersTests). Never throws: every step here is a value
    /// construction or a call into `BreadcrumbRingBuffer.add`, which is
    /// itself non-throwing.
    static func handle(_ exception: NSException) {
        let stackDigest = exception.callStackSymbols.prefix(10).joined(separator: "\n")
        let data = BreadcrumbRingBuffer.coerceHostData([
            "name": exception.name.rawValue,
            "stackDigest": stackDigest,
        ])
        BreadcrumbRingBuffer.shared.add(
            kind: .error,
            message: exception.reason ?? exception.name.rawValue,
            level: .error,
            data: data)
        // SAFETY: `previousHandler` is intentionally read WITHOUT `lock`
        // here. It is write-once, at `install()` time, strictly before any
        // crash can reach this handler — so there is no real race on the
        // value itself. Taking `lock` during uncaught-exception unwinding
        // would risk deadlock (e.g. if the crash happened while some other
        // code on this thread already held `lock`), which is exactly the
        // one context where this code must never block.
        previousHandler?(exception)
    }
}

// MARK: - Install orchestrator

enum BreadcrumbAdapters {
    /// Wired from `Everframe.start(config:)` immediately after the kill-gate
    /// is set (`captureGate = true`). Install-once for both sub-adapters —
    /// safe across repeated `start()` calls. Console/network need no install
    /// call here: they are passive dual-writes firing from their existing
    /// capture call sites (`StderrIntercept.swift`,
    /// `NetworkCaptureProtocol.swift`) and are gated purely by
    /// `BreadcrumbRingBuffer`'s live per-kind config.
    static func install() {
        #if canImport(UIKit)
        LifecycleBreadcrumbObserver.shared.install()
        #endif
        ErrorBreadcrumbAdapter.install()
    }
}
