// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 05.1-01 — tests for the new `report.isPresenting` observation surface.
// Covers BOTH the Combine `@Published` path AND the NotificationCenter fallback
// path (Notification.Name.traceItXReporterPresentingChange) per CONTEXT D-02.
//
// Design notes:
//  • The test exercises ReportAPI directly via the public `__setPresenting`
//    slot indirection used by TXReporterPresenter at runtime — the slot is
//    populated in installResolver(); these tests populate it themselves to
//    stay independent of TraceItXReporterUI (which lives in a separate target).
//  • Tests use `@Suite(.serialized)` so the singleton's @Published state does
//    not leak between tests run in parallel.
import Testing
import Foundation
import Combine
@testable import TraceItXKit

@Suite(.serialized)
final class ReportAPIIsPresentingTests {
    init() {
        // Reset state before each test — the singleton persists across tests.
        ReportAPI.__performSetPresenting(false)
    }

    @Test func test1_initialIsFalse() {
        let api = TraceItX.shared.report
        #expect(api.isPresenting == false)
    }

    @Test func test2_setTrue_flipsAndPostsNotification() async throws {
        let api = TraceItX.shared.report
        var receivedUserInfoIsPresenting: Bool?
        let exp = NotificationExpectation()
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXReporterPresentingChange,
            object: nil,
            queue: nil
        ) { note in
            receivedUserInfoIsPresenting = note.userInfo?["isPresenting"] as? Bool
            exp.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        ReportAPI.__performSetPresenting(true)
        try await exp.wait(timeoutSeconds: 1.0)

        #expect(api.isPresenting == true)
        #expect(receivedUserInfoIsPresenting == true)
    }

    @Test func test3_flipBackToFalse_postsSecondNotification() async throws {
        let api = TraceItX.shared.report

        // Prime to true first (without observing).
        ReportAPI.__performSetPresenting(true)
        #expect(api.isPresenting == true)

        var receivedUserInfoIsPresenting: Bool?
        let exp = NotificationExpectation()
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXReporterPresentingChange,
            object: nil,
            queue: nil
        ) { note in
            receivedUserInfoIsPresenting = note.userInfo?["isPresenting"] as? Bool
            exp.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        ReportAPI.__performSetPresenting(false)
        try await exp.wait(timeoutSeconds: 1.0)

        #expect(api.isPresenting == false)
        #expect(receivedUserInfoIsPresenting == false)
    }

    @Test func test4_sameValueTwice_doesNotPostTwice() async throws {
        // With isPresenting already false (init), calling __performSetPresenting(false)
        // must not post a notification (didSet guards on oldValue != newValue).
        var postCount = 0
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXReporterPresentingChange,
            object: nil,
            queue: nil
        ) { _ in postCount += 1 }
        defer { NotificationCenter.default.removeObserver(token) }

        ReportAPI.__performSetPresenting(false)
        ReportAPI.__performSetPresenting(false)

        // Yield once to let any erroneously-posted notification land.
        try await Task.sleep(nanoseconds: 100_000_000)

        #expect(postCount == 0)
    }

    @Test func test5_combineSubscriberReceivesInitialAndTransitions() async throws {
        let api = TraceItX.shared.report
        var values: [Bool] = []
        let lock = NSLock()
        let cancellable = api.$isPresenting.sink { v in
            lock.lock(); values.append(v); lock.unlock()
        }
        defer { cancellable.cancel() }

        // Allow the initial value (false) to land.
        try await Task.sleep(nanoseconds: 50_000_000)

        ReportAPI.__performSetPresenting(true)
        try await Task.sleep(nanoseconds: 50_000_000)
        ReportAPI.__performSetPresenting(false)
        try await Task.sleep(nanoseconds: 50_000_000)

        lock.lock()
        let snapshot = values
        lock.unlock()

        // First emission is the initial value (false), then true, then false.
        #expect(snapshot.first == false)
        #expect(snapshot.contains(true))
        #expect(snapshot.last == false)
    }
}

// MARK: - Test helper: NotificationExpectation

/// Minimal awaitable latch used in lieu of XCTNSNotificationExpectation
/// (which is XCTest-only and awkward to bridge into Swift Testing).
private final class NotificationExpectation: @unchecked Sendable {
    private let lock = NSLock()
    private var fulfilled = false
    private var continuation: CheckedContinuation<Void, Error>?

    func fulfill() {
        lock.lock()
        fulfilled = true
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume()
    }

    func wait(timeoutSeconds: Double) async throws {
        // Fast path: already fulfilled.
        lock.lock()
        if fulfilled { lock.unlock(); return }
        lock.unlock()

        let timeoutNs = UInt64(timeoutSeconds * 1_000_000_000)
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    self.lock.lock()
                    if self.fulfilled {
                        self.lock.unlock()
                        cont.resume()
                    } else {
                        self.continuation = cont
                        self.lock.unlock()
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNs)
                throw NotificationTimeout.timedOut
            }
            try await group.next()
            group.cancelAll()
        }
    }
}

private enum NotificationTimeout: Error { case timedOut }
