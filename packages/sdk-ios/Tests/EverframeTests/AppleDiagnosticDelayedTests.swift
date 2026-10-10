// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class AppleDiagnosticDelayedTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x59, count: 32)
    private let t = Date(timeIntervalSince1970: 1_800_000_000)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func box() -> JSONLOutbox {
        let key = key
        return JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key })
    }
    private func runtime(_ offset: TimeInterval) -> AppleDiagnosticRuntime {
        let key = key, date = t.addingTimeInterval(offset)
        return AppleDiagnosticRuntime(root: root.appendingPathComponent("journal"), outbox: box(), keyProvider: { key }, now: { date })
    }
    private func device(_ changed: Bool = false) -> DeviceMetadata {
        .init(model: "iPhone", osName: "iOS", osVersion: changed ? "19.0" : "18.0", locale: changed ? "lt_LT" : "en_US",
              timezone: changed ? "Europe/Vilnius" : "UTC", appVersion: "1.0", appBuild: "42", bundleIdentifier: "dev.example.host",
              screenWidth: changed ? 800 : 400, screenHeight: changed ? 400 : 800, pixelRatio: 2)
    }
    private func context(_ owner: String = "sdk-A", changed: Bool = false, endpoint: String = "https://example.invalid/api/ingest", pattern: String = "secret") throws -> AppleDiagnosticContext {
        let config = EverframeConfig(appId: owner, release: "release-A", redaction: .init(customPatterns: [try NSRegularExpression(pattern: pattern)]))
        return .init(frozen: try NativeCrashStartupContext.make(config: config, user: nil, device: device(changed), endpoint: endpoint), applicationVersion: "1.0", applicationBuild: "42")
    }
    private func candidate(_ begin: TimeInterval, _ end: TimeInterval, kind: String = "hang_batch") -> AppleDiagnosticCandidate {
        .init(kind: kind, begin: t.addingTimeInterval(begin), end: t.addingTimeInterval(end), applicationVersion: "1.0", applicationBuild: "42", osVersion: "iOS 19.0",
              hangs: kind == "hang_batch" ? [.init(durationMs: 2000, stack: .init(status: "unavailable", truncated: false, frames: []))] : [],
              exits: kind == "app_exit_summary" ? [.init(state: "background", reason: "memory_pressure", count: 2)] : [], truncated: false)
    }
    private func expect(_ result: Bool, _ expected: Bool = true, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(result, expected, file: file, line: line)
    }
    private func stop(_ runtime: AppleDiagnosticRuntime) async {
        runtime.boundary(); expect(await runtime.accept(candidate(0, 0)), false)
    }
    private func seed() async throws {
        let a = runtime(0); expect(await a.enable(context: try context(), scope: .installation))
        // Process death is not a configuration boundary or consent withdrawal.
    }
    func testRestartAdmitsEarlierIntervalUsingOriginalDeviceAndNewWindowIdentity() async throws {
        var a: AppleDiagnosticRuntime? = runtime(0)
        let original = try context()
        expect(await a!.enable(context: original, scope: .installation)); expect(await a!.accept(candidate(0, 0)))
        let first = try XCTUnwrap(box().hydrate().first)
        let key = key, journal = try AppleDiagnosticStore(root: root.appendingPathComponent("journal"), keyProvider: { key })
        let grant = try XCTUnwrap(journal.grant(for: candidate(0, 0), context: original, now: t))
        a = nil
        let b = runtime(86400); expect(await b.accept(candidate(0, 86400)), false)
        expect(await b.enable(context: try context(changed: true), scope: .installation))
        expect(await b.accept(candidate(0, 86400)))
        let last = try XCTUnwrap(box().hydrate().last)
        let one = try EverframeReportEnvelope(data: first.envelopeBytes), two = try EverframeReportEnvelope(data: last.envelopeBytes)
        XCTAssertNotEqual(one.payload.appleDiagnostic?.ownershipID, two.payload.appleDiagnostic?.ownershipID)
        XCTAssertNotEqual(two.payload.appleDiagnostic?.ownershipID, grant.id.uuidString.lowercased())
        let before = try JSONSerialization.jsonObject(with: original.frozen.envelopeTemplate) as! [String: Any]
        let after = try JSONSerialization.jsonObject(with: last.envelopeBytes) as! [String: Any]
        XCTAssertEqual((before["context"] as! NSDictionary)["device"] as? NSDictionary, (after["context"] as! NSDictionary)["device"] as? NSDictionary)
        XCTAssertNil(two.reporter.user); XCTAssertNil(last.identitySubject); XCTAssertNil(two.sessionID)
        await stop(b)
    }
    func testExportDelayedProducerFixtures() async throws {
        try await seed(); let b = runtime(86400)
        expect(await b.enable(context: try context(changed: true), scope: .installation))
        for kind in ["hang_batch", "app_exit_summary"] { expect(await b.accept(candidate(0, 86400, kind: kind))) }
        let entries = try box().hydrate(); XCTAssertEqual(entries.count, 2)
        if let path = ProcessInfo.processInfo.environment["EVERFRAME_APPLE_PROOF_DIR"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for (index, name) in ["hang", "exits"].enumerated() {
                try entries[index].envelopeBytes.write(to: directory.appendingPathComponent("synthetic-apple-delayed-\(name).json"))
            }
        }
        await stop(b)
    }
    func testLegacyModeClosesGrantAndNeverAdmitsHistoricalCallback() async throws {
        try await seed(); let b = runtime(100)
        expect(await b.enable(context: try context())); expect(await b.accept(candidate(0, 50)), false)
        expect(await b.enable(context: try context(), scope: .installation))
        expect(await b.accept(candidate(99, 100))); expect(await b.accept(candidate(0, 50)))
        await stop(b)
    }
    func testDifferentFirstStartWithoutEnableClosesHistoryButSameOwnerStartDoesNotWrite() async throws {
        try await seed()
        let file = root.appendingPathComponent("journal/state"), bytes = try Data(contentsOf: file)
        var c: AppleDiagnosticRuntime? = runtime(100)
        c!.boundary(startedOwner: try context().ownerDigest())
        expect(await c!.accept(candidate(0, 1)), false) // worker barrier without enable
        XCTAssertEqual(try Data(contentsOf: file), bytes); c = nil
        c = runtime(200); c!.boundary(startedOwner: try context("sdk-B").ownerDigest())
        expect(await c!.accept(candidate(0, 1)), false); c = nil
        let d = runtime(300); d.boundary(startedOwner: try context().ownerDigest())
        expect(await d.enable(context: try context(), scope: .installation))
        expect(await d.accept(candidate(201, 250)), false); expect(await d.accept(candidate(0, 199)))
        await stop(d)
    }
    func testWholePeriodLimitsWarmupExpiryAndRevocation() async throws {
        try await seed(); let b = runtime(86400)
        expect(await b.enable(context: try context(), scope: .installation))
        for pair in [(-0.001, 86399.999), (0.0, 86400.001), (1.0, 86400.001)] {
            expect(await b.accept(candidate(pair.0, pair.1)), false)
        }
        expect(await b.accept(candidate(0, 86400)))
        let request = b.revoke(); expect(await b.finishRevocation(request))
        let c = runtime(86401); expect(await c.enable(context: try context(), scope: .installation))
        expect(await c.accept(candidate(0, 86400)), false); await stop(c)
    }
    func testExpiredAndChangedOwnersCannotAuthorizeOldCallbacks() async throws {
        for (offset, owner, endpoint, pattern) in [(8.0 * 86400, "sdk-A", "https://example.invalid/api/ingest", "secret"),
            (100, "sdk-B", "https://example.invalid/api/ingest", "secret"), (100, "sdk-A", "https://other.invalid", "secret"),
            (100, "sdk-A", "https://example.invalid/api/ingest", "different")] {
            try await seed(); let b = runtime(offset)
            expect(await b.enable(context: try context(owner, endpoint: endpoint, pattern: pattern), scope: .installation))
            expect(await b.accept(candidate(0, 0)), false)
            expect(await b.finishRevocation(b.revoke()))
        }
    }
    func testPerKindHandoffRetainsMetricDuringDiagnosticAndDropsSecondDiagnostic() async throws {
        let live = runtime(0); expect(await live.enable(context: try context(), scope: .installation))
        let entered = expectation(description: "diagnostic projection"), gate = DispatchSemaphore(value: 0)
        let hang = candidate(0, 0), metric = candidate(0, 0, kind: "app_exit_summary")
        live.receive(kind: .diagnostic) { entered.fulfill(); gate.wait(); return [hang] }
        await fulfillment(of: [entered], timeout: 3)
        live.receive(kind: .metric) { [metric] }
        live.receive(kind: .diagnostic) { XCTFail("Same-kind backlog must be dropped"); return [] }
        gate.signal()
        expect(await live.enable(context: try context(), scope: .installation)) // worker barrier
        XCTAssertEqual(try box().hydrate().count, 2); await stop(live)
    }
    func testNewestEightPayloadSelectionIsStableAndBounded() {
        let inputs = (0..<9).map { candidate(Double($0), Double($0)) }
        XCTAssertEqual(AppleDiagnosticCallback.newest(inputs, end: { $0.end }).map(\.end), inputs.dropFirst().reversed().map(\.end))
    }
    func testBoundaryCannotBeCancelledByNewEnableWhileProjectionIsBlocked() async throws {
        let live = runtime(100); expect(await live.enable(context: try context(), scope: .installation))
        let entered = expectation(description: "projection"), gate = DispatchSemaphore(value: 0), input = candidate(100, 100)
        live.receive { entered.fulfill(); gate.wait(); return [input] }
        await fulfillment(of: [entered], timeout: 3)
        live.boundary()
        let newer = Task { await live.enable(context: try! context(), scope: .installation) }
        gate.signal(); expect(await newer.value)
        XCTAssertTrue(try box().hydrate().isEmpty)
        await stop(live)
    }
    func testFailedFirstStartReadRemainsOwedBeforeEnable() async throws {
        try await seed()
        let key = key, clock = DelayedClock(t.addingTimeInterval(100)), blocked = DelayedKeyGate()
        let c = AppleDiagnosticRuntime(root: root.appendingPathComponent("journal"), outbox: box(), keyProvider: {
            if blocked.value { throw CocoaError(.fileReadNoPermission) }; return key
        }, now: { clock.value })
        c.boundary(startedOwner: try context("sdk-B").ownerDigest())
        expect(await c.accept(candidate(0, 0)), false)
        expect(await c.enable(context: try context(), scope: .installation), false)
        XCTAssertTrue(try box().hydrate().isEmpty)
        blocked.set(false); clock.set(t.addingTimeInterval(200))
        expect(await c.enable(context: try context(), scope: .installation))
        // Authorization at 200 must first close the old interval at 100.
        expect(await c.accept(candidate(101, 150)), false)
        expect(await c.accept(candidate(0, 99)))
        await stop(c)
    }
    func testFailedStartupRollbackCleanupCannotBeForgottenAfterClockCatchesUp() async throws {
        try await seed()
        var previous: AppleDiagnosticRuntime? = runtime(100)
        expect(await previous!.enable(context: try context(), scope: .installation)); previous = nil
        let key = key, clock = DelayedClock(t.addingTimeInterval(50)), blocked = DelayedKeyGate()
        let live = AppleDiagnosticRuntime(root: root.appendingPathComponent("journal"), outbox: box(), keyProvider: {
            if blocked.value { throw CocoaError(.fileReadNoPermission) }; return key
        }, now: { clock.value })
        live.boundary(startedOwner: try context().ownerDigest())
        expect(await live.accept(candidate(25, 75)), false)
        clock.set(t.addingTimeInterval(150)); blocked.set(false)
        expect(await live.enable(context: try context(), scope: .installation))
        expect(await live.accept(candidate(25, 75)), false)
        await stop(live)
    }
    func testFirstStartWithNoJournalDoesNotCreateKeyOrFiles() async throws {
        let live = AppleDiagnosticRuntime(root: root.appendingPathComponent("absent"), outbox: box(), keyProvider: {
            XCTFail("Startup without history must not access the key"); throw CocoaError(.fileReadNoPermission)
        })
        live.boundary(startedOwner: "owner")
        expect(await live.accept(candidate(0, 0)), false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("absent").path))
    }
    private func bundle() throws -> Bundle {
        let url = root.appendingPathComponent("Host.bundle")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "dev.example.host", "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "42", "CFBundlePackageType": "BNDL"], format: .xml, options: 0).write(to: url.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: url))
    }
    func testPublicScopeAcrossSDKRestartsWithChangedDeviceThenRepeatedStartAndKill() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [DelayedUnavailableProtocol.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let config = EverframeConfig(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false))
        let hostBundle = try bundle(), firstDevice = device(), nextDevice = device(true)
        var first: AppleDiagnosticRuntime? = runtime(0)
        var sdk: Everframe? = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: first, releaseHealthRuntime: nil,
            appleDiagnosticSession: { session }, appleDiagnosticBundle: hostBundle, nativeDeviceSnapshot: { firstDevice })
        try sdk!.start(config: config); expect(await sdk!.setAppleDiagnosticsEnabled(true, scope: .installation))
        sdk = nil; first = nil
        let next = runtime(86400)
        sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: next, releaseHealthRuntime: nil,
            appleDiagnosticSession: { session }, appleDiagnosticBundle: hostBundle, nativeDeviceSnapshot: { nextDevice })
        try sdk!.start(config: config); expect(await sdk!.setAppleDiagnosticsEnabled(true, scope: .installation))
        expect(await next.accept(candidate(0, 86400)))
        let entry = try XCTUnwrap(box().hydrate().first), envelope = try EverframeReportEnvelope(data: entry.envelopeBytes)
        XCTAssertEqual(envelope.context.device.timezone, "UTC")
        try sdk!.start(config: config) // Repeated start is an unconditional boundary.
        expect(await sdk!.setAppleDiagnosticsEnabled(true, scope: .installation))
        sdk!.kill(); expect(await next.accept(candidate(86400, 86400)), false)
        expect(await sdk!.setAppleDiagnosticsEnabled(false)); XCTAssertTrue(try box().hydrate().isEmpty)
    }

}

private final class DelayedKeyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var blocked = true
    var value: Bool { lock.withLock { blocked } }
    func set(_ value: Bool) { lock.withLock { blocked = value } }
}
private final class DelayedUnavailableProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class DelayedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date: Date
    init(_ date: Date) { self.date = date }
    var value: Date { lock.withLock { date } }
    func set(_ value: Date) { lock.withLock { date = value } }
}
