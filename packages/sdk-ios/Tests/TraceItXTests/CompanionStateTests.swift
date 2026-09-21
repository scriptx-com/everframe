// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 Task 1 — CompanionAPI state + notification dual-surface tests.
//
// Mirrors the Swift-Testing style locked in `ReportAPIIsPresentingTests.swift`
// (Phase 05.1). We exercise `CompanionAPI` directly (not the shared singleton)
// so tests are isolation-safe and don't leak state through `TraceItX.shared.companion`.
import Testing
import Foundation
import Combine
@testable import TraceItXKit

@Suite(.serialized)
final class CompanionStateTests {

    @Test func test1_initialStateIsUnpaired() {
        let api = CompanionAPI()
        #expect(api.state == .unpaired)
        #expect(api.pairUrl == nil)
    }

    @Test func test2_stateChangePostsNotification() async throws {
        let api = CompanionAPI()
        let exp = CompanionNotificationLatch()
        var receivedRaw: String?
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionStateChange,
            object: api,
            queue: nil
        ) { note in
            receivedRaw = note.userInfo?["state"] as? String
            exp.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        api.__setState(.paired)
        try await exp.wait(timeoutSeconds: 1.0)

        #expect(api.state == .paired)
        #expect(receivedRaw == "paired")
    }

    @Test func test3_noNotificationOnNoOpAssignment() async {
        let api = CompanionAPI()
        // Already .unpaired by default; assigning .unpaired again must NOT post.
        var count = 0
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionStateChange,
            object: api,
            queue: nil
        ) { _ in count += 1 }
        defer { NotificationCenter.default.removeObserver(token) }

        api.__setState(.unpaired)
        // Give the notification queue a chance to flush (it won't, but verify).
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(count == 0)
    }

    @Test func test4_pairUrlChangePostsNotification() async throws {
        let api = CompanionAPI()
        let exp = CompanionNotificationLatch()
        var receivedURL: String?
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionPairUrlChange,
            object: api,
            queue: nil
        ) { note in
            receivedURL = note.userInfo?["pairUrl"] as? String
            exp.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        api.__setPairUrl("https://relay.example.com/r/tok_abc")
        try await exp.wait(timeoutSeconds: 1.0)

        #expect(api.pairUrl == "https://relay.example.com/r/tok_abc")
        #expect(receivedURL == "https://relay.example.com/r/tok_abc")
    }

    @Test func test5_statePublishedConformsToCombine() async throws {
        let api = CompanionAPI()
        let exp = CompanionNotificationLatch()
        var bag = Set<AnyCancellable>()
        var received: CompanionState?
        api.$state
            .dropFirst() // skip the initial .unpaired emission
            .sink { s in
                received = s
                exp.fulfill()
            }
            .store(in: &bag)

        api.__setState(.reportInProgress)
        try await exp.wait(timeoutSeconds: 1.0)

        #expect(received == .reportInProgress)
        #expect(api.state == .reportInProgress)
        _ = bag // keep bag alive until here
    }

    @Test func test6_allStateCasesRoundTripRawValue() {
        for s in CompanionState.allCases {
            let api = CompanionAPI()
            api.__setState(s)
            #expect(api.state == s)
            #expect(CompanionState(rawValue: s.rawValue) == s)
        }
    }

    @Test func test7_traceItXSharedCompanionExists() {
        // The public property must be reachable from the singleton.
        #expect(TraceItX.shared.companion is CompanionAPI)
    }

    // MARK: - External review, finding NN2 — __beginReport/__finishReport
    // must publish `state` through `onMain`, never directly, since both are
    // reachable off the main thread in production (`RelayWSClient`'s
    // `handleControl` on the URLSession delegate queue for `__beginReport`;
    // `CompanionCaptureBridge`'s submit-completion callback for
    // `__finishReport`). `queue: nil` below means the observer runs
    // SYNCHRONOUSLY on whichever thread actually performs the `state`
    // write (`didSet` posts inline), so capturing `Thread.isMainThread`
    // inside it proves which thread the `@Published` mutation landed on —
    // not just that it eventually happened.

    @Test func test8_beginReport_fromBackgroundThread_publishesStateOnMainThread() async throws {
        let api = CompanionAPI()
        let exp = CompanionNotificationLatch()
        var observedOnMain = false
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionStateChange,
            object: api,
            queue: nil
        ) { _ in
            observedOnMain = Thread.isMainThread
            exp.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        DispatchQueue.global().async {
            api.__beginReport(correlationId: "corr-nn2-begin")
        }
        try await exp.wait(timeoutSeconds: 2.0)

        #expect(observedOnMain)
        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "corr-nn2-begin")
    }

    @Test func test9_finishReport_fromBackgroundThread_publishesStateOnMainThread() async throws {
        let api = CompanionAPI()
        // Synchronous — establishes the claim before the background call below.
        api.__beginReport(correlationId: "corr-nn2-finish")

        let exp = CompanionNotificationLatch()
        var observedOnMain = false
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionStateChange,
            object: api,
            queue: nil
        ) { _ in
            observedOnMain = Thread.isMainThread
            exp.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        var beforePairedCalled = false
        DispatchQueue.global().async {
            _ = api.__finishReport(correlationId: "corr-nn2-finish") {
                beforePairedCalled = true
            }
        }
        try await exp.wait(timeoutSeconds: 2.0)

        #expect(observedOnMain)
        #expect(beforePairedCalled)
        #expect(api.state == .paired)
        #expect(api.__reportInProgressCorrelationIdForTesting() == nil)
    }
}

// MARK: - Local test helper

/// Minimal awaitable latch — mirrors the private NotificationExpectation in
/// ReportAPIIsPresentingTests.swift. Kept local to this file to stay
/// independent of test-target shared helpers.
private final class CompanionNotificationLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var fulfilled = false
    private var continuation: CheckedContinuation<Void, Error>?

    func fulfill() {
        lock.lock()
        let cont = continuation
        fulfilled = true
        continuation = nil
        lock.unlock()
        cont?.resume()
    }

    func wait(timeoutSeconds: Double) async throws {
        lock.lock()
        if fulfilled {
            lock.unlock()
            return
        }
        lock.unlock()

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { [self] in
                try await withCheckedThrowingContinuation { cont in
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
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                throw NotificationTimeout.timedOut
            }
            try await group.next()
            group.cancelAll()
        }
    }
}

private enum NotificationTimeout: Error { case timedOut }
