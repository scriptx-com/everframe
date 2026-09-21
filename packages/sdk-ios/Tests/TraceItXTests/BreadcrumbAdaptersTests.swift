// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 7 — console/network/lifecycle/error breadcrumb adapters. Mirrors the
// web bridge's binding mappings (packages/sdk-react/src/capture/logs.ts:133,
// network.ts:19+26-28). Shared-singleton cases follow
// BreadcrumbRingBufferTests's reset/start/kill discipline (`.serialized`
// suite; explicit `resetBreadcrumbState()` before/after every case that
// touches `BreadcrumbRingBuffer.shared` / `TraceItX.shared`).
//
// Cross-suite pollution note: `BreadcrumbRingBuffer.shared` is process-wide,
// and `StderrIntercept` (installed by ANY test's `TraceItX.start(config:)` —
// or directly by `LogRingBufferTests`) dual-writes every captured stderr
// line, including the swift-testing runner's OWN "✔ Test ... passed"
// diagnostics, as `.console` crumbs. Swift Testing runs different suites
// concurrently by default, so this file cannot assume it has exclusive
// ownership of the shared buffer's exact contents even with `.serialized`
// (which only serializes tests WITHIN this suite) and even after disabling
// `capture.logs` on every `start()` call here (see `noLogCaptureConfig()`) —
// another suite's `LogCapture.install()`/`StderrIntercept.install()` call
// can still race in. Every assertion below therefore uses a unique marker
// message per test and filters the frozen chain for it, rather than
// asserting exact counts / `frozen[0]` — the same hardening applied to
// `BreadcrumbRingBufferTests.swift`'s `noLogCaptureConfig()` helper reduces
// but does not eliminate the residual cross-suite race.
import Testing
import Foundation
import TraceItXProtocol
#if canImport(UIKit)
import UIKit
#endif
@testable import TraceItXKit

/// Test-only sentinel "previously installed" exception handler. Must be a
/// top-level (non-capturing) function — same `@convention(c)` constraint the
/// production `traceItXUncaughtExceptionHandler` documents — so it can be
/// registered via `NSSetUncaughtExceptionHandler` directly.
nonisolated(unsafe) var __sentinelHandlerFired = false
func __sentinelUncaughtExceptionHandler(_ exception: NSException) {
    __sentinelHandlerFired = true
}

/// A second, distinct sentinel — used only in `errorAdapter_installIsIdempotent`
/// to prove a second `install()` call does NOT re-capture it as "previous"
/// (never actually invoked as a real handler in that test).
nonisolated(unsafe) var __sentinel2HandlerFired = false
func __sentinelUncaughtExceptionHandler2(_ exception: NSException) {
    __sentinel2HandlerFired = true
}

@MainActor
@Suite(.serialized)
struct BreadcrumbAdaptersTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    /// Serialized via `BreadcrumbSharedStateTestLock` against
    /// `BreadcrumbRingBufferTests`'s own reset helper, which runs in a
    /// concurrently-scheduled `@Suite` and would otherwise race this
    /// `applyConfig(nil)` (re-enables ALL kinds) into the disabled-kind
    /// tests' mutate -> act -> assert window below — see the lock's doc
    /// comment.
    private func resetBreadcrumbState() {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
    }

    /// See the file-level doc comment. Disables `capture.logs` so THIS
    /// suite's own `start()` calls never (re)install `StderrIntercept`;
    /// does not, by itself, fully close the cross-suite race.
    private func noLogCaptureConfig() -> TraceItXConfig {
        TraceItXConfig(appId: testAppId, capture: CaptureConfig(logs: false))
    }

    /// Freeze + take, returning only crumbs matching `message` — the robust
    /// alternative to asserting exact counts on the shared singleton.
    private func matchingCrumb(message: String) -> Breadcrumb? {
        BreadcrumbRingBuffer.shared.freeze()
        return BreadcrumbRingBuffer.shared.takeFrozen()?.first { $0.message == message }
    }

    /// Freeze + take, returning crumbs of the given `kind` — used by the
    /// disabled-kind no-op tests, which must tolerate unrelated crumbs of
    /// OTHER kinds landing during the same window.
    private func crumbs(kind: BreadcrumbKind) -> [Breadcrumb] {
        BreadcrumbRingBuffer.shared.freeze()
        return (BreadcrumbRingBuffer.shared.takeFrozen() ?? []).filter { $0.kind == kind }
    }

    // MARK: - Console: level mapping (pure)

    @Test func consoleMapLevel_defaultAndLogMapToInfo() {
        #expect(ConsoleBreadcrumbAdapter.mapLevel("default") == .info)
        #expect(ConsoleBreadcrumbAdapter.mapLevel("log") == .info)
    }

    @Test func consoleMapLevel_passesThroughInfoWarnError() {
        #expect(ConsoleBreadcrumbAdapter.mapLevel("info") == .info)
        #expect(ConsoleBreadcrumbAdapter.mapLevel("warn") == .warn)
        #expect(ConsoleBreadcrumbAdapter.mapLevel("error") == .error)
    }

    @Test func consoleMapLevel_faultMapsToError() {
        #expect(ConsoleBreadcrumbAdapter.mapLevel("fault") == .error)
    }

    @Test func consoleMapLevel_unknownFallsBackToInfo() {
        #expect(ConsoleBreadcrumbAdapter.mapLevel("totally-unknown") == .info)
    }

    // MARK: - Console: dual-write lands exactly one crumb per append

    @Test func consoleDualWrite_landsOneCrumbWithMappedLevel() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        let marker = "hello console \(UUID().uuidString)"
        ConsoleBreadcrumbAdapter.dualWrite(rawLevel: "warn", redactedMessage: marker)
        let crumb = matchingCrumb(message: marker)
        #expect(crumb?.kind == .console)
        #expect(crumb?.level == .warn)
        resetBreadcrumbState()
    }

    @Test func consoleDualWrite_doesNotDoubleRedactAnAlreadyRedactedMessage() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        // A message that already carries the redaction sentinel should pass
        // through unchanged (idempotent redaction, not doubled markup). The
        // token embeds a UUID so it can't collide with unrelated stderr noise.
        let marker = "token-\(UUID().uuidString) [REDACTED:jwt]"
        ConsoleBreadcrumbAdapter.dualWrite(rawLevel: "default", redactedMessage: marker)
        let crumb = matchingCrumb(message: marker)
        #expect(crumb?.message == marker)
        resetBreadcrumbState()
    }

    // NOTE on the "real StderrIntercept append path" alternative the brief
    // offers: deliberately NOT exercised here. `StderrIntercept` dup2's
    // STDERR_FILENO for the WHOLE TEST PROCESS, and `TraceItX.start(config:)`
    // reinstalls it asynchronously (an un-awaited `Task`, gated on
    // `config.capture.logs`, default true) on every `start()` call across
    // EVERY test in the suite — including ones that never intend to touch
    // logging. An earlier version of this test wrote a marker line to
    // `FileHandle.standardError` and polled (`AsyncTestHelpers.waitFor`,
    // up to 1s) for it to land as a crumb; the poll window gave concurrently
    // scheduled `LogCapture.install()` Tasks from OTHER tests' `start()`
    // calls room to flip the global intercept back on well after this test
    // returned and called `LogCapture.uninstall()`, which then vacuumed the
    // swift-testing runner's own "✔ Test ... passed" stderr chatter into
    // `BreadcrumbRingBuffer.shared` and broke unrelated, later tests
    // (observed directly, alongside the narrower cross-suite race the
    // file-level comment above documents). `ConsoleBreadcrumbAdapter.dualWrite`
    // is a pure, synchronous call taking the already-redacted message as an
    // argument — the direct-helper tests above exercise the exact same
    // mapping + `BreadcrumbRingBuffer.add` code path StderrIntercept calls,
    // without the process-wide fd-redirection race. Manual checklist item:
    // build the SDK into the example iOS app, call `txLogger.log(...)`, and
    // confirm a `.console` breadcrumb appears in the emitted envelope.

    // MARK: - Network: pure mapping helper

    @Test func networkMap_status2xxIsInfo() {
        let m = NetworkBreadcrumbAdapter.map(
            method: "GET", url: "https://example.com/x", status: 200, durationMs: 12.5)
        #expect(m.message == "GET https://example.com/x 200")
        #expect(m.level == .info)
        #expect(m.data["method"]?.value as? String == "GET")
        #expect(m.data["url"]?.value as? String == "https://example.com/x")
    }

    @Test func networkMap_status4xxIsWarn() {
        let m = NetworkBreadcrumbAdapter.map(
            method: "GET", url: "https://example.com/x", status: 404, durationMs: 5)
        #expect(m.message == "GET https://example.com/x 404")
        #expect(m.level == .warn)
    }

    @Test func networkMap_status5xxIsError() {
        let m = NetworkBreadcrumbAdapter.map(
            method: "POST", url: "https://example.com/x", status: 500, durationMs: 5)
        #expect(m.message == "POST https://example.com/x 500")
        #expect(m.level == .error)
    }

    @Test func networkMap_nilStatusIsFailedAndError() {
        let m = NetworkBreadcrumbAdapter.map(
            method: "POST", url: "https://example.com/x", status: nil, durationMs: nil)
        #expect(m.message == "POST https://example.com/x failed")
        #expect(m.level == .error)
        #expect(m.data["status"]?.value is JSONNull)
        #expect(m.data["durationMs"]?.value is JSONNull)
    }

    // MARK: - Network: dual-write from a synthesized capture row

    @Test func networkDualWrite_landsOneCrumbWithExpectedFields() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        let url = "https://example.com/y-\(UUID().uuidString)"
        let entry = NetworkLogEntry(
            timestamp: Date(), method: "GET", url: url,
            status: 404, durationMs: 42, requestHeaders: [:], responseHeaders: [:])
        NetworkBreadcrumbAdapter.dualWrite(entry: entry)
        let crumb = matchingCrumb(message: "GET \(url) 404")
        #expect(crumb?.kind == .network)
        #expect(crumb?.level == .warn)
        #expect(crumb?.data?["status"] != nil)
        resetBreadcrumbState()
    }

    @Test func networkDualWrite_failedRequestNilStatus() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        let url = "https://example.com/z-\(UUID().uuidString)"
        let entry = NetworkLogEntry(
            timestamp: Date(), method: "GET", url: url,
            status: nil, durationMs: nil, requestHeaders: [:], responseHeaders: [:])
        NetworkBreadcrumbAdapter.dualWrite(entry: entry)
        let crumb = matchingCrumb(message: "GET \(url) failed")
        #expect(crumb?.kind == .network)
        #expect(crumb?.level == .error)
        resetBreadcrumbState()
    }

    // MARK: - Lifecycle: NotificationCenter observer

    #if canImport(UIKit)
    @Test func lifecycleObserver_firesOnDidEnterBackground() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        LifecycleBreadcrumbObserver.shared.__uninstallForTesting()
        LifecycleBreadcrumbObserver.shared.install()
        BreadcrumbRingBuffer.shared.clear()
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        let matches = crumbs(kind: .lifecycle).filter { $0.message == "background" }
        #expect(matches.count >= 1)
        #expect(matches.first?.data?["state"]?.value as? String == "background")
        resetBreadcrumbState()
    }

    @Test func lifecycleObserver_firesOnWillEnterForeground() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        LifecycleBreadcrumbObserver.shared.__uninstallForTesting()
        LifecycleBreadcrumbObserver.shared.install()
        BreadcrumbRingBuffer.shared.clear()
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        let matches = crumbs(kind: .lifecycle).filter { $0.message == "foreground" }
        #expect(matches.count >= 1)
        #expect(matches.first?.data?["state"]?.value as? String == "foreground")
        resetBreadcrumbState()
    }

    @Test func lifecycleObserver_installIsIdempotent() {
        LifecycleBreadcrumbObserver.shared.__uninstallForTesting()
        LifecycleBreadcrumbObserver.shared.install()
        LifecycleBreadcrumbObserver.shared.install()
        #expect(LifecycleBreadcrumbObserver.shared.installedForTesting == true)
        LifecycleBreadcrumbObserver.shared.__uninstallForTesting()
        #expect(LifecycleBreadcrumbObserver.shared.installedForTesting == false)
    }
    #endif

    // MARK: - Error: uncaught-exception handler chains + lands a crumb

    @Test func errorHandler_chainsToPreviousHandlerAndLandsCrumb() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())

        __sentinelHandlerFired = false
        NSSetUncaughtExceptionHandler(__sentinelUncaughtExceptionHandler)
        ErrorBreadcrumbAdapter.__resetForTesting()
        ErrorBreadcrumbAdapter.install()
        #expect(ErrorBreadcrumbAdapter.previousHandler != nil)

        let reason = "boom-\(UUID().uuidString)"
        let exception = NSException(
            name: NSExceptionName("TestException"), reason: reason, userInfo: nil)
        traceItXUncaughtExceptionHandler(exception)

        #expect(__sentinelHandlerFired == true)
        let crumb = matchingCrumb(message: reason)
        #expect(crumb?.kind == .error)
        #expect(crumb?.level == .error)
        #expect(crumb?.data?["name"]?.value as? String == "TestException")
        // A directly-constructed (never `raise()`d) NSException carries an
        // empty `callStackSymbols` — this only asserts the key round-trips
        // as a String (possibly empty), not that it's non-empty.
        #expect(crumb?.data?["stackDigest"]?.value is String)

        NSSetUncaughtExceptionHandler(nil)
        ErrorBreadcrumbAdapter.__resetForTesting()
        resetBreadcrumbState()
    }

    @Test func errorHandler_fallsBackToExceptionNameWhenReasonIsNil() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        ErrorBreadcrumbAdapter.__resetForTesting()
        let name = "NoReasonException-\(UUID().uuidString)"
        let exception = NSException(name: NSExceptionName(name), reason: nil, userInfo: nil)
        ErrorBreadcrumbAdapter.handle(exception)
        let crumb = matchingCrumb(message: name)
        #expect(crumb?.kind == .error)
        resetBreadcrumbState()
    }

    @Test func errorAdapter_installIsIdempotent() {
        ErrorBreadcrumbAdapter.__resetForTesting()
        __sentinelHandlerFired = false
        __sentinel2HandlerFired = false
        NSSetUncaughtExceptionHandler(__sentinelUncaughtExceptionHandler)
        ErrorBreadcrumbAdapter.install()
        #expect(ErrorBreadcrumbAdapter.previousHandler != nil)

        // Simulate a second start() call after some other code re-pointed
        // the global handler — install() must remain a no-op (already
        // `installed`), so it must NOT re-capture the new global handler as
        // "previous" (that would silently drop the FIRST previous handler
        // from the chain).
        NSSetUncaughtExceptionHandler(__sentinelUncaughtExceptionHandler2)
        ErrorBreadcrumbAdapter.install()

        // Invoke whatever `previousHandler` now points to: if the second
        // install() had wrongly re-chained onto sentinel2, sentinel2 (not
        // sentinel1) would fire.
        let exception = NSException(name: NSExceptionName("x"), reason: nil, userInfo: nil)
        ErrorBreadcrumbAdapter.previousHandler?(exception)
        #expect(__sentinelHandlerFired == true)
        #expect(__sentinel2HandlerFired == false)

        NSSetUncaughtExceptionHandler(nil)
        ErrorBreadcrumbAdapter.__resetForTesting()
    }

    // MARK: - Disabled-kind no-op

    @Test func consoleDualWrite_isNoOpWhenKindDisabled() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        // This test asserts a KIND is absent (not a unique message), so a
        // concurrently-scheduled `BreadcrumbRingBufferTests` suite's
        // `applyConfig(nil)` reset landing mid-window would re-enable
        // `.console` and flip this assertion — hold
        // `BreadcrumbSharedStateTestLock` across the whole mutate -> act ->
        // assert section (see the lock's doc comment). Scoped in a `do`
        // block so `defer` unlocks BEFORE the trailing `resetBreadcrumbState()`
        // call below, which acquires the same (non-reentrant) lock itself.
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            BreadcrumbRingBuffer.shared.applyConfig(
                BreadcrumbsConfigWire(
                    enabled: true, kinds: ["network"], maxCount: 10, byteBudget: 16384,
                    consoleEntryCap: 1024))
            let marker = "should-not-land-\(UUID().uuidString)"
            ConsoleBreadcrumbAdapter.dualWrite(rawLevel: "default", redactedMessage: marker)
            // Console is entirely excluded from the live config's `kinds`, so
            // NO .console crumb can land — including from unrelated stderr
            // noise racing in from another suite (see file-level doc comment):
            // the same kind gate blocks both.
            #expect(crumbs(kind: .console).isEmpty)
        }
        resetBreadcrumbState()
    }

    @Test func networkDualWrite_isNoOpWhenKindDisabled() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        // See `consoleDualWrite_isNoOpWhenKindDisabled` above: this test also
        // asserts a KIND is absent, so it needs the same cross-suite
        // serialization around its mutate -> act -> assert section.
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            BreadcrumbRingBuffer.shared.applyConfig(
                BreadcrumbsConfigWire(
                    enabled: true, kinds: ["console"], maxCount: 10, byteBudget: 16384,
                    consoleEntryCap: 1024))
            let url = "https://example.com/noop-\(UUID().uuidString)"
            let entry = NetworkLogEntry(
                timestamp: Date(), method: "GET", url: url,
                status: 200, durationMs: 1, requestHeaders: [:], responseHeaders: [:])
            NetworkBreadcrumbAdapter.dualWrite(entry: entry)
            // Network is excluded from `kinds` here (only console is enabled) —
            // assert on `.network` specifically rather than total buffer size,
            // since a concurrently-racing `.console` crumb from another suite's
            // StderrIntercept window would be a legitimate, unrelated add under
            // this exact config (console IS enabled) and must not fail this test.
            #expect(crumbs(kind: .network).isEmpty)
        }
        resetBreadcrumbState()
    }
}
