// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

#if canImport(UIKit)
import Testing
import Foundation
@testable import EverframeKit

@Suite(.serialized)
struct CompanionFreezeLifecycleTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    /// `BreadcrumbRingBuffer.shared.add` no-ops while `Everframe.shared.captureGate`
    /// is closed (pre-start()). Under `-only-testing` isolation no other suite's
    /// `start()` call has run in this process, so without this the `.add(...)`
    /// calls below silently drop and the freeze/discard assertions would see an
    /// always-empty chain regardless of `beginReportCaptureLifecycle`'s
    /// correctness. Mirrors `BreadcrumbRingBufferTests`/`BreadcrumbTapNavAdaptersTests`
    /// (`capture.logs: false` keeps `StderrIntercept` from polluting the buffer
    /// with `.console` crumbs from the test runner's own output).
    private func noLogCaptureConfig() -> EverframeConfig {
        EverframeConfig(appId: testAppId, capture: CaptureConfig(logs: false))
    }

    private func withCleanBuffer(_ body: () -> Void) {
        try? Everframe.shared.start(config: noLogCaptureConfig())
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
        body()
        BreadcrumbRingBuffer.shared.clear()
    }

    @Test @MainActor func beginFreezesCurrentChain() {
        withCleanBuffer {
            BreadcrumbRingBuffer.shared.add(
                kind: .custom, message: "before-report",
                data: BreadcrumbRingBuffer.coerceHostData([:]))
            CompanionCaptureBridge.beginReportCaptureLifecycle()
            let frozen = BreadcrumbRingBuffer.shared.takeFrozen()
            #expect(frozen?.contains { $0.message == "before-report" } == true)
        }
    }

    @Test @MainActor func beginReplacesStaleSnapshot() {
        withCleanBuffer {
            BreadcrumbRingBuffer.shared.add(
                kind: .custom, message: "old",
                data: BreadcrumbRingBuffer.coerceHostData([:]))
            BreadcrumbRingBuffer.shared.freeze()   // stale freeze from a dead report
            BreadcrumbRingBuffer.shared.add(
                kind: .custom, message: "new",
                data: BreadcrumbRingBuffer.coerceHostData([:]))
            CompanionCaptureBridge.beginReportCaptureLifecycle()
            let frozen = BreadcrumbRingBuffer.shared.takeFrozen()
            // A plain freeze() would have no-opped and kept ["old"] only.
            #expect(frozen?.contains { $0.message == "new" } == true)
        }
    }

    @Test @MainActor func abortDiscardsSnapshot() {
        withCleanBuffer {
            BreadcrumbRingBuffer.shared.add(
                kind: .custom, message: "x",
                data: BreadcrumbRingBuffer.coerceHostData([:]))
            CompanionCaptureBridge.beginReportCaptureLifecycle()
            CompanionCaptureBridge.abortReportCaptureLifecycle()
            #expect(BreadcrumbRingBuffer.shared.takeFrozen() == nil)
        }
    }
}
#endif
