// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

#if canImport(UIKit)
import Testing
import UIKit
@testable import TraceItXKit
import TraceItXProtocol

@Suite(.serialized)
struct PressCrumbTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    /// `BreadcrumbRingBuffer.shared.add` no-ops while `TraceItX.shared.captureGate`
    /// is closed (pre-start()). Under `-only-testing` isolation no other suite's
    /// `start()` call has run in this process, so without this the
    /// `recordEndedPress` calls below silently drop and every assertion here
    /// would see an always-empty buffer regardless of correctness. Mirrors
    /// `CompanionFreezeLifecycleTests`/`BreadcrumbTapNavAdaptersTests`.
    private func noLogCaptureConfig() -> TraceItXConfig {
        TraceItXConfig(appId: testAppId, capture: CaptureConfig(logs: false))
    }

    private func withCleanState(_ body: @MainActor () -> Void) {
        try? TraceItX.shared.start(config: noLogCaptureConfig())
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
        PressCrumbRateLimiter.__resetForTesting()
        TapBreadcrumbAdapter.__resetForTesting()
        MainActor.assumeIsolated(body)
        BreadcrumbRingBuffer.shared.clear()
        PressCrumbRateLimiter.__resetForTesting()
        TapBreadcrumbAdapter.__resetForTesting()
    }

    private func frozenCrumbs() -> [Breadcrumb] {
        BreadcrumbRingBuffer.shared.freeze()
        return BreadcrumbRingBuffer.shared.takeFrozen() ?? []
    }

    @Test @MainActor func selectPressRecordsFocusedLabel() {
        withCleanState {
            let view = UIView()
            view.accessibilityLabel = "Play Movie"
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .select, focusedView: view, eventTimestamp: 1.0)
            let crumb = frozenCrumbs().first { $0.kind == .tap }
            #expect(crumb?.message == "press select — Play Movie")
        }
    }

    @Test @MainActor func nilFocusFallsBackToScreen() {
        withCleanState {
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .menu, focusedView: nil, eventTimestamp: 2.0)
            let crumb = frozenCrumbs().first { $0.kind == .tap }
            #expect(crumb?.message == "press menu — screen")
        }
    }

    @Test @MainActor func rapidRepeatSameButtonIsDropped() {
        withCleanState {
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .rightArrow, focusedView: nil, eventTimestamp: 3.0)
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .rightArrow, focusedView: nil, eventTimestamp: 3.1)
            let crumbs = frozenCrumbs().filter { $0.kind == .tap }
            #expect(crumbs.count == 1)
        }
    }

    @Test @MainActor func differentButtonIsNotDropped() {
        withCleanState {
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .rightArrow, focusedView: nil, eventTimestamp: 4.0)
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .select, focusedView: nil, eventTimestamp: 4.1)
            let crumbs = frozenCrumbs().filter { $0.kind == .tap }
            #expect(crumbs.count == 2)
        }
    }

    @Test @MainActor func rateLimiterWindowExpires() {
        withCleanState {
            #expect(PressCrumbRateLimiter.shouldRecord(button: "up", now: 100.0))
            #expect(!PressCrumbRateLimiter.shouldRecord(button: "up", now: 100.1))
            #expect(PressCrumbRateLimiter.shouldRecord(button: "up", now: 100.5))
        }
    }

    /// Regression (review finding on c404f1cb): a select-press on a focused
    /// UIControl fires `sendAction` INSIDE the swizzle's call-through before
    /// `recordEndedPress` ever runs, which already recorded a "tap <label>"
    /// crumb and stamped `TapBreadcrumbAdapter.lastActionEventTimestamp`
    /// with the event's timestamp. `recordEndedPress` for that SAME event
    /// must bail rather than record a second "press select — ..." crumb for
    /// one physical activation.
    @Test @MainActor func selectPressDedupsAgainstSameEventSendActionTap() {
        withCleanState {
            let view = UIView()
            view.accessibilityLabel = "Play Movie"
            let sharedTimestamp: TimeInterval = 5.0
            TapBreadcrumbAdapter.recordTap(sender: view, eventTimestamp: sharedTimestamp)
            WindowTapBreadcrumbAdapter.recordEndedPress(
                type: .select, focusedView: view, eventTimestamp: sharedTimestamp)
            let crumbs = frozenCrumbs().filter { $0.kind == .tap }
            #expect(crumbs.count == 1)
            #expect(crumbs.first?.message == "tap Play Movie")
            #expect(!crumbs.contains { $0.message.hasPrefix("press") })
        }
    }
}
#endif
