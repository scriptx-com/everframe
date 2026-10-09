// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class ReleaseHealthForegroundTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x63, count: 32)
    private let now = Date(timeIntervalSince1970: 1_791_421_323.456)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func runtime(foreground: Bool = true, beforeCommit: @escaping () throws -> Void = {}) -> ReleaseHealthRuntime {
        let key = key, now = now
        return ReleaseHealthRuntime(root: root, keyProvider: { key }, now: { now }, beforeCommit: beforeCommit,
            initiallyForeground: foreground, transport: { _, _ in .retry })
    }
    private func enable(_ runtime: ReleaseHealthRuntime, user: String = "opaque-a") async throws -> Bool {
        let config = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable, userId: user)
        let ticket = runtime.requestEnable(configuration: config, sdkKey: "key", endpoint: "https://example.test")
        return await runtime.enable(ticket: ticket, sdkVersion: "test")
    }
    private func rows() throws -> [[String: Any]] {
        try ReleaseHealthStore(root: root, keyProvider: { self.key }).pending().map { try JSONSerialization.jsonObject(with: $0.body) as! [String: Any] }
    }
    func testInitialBackgroundWaitsForForegroundAndEveryReentryUsesNewDurableSession() async throws {
        let runtime = runtime(foreground: false)
        let background = try await enable(runtime); XCTAssertFalse(background)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        let ticket = try XCTUnwrap(runtime.setForeground(true)).ticket
        let opened = await runtime.enable(ticket: ticket, sdkVersion: "test"); XCTAssertTrue(opened)
        let first = try XCTUnwrap(runtime.readyPointer)
        XCTAssertNil(runtime.setForeground(true))
        XCTAssertEqual(runtime.setForeground(false)?.retiredPointer, true); XCTAssertNil(runtime.readyPointer)
        XCTAssertNil(runtime.setForeground(false))
        await runtime.barrier()
        let bodies = try rows()
        XCTAssertEqual(bodies.compactMap { $0["phase"] as? String }, ["start", "end"])
        XCTAssertEqual(bodies[1]["endReason"] as? String, "background")
        XCTAssertEqual(bodies[1]["outcome"] as? String, "completed")
        let next = try XCTUnwrap(runtime.setForeground(true)).ticket
        let reopened = await runtime.enable(ticket: next, sdkVersion: "test"); XCTAssertTrue(reopened)
        XCTAssertNotEqual(first.exposureID, runtime.readyPointer?.exposureID)
        XCTAssertEqual(first.processLaunchID, runtime.readyPointer?.processLaunchID)
        runtime.boundary(); await runtime.barrier()
    }
    func testBackgroundRotationDoesNotOpenUntilForegroundAndRevokeCannotBeRevived() async throws {
        let runtime = runtime(); let opened = try await enable(runtime); XCTAssertTrue(opened)
        _ = runtime.setForeground(false)
        let changed = try await enable(runtime, user: "opaque-b"); XCTAssertFalse(changed)
        XCTAssertNil(runtime.readyPointer)
        let ticket = try XCTUnwrap(runtime.setForeground(true)).ticket
        let erase = runtime.revoke()
        let stale = await runtime.enable(ticket: ticket, sdkVersion: "test"); XCTAssertFalse(stale)
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        XCTAssertEqual(runtime.setForeground(false)?.retiredPointer, false)
        let later = try XCTUnwrap(runtime.setForeground(true)).ticket
        let revived = await runtime.enable(ticket: later, sdkVersion: "test"); XCTAssertFalse(revived)
        XCTAssertTrue(try rows().isEmpty)
    }
    func testBackgroundDuringStartCommitRemovesReadinessAndClosesOnlyTheStartedSession() async throws {
        let entered = expectation(description: "start commit"), release = DispatchSemaphore(value: 0)
        let flag = ForegroundFlag()
        let runtime = runtime(beforeCommit: { if flag.take() { entered.fulfill(); _ = release.wait(timeout: .now() + 5) } })
        let pending = Task { try await enable(runtime) }
        await fulfillment(of: [entered], timeout: 3)
        _ = runtime.setForeground(false); XCTAssertNil(runtime.readyPointer)
        release.signal(); let published = try await pending.value; XCTAssertFalse(published)
        await runtime.barrier()
        XCTAssertEqual(try rows().compactMap { $0["phase"] as? String }, ["start", "end"])
        XCTAssertNil(runtime.readyPointer)
    }
    func testConfigurationBoundaryCompletesOldSessionEvenWhenReplacementCannotStart() async throws {
        let runtime = runtime(); let opened = try await enable(runtime); XCTAssertTrue(opened)
        let config = try ReleaseHealthConfiguration(nativeBuildId: "replacement", loadedBuildId: nil, loadedBundleStatus: .notApplicable)
        let ticket = runtime.requestEnable(configuration: config, sdkKey: "key", endpoint: "https://example.test")
        let rejected = await runtime.enable(ticket: ticket, sdkVersion: ""); XCTAssertFalse(rejected)
        await runtime.barrier()
        XCTAssertEqual(try rows().compactMap { $0["phase"] as? String }, ["start", "end"])
        XCTAssertNil(runtime.readyPointer)
    }
    func testRestartNeverFabricatesAnEndForAnOldProcess() async throws {
        var old: ReleaseHealthRuntime? = runtime()
        let opened = try await enable(old!); XCTAssertTrue(opened)
        let exposure = try XCTUnwrap(old!.readyPointer)
        old = nil
        let next = runtime()
        let newStart = try await enable(next); XCTAssertTrue(newStart)
        XCTAssertNotEqual(exposure.exposureID, next.readyPointer?.exposureID)
        XCTAssertEqual(try rows().compactMap { $0["phase"] as? String }, ["start", "start"])
        next.boundary(); await next.barrier()
    }
    func testLifecycleObserverDeduplicatesCallbacksAndDisposesRegistration() {
        let center = NotificationCenter(), foreground = Notification.Name("foreground"), background = Notification.Name("background")
        let values = ForegroundValues()
        var observer: ReleaseHealthLifecycleObserver? = .init(center: center, foregroundNotification: foreground,
            backgroundNotification: background, initiallyForeground: false, onChange: { values.append($0) })
        XCTAssertNotNil(observer)
        center.post(name: foreground, object: nil); center.post(name: foreground, object: nil)
        center.post(name: background, object: nil); center.post(name: background, object: nil)
        XCTAssertEqual(values.values, [true, false])
        observer = nil; center.post(name: foreground, object: nil)
        XCTAssertEqual(values.values, [true, false])
    }
    func testExportsActualProducerStartAndCompletedEndWhenRequested() async throws {
        let runtime = runtime(); let opened = try await enable(runtime); XCTAssertTrue(opened)
        _ = runtime.setForeground(false); await runtime.barrier()
        let pair = try rows(); XCTAssertEqual(pair.count, 2)
        if let destination = ProcessInfo.processInfo.environment["EVERFRAME_IOS_HEALTH_WIRE_OUTPUT"] {
            try JSONSerialization.data(withJSONObject: pair, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: destination))
        }
    }
}
private final class ForegroundFlag: @unchecked Sendable {
    private let lock = NSLock(); private var first = true
    func take() -> Bool { lock.withLock { defer { first = false }; return first } }
}
private final class ForegroundValues: @unchecked Sendable {
    private let lock = NSLock(); private var items: [Bool] = []
    func append(_ value: Bool) { lock.withLock { items.append(value) } }
    var values: [Bool] { lock.withLock { items } }
}
