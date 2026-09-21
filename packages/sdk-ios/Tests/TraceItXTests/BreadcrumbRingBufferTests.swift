// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BreadcrumbRingBuffer + TraceItX.addBreadcrumb + live config gating.
// Mirrors packages/sdk-core/__tests__/breadcrumb-buffer.spec.ts's matrix — same
// t/seq semantics, same redact-before-buffer / depth-cap / message-cap doctrine
// (MASK-BEFORE-BYTES), same freeze/discardAndResume/takeFrozen/clear lifecycle.
//
// Buffer-level cases use the gate-bypass init (honorsKillGate: false) so they
// don't race TraceItX.shared.captureGate across the suite (see
// LogRingBufferTests). Gate + addBreadcrumb cases drive the real shared
// singleton through TraceItX.shared start()/kill() and reset it before/after.
import Testing
import Foundation
import TraceItXProtocol
@testable import TraceItXKit

@MainActor
@Suite(.serialized)
struct BreadcrumbRingBufferTests {
    // 3-segment JWT-shaped string — same pattern id ("jwt") RedactionEngineTests
    // exercises; RedactionEngine's replacement is "[REDACTED:jwt]" (lowercased
    // pattern id, not the sdk-core TS fixture's "[REDACTED:JWT]").
    private let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    /// Task 7 note: `TraceItX.start(config:)` schedules `LogCapture.install()`
    /// on a detached `Task` whenever `config.capture.logs` is true (the
    /// default) — and once installed, `StderrIntercept` dual-writes every
    /// captured stderr line (including the swift-testing runner's own
    /// "✔ Test ... passed" diagnostics) into `BreadcrumbRingBuffer.shared`
    /// as `.console` crumbs. That race is asynchronous and can land many
    /// tests after the `start()` call that triggered it, polluting THIS
    /// suite's exact-count/exact-message assertions on the shared buffer.
    /// Every case here disables `capture.logs` to keep `StderrIntercept` off
    /// for the tests in this file, matching how `LogRingBufferTests`
    /// isolates its own capacity/eviction assertions onto non-shared
    /// instances instead of the process-wide singleton.
    private static func noLogCaptureConfig(appId: String) -> TraceItXConfig {
        TraceItXConfig(appId: appId, capture: CaptureConfig(logs: false))
    }

    private func jsonAnyDict(_ object: [String: Any]) -> [String: JSONAny] {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode([String: JSONAny].self, from: data)
    }

    /// Resets the process-global singleton between addBreadcrumb-level cases.
    /// Serialized via `BreadcrumbSharedStateTestLock` against
    /// `BreadcrumbAdaptersTests`'s disabled-kind tests, which run in a
    /// concurrently-scheduled `@Suite` and would otherwise race this
    /// `applyConfig(nil)` (re-enables ALL kinds) into their mutate -> act ->
    /// assert window — see the lock's doc comment.
    private func resetBreadcrumbState() {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
    }

    // MARK: - t / seq stamping

    @Test func stampsEpochMsAndMonotonicSeq() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        let before = Date().timeIntervalSince1970 * 1000
        buf.add(kind: .tap, message: "a")
        buf.add(kind: .tap, message: "b")
        let after = Date().timeIntervalSince1970 * 1000
        buf.freeze()
        let frozen = buf.takeFrozen()!
        #expect(frozen.count == 2)
        #expect(frozen[0].seq == 0)
        #expect(frozen[1].seq == 1)
        #expect(frozen[0].t >= before && frozen[0].t <= after)
        #expect(frozen[1].t >= before && frozen[1].t <= after)
    }

    // MARK: - cap / evict-oldest

    @Test func capsAtMaxCountEvictingOldestDefault100() {
        let buf = BreadcrumbRingBuffer(maxCount: 3, honorsKillGate: false)
        for i in 0..<5 { buf.add(kind: .console, message: "m\(i)") }
        #expect(buf.size == 3)
        buf.freeze()
        #expect(buf.takeFrozen()!.map(\.message) == ["m2", "m3", "m4"])
        #expect(BreadcrumbRingBuffer.defaultMaxCount == 100)
        #expect(BreadcrumbRingBuffer().maxCount == 100)
    }

    @Test func setMaxCountShrinksAndEvictsOldestImmediately() {
        let buf = BreadcrumbRingBuffer(maxCount: 5, honorsKillGate: false)
        for i in 0..<5 { buf.add(kind: .tap, message: "m\(i)") }
        buf.setMaxCount(2)
        #expect(buf.size == 2)
        buf.freeze()
        #expect(buf.takeFrozen()!.map(\.message) == ["m3", "m4"])
    }

    @Test func setMaxCountGrowsForFutureAdds() {
        let buf = BreadcrumbRingBuffer(maxCount: 2, honorsKillGate: false)
        buf.setMaxCount(4)
        for i in 0..<4 { buf.add(kind: .tap, message: "m\(i)") }
        #expect(buf.size == 4)
    }

    @Test func setMaxCountIgnoresInvalidValues() {
        let buf = BreadcrumbRingBuffer(maxCount: 3, honorsKillGate: false)
        for i in 0..<3 { buf.add(kind: .tap, message: "m\(i)") }
        buf.setMaxCount(0)
        buf.setMaxCount(-1)
        #expect(buf.size == 3)
        #expect(buf.maxCount == 3)
    }

    // MARK: - redaction (mask-before-bytes)

    @Test func redactsMessageAndDataStringBeforeBuffering() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        let data = jsonAnyDict(["nested": ["v": jwt]])
        buf.add(kind: .console, message: "token \(jwt)", data: data)
        buf.freeze()
        let crumb = buf.takeFrozen()!.first!
        #expect(crumb.message == "token [REDACTED:jwt]")
        let nested = crumb.data?["nested"]?.value as? [String: Any]
        #expect(nested?["v"] as? String == "[REDACTED:jwt]")
    }

    @Test func depthCapReplacesSubtreeAtDepth4AndNeverLeaksRawValue() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        let data = jsonAnyDict(["a": ["b": ["c": ["d": ["e": jwt]]]]])
        buf.add(kind: .custom, message: "deep", data: data)
        buf.freeze()
        let crumb = buf.takeFrozen()!.first!
        let a = crumb.data?["a"]?.value as? [String: Any]
        let b = a?["b"] as? [String: Any]
        let c = b?["c"] as? [String: Any]
        #expect(c?["d"] as? String == "[TRUNCATED:DEPTH]")
        let json = try! crumb.jsonString()
        #expect(json?.contains(jwt) == false)
    }

    // MARK: - message cap

    @Test func capsMessageAt2048UTF16UnitsAndMarksTruncated() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .custom, message: String(repeating: "x", count: 5000))
        buf.freeze()
        let crumb = buf.takeFrozen()!.first!
        #expect(crumb.message.utf16.count == 2048)
        #expect(crumb.truncated == true)
    }

    @Test func doesNotSetTruncatedWhenMessageIsAtOrUnderTheCap() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .custom, message: String(repeating: "x", count: 2048))
        buf.freeze()
        let crumb = buf.takeFrozen()!.first!
        #expect(crumb.message.utf16.count == 2048)
        #expect(crumb.truncated == nil)
    }

    // MARK: - freeze / discardAndResume / takeFrozen / clear lifecycle

    @Test func freezeSnapshotsChainLaterAddsDoNotPollute() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .tap, message: "before")
        buf.freeze()
        buf.add(kind: .tap, message: "reporter-own-tap")
        #expect(buf.takeFrozen()!.map(\.message) == ["before"])
        #expect(buf.size == 2) // live capture was never interrupted
    }

    @Test func freezeWhileFrozenKeepsFirstSnapshot() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .tap, message: "one")
        buf.freeze()
        buf.add(kind: .tap, message: "two")
        buf.freeze()
        #expect(buf.takeFrozen()!.count == 1)
    }

    @Test func discardAndResumeDropsSnapshot() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .tap, message: "a")
        buf.freeze()
        buf.discardAndResume()
        #expect(buf.takeFrozen() == nil)
    }

    @Test func takeFrozenReturnsNilWithoutPriorFreezeAndClearsAfterUse() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .tap, message: "a")
        #expect(buf.takeFrozen() == nil)
        buf.freeze()
        #expect(buf.takeFrozen()!.count == 1)
        #expect(buf.takeFrozen() == nil)
    }

    @Test func clearZeroizesEntriesAndSnapshot() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .tap, message: "a")
        buf.freeze()
        buf.clear()
        #expect(buf.size == 0)
        #expect(buf.takeFrozen() == nil)
    }

    // MARK: - kill-gate wiring (mirrors LogRingBufferTests.killGateBlocksAppend)

    @Test func killGateBlocksSharedBufferAdd() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        TraceItX.shared.kill()
        BreadcrumbRingBuffer.shared.add(kind: .tap, message: "blocked")
        #expect(BreadcrumbRingBuffer.shared.size == 0)
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        resetBreadcrumbState()
    }

    // MARK: - config gating (Task 1's wire, evaluated live at add-time)

    @Test func applyConfigDisabledClearsAndGatesAllAdds() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.add(kind: .tap, message: "a")
        #expect(buf.size == 1)
        buf.applyConfig(
            BreadcrumbsConfigWire(
                enabled: false, kinds: ["tap"], maxCount: 10, byteBudget: 16384, consoleEntryCap: 1024))
        #expect(buf.size == 0) // clear() fires on the enabled:false transition
        buf.add(kind: .tap, message: "b")
        #expect(buf.size == 0) // still gated
    }

    @Test func disabledKindAddIsANoOp() {
        let buf = BreadcrumbRingBuffer(maxCount: 10, honorsKillGate: false)
        buf.applyConfig(
            BreadcrumbsConfigWire(
                enabled: true, kinds: ["tap"], maxCount: 10, byteBudget: 16384, consoleEntryCap: 1024))
        buf.add(kind: .console, message: "not enabled")
        #expect(buf.size == 0)
        #expect(buf.isKindEnabled(.console) == false)
        buf.add(kind: .tap, message: "enabled")
        #expect(buf.size == 1)
        #expect(buf.isKindEnabled(.tap) == true)
    }

    @Test func applyConfigNilRestoresDefaults() {
        let buf = BreadcrumbRingBuffer(maxCount: 3, honorsKillGate: false)
        buf.applyConfig(
            BreadcrumbsConfigWire(
                enabled: false, kinds: [], maxCount: 1, byteBudget: 16384, consoleEntryCap: 1024))
        buf.applyConfig(nil)
        #expect(buf.maxCount == BreadcrumbRingBuffer.defaultMaxCount)
        #expect(buf.isKindEnabled(.console) == true)
        buf.add(kind: .console, message: "back to defaults")
        #expect(buf.size == 1)
    }

    // MARK: - TraceItX.addBreadcrumb coercions
    //
    // Task 7 note: each case below uses a UUID-suffixed, unique `message`
    // and filters the frozen chain for it rather than assuming
    // `takeFrozen()!.first!` is "the" crumb this test added — see the
    // matching doc comment on `noLogCaptureConfig` above. `BreadcrumbAdapters`
    // wires `StderrIntercept` to dual-write into this SAME shared singleton,
    // and another suite's `LogCapture.install()` call can race in a stray
    // `.console` crumb ahead of this test's own add.

    private func matchingCrumb(message: String) -> Breadcrumb? {
        BreadcrumbRingBuffer.shared.freeze()
        return BreadcrumbRingBuffer.shared.takeFrozen()?.first { $0.message == message }
    }

    @Test func addBreadcrumbCoercesUnknownKindToCustom() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        let marker = "hi-\(UUID().uuidString)"
        TraceItX.shared.addBreadcrumb(message: marker, kind: "totally-unknown-kind")
        #expect(matchingCrumb(message: marker)?.kind == .custom)
        resetBreadcrumbState()
    }

    @Test func addBreadcrumbDropsInvalidLevelRatherThanDefaulting() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        let marker = "hi-\(UUID().uuidString)"
        TraceItX.shared.addBreadcrumb(message: marker, level: "not-a-real-level")
        let crumb = matchingCrumb(message: marker)
        #expect(crumb != nil)
        #expect(crumb?.level == nil)
        resetBreadcrumbState()
    }

    @Test func addBreadcrumbAcceptsKnownKindAndLevel() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        let marker = "hi-\(UUID().uuidString)"
        TraceItX.shared.addBreadcrumb(message: marker, kind: "navigation", level: "warn")
        let crumb = matchingCrumb(message: marker)
        #expect(crumb?.kind == .navigation)
        #expect(crumb?.level == .warn)
        resetBreadcrumbState()
    }

    @Test func addBreadcrumbCoercesDataDroppingNonEncodableEntries() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        let marker = "with-data-\(UUID().uuidString)"
        TraceItX.shared.addBreadcrumb(
            message: marker,
            data: ["keep": "value", "alsoKeep": 42, "drop": Date()]
        )
        let crumb = matchingCrumb(message: marker)
        #expect(crumb?.data?["keep"]?.value as? String == "value")
        #expect(crumb?.data?["drop"] == nil)
        resetBreadcrumbState()
    }

    @Test func addBreadcrumbIsNoOpPreStartOrWhenKilled() throws {
        resetBreadcrumbState()
        TraceItX.shared.kill()
        TraceItX.shared.addBreadcrumb(message: "should not land")
        #expect(BreadcrumbRingBuffer.shared.size == 0)
        try TraceItX.shared.start(config: Self.noLogCaptureConfig(appId: testAppId))
        resetBreadcrumbState()
    }
}
