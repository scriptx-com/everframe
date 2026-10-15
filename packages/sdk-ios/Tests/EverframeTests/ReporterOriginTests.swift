// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit

@MainActor @Suite struct ReporterOriginTests {
    private func fromBackground(_ action: @escaping @Sendable () -> Void) {
        let ready = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { action(); ready.signal() }
        ready.wait()
    }
    @Test func reporterIntervalIsFrozenBeforeLaterActivityAndClosedInTheLiveTrail() {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        buffer.add(kind: .tap, message: "tap ordinary Menu")
        buffer.reporterOpened(trigger: .companion)
        buffer.freeze()
        buffer.add(kind: .tap, message: "tap composer")
        buffer.reporterClosed()
        let frozen = buffer.takeFrozen()!
        #expect(frozen.map(\.message) == ["tap ordinary Menu", "reporter_opened"])
        #expect(frozen.last?.data?["source"]?.value as? String == "everframe_reporter")
        #expect(frozen.last?.data?["trigger"]?.value as? String == "companion")
        #expect(buffer.snapshot().last?.message == "reporter_closed")
        buffer.reporterOpened(trigger: .shake)
        buffer.freeze()
        #expect(buffer.takeFrozen()?.last?.data?["trigger"]?.value as? String == "shake")
    }
    @Test func customGateRevokesRetainedBoundaryAndDuplicateOpensAreIdempotent() {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        buffer.reporterOpened(trigger: .menu)
        buffer.reporterOpened(trigger: .button)
        #expect(buffer.snapshot().map(\.message) == ["reporter_opened"])
        buffer.applyConfig(BreadcrumbsConfigWire(enabled: true, kinds: ["tap"], maxCount: 20, byteBudget: 65536, consoleEntryCap: 1024))
        buffer.reporterOpened(trigger: .button)
        #expect(buffer.snapshot().isEmpty)
        buffer.applyConfig(nil)
        buffer.reporterClosed()
        #expect(buffer.snapshot().isEmpty)
    }
    @Test func queuedMarkerCannotCrossEvidenceRevocation() async {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        fromBackground { buffer.reporterOpened(trigger: .button) }
        buffer.clear()
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        #expect(buffer.snapshot().isEmpty)
    }
    @Test func queuedCloseCannotCloseANewerReporterInterval() async {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        buffer.reporterOpened(trigger: .button)
        fromBackground { buffer.reporterClosed() }
        buffer.reporterClosed()
        buffer.reporterOpened(trigger: .menu)
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        #expect(buffer.snapshot().map(\.message) == ["reporter_opened", "reporter_closed", "reporter_opened"])
        buffer.reporterClosed()
        #expect(buffer.snapshot().last?.message == "reporter_closed")
    }
    @Test func queuedOpenAndClosePreserveTheirInterval() async {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        fromBackground {
            buffer.reporterOpened(trigger: .button)
            buffer.reporterClosed()
        }
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        #expect(buffer.snapshot().map(\.message) == ["reporter_opened", "reporter_closed"])
    }
    @Test func queuedCloseRetiresItsIntervalAfterUnrelatedKindChanges() async {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        buffer.reporterOpened(trigger: .button)
        fromBackground { buffer.reporterClosed() }
        buffer.applyConfig(BreadcrumbsConfigWire(enabled: true, kinds: ["custom"], maxCount: 20, byteBudget: 65536, consoleEntryCap: 1024))
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        #expect(buffer.snapshot().map(\.message) == ["reporter_opened", "reporter_closed"])
    }
    @Test func queuedOpenCompletionOrdersSubsequentHostEvidence() async {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        await withCheckedContinuation { continuation in
            fromBackground {
                buffer.reporterOpened(trigger: .menu) {
                    buffer.add(kind: .custom, message: "host reporter visible")
                    continuation.resume()
                }
            }
        }
        #expect(buffer.snapshot().map(\.message) == ["reporter_opened", "host reporter visible"])
    }
    @Test func closedWithoutOpenAndRevokedIntervalsDoNotWriteMarkers() {
        let buffer = BreadcrumbRingBuffer(maxCount: 20, honorsKillGate: false)
        buffer.reporterClosed()
        #expect(buffer.snapshot().isEmpty)
        buffer.reporterOpened(trigger: .button)
        buffer.clear()
        buffer.reporterClosed()
        #expect(buffer.snapshot().isEmpty)
    }
}
