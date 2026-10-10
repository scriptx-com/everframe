// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class TerminationTrackerTests: XCTestCase {
    final class Pings: @unchecked Sendable {
        private let lock = NSLock(); private var items: [@Sendable () -> Void] = []
        func append(_ item: @escaping @Sendable () -> Void) { lock.withLock { items.append(item) } }
        var count: Int { lock.withLock { items.count } }
        func run(_ index: Int) { let item = lock.withLock { items[index] }; item() }
    }
    final class Clock: @unchecked Sendable {
        private let lock = NSLock(); private var value: UInt64 = 1_000
        var ms: UInt64 { get { lock.withLock { value } } set { lock.withLock { value = newValue } } }
    }
    private var directory: URL!, file: TerminationStateFile!
    private let center = NotificationCenter(), pings = Pings(), clock = Clock()
    private let names = TerminationTracker.Notifications(active: .init("a"), inactive: .init("i"), background: .init("b"),
        foreground: .init("f"), terminate: .init("t"), memoryWarning: .init("m"))
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        file = try TerminationStateFile.create(at: directory.appendingPathComponent(TerminationLayout.fileName))
        file.writeHeader(launchID: UUID(), identity: TerminationStateFileTests.identity, startedAt: Date())
    }
    override func tearDownWithError() throws { file = nil; try FileManager.default.removeItem(at: directory) }
    private func makeTracker(available: Int64? = 50 << 20, simulator: Bool = false, debugger: Bool = false,
                             initial: TerminationAppState = .launching) -> TerminationTracker {
        var readers = TerminationTracker.Readers()
        let clock = clock, pings = pings
        readers.footprint = { 700 << 20 }; readers.available = { available }; readers.thermal = { 2 }
        readers.debugger = { debugger }; readers.uptimeMs = { clock.ms }; readers.simulator = simulator; readers.sampling = false
        return TerminationTracker(file: file, readers: readers, queue: DispatchQueue(label: "test"), center: center,
            notifications: names, initial: initial, ping: { pings.append($0) })
    }
    private func record() throws -> TerminationRunRecord { try TerminationRunRecord(bytes: Data(contentsOf: file.url)) }

    func testLifecycleNotificationsWriteTheAppState() throws {
        let tracker = makeTracker()
        XCTAssertEqual(try record().appState, .launching)
        center.post(name: names.active, object: nil); XCTAssertEqual(try record().appState, .active)
        center.post(name: names.inactive, object: nil); XCTAssertEqual(try record().appState, .inactive)
        center.post(name: names.background, object: nil); XCTAssertEqual(try record().appState, .background)
        center.post(name: names.foreground, object: nil); XCTAssertEqual(try record().appState, .inactive)
        center.post(name: names.memoryWarning, object: nil); center.post(name: names.memoryWarning, object: nil)
        XCTAssertEqual(try record().memoryWarnings, 2); XCTAssertNotNil(try record().lastWarningAt)
        XCTAssertFalse(try record().terminateNotified)
        center.post(name: names.terminate, object: nil); XCTAssertTrue(try record().terminateNotified)
        tracker.drainForTesting()
    }
    func testAMemoryWarningAlsoTakesASample() throws {
        let tracker = makeTracker()
        XCTAssertNil(try record().sampledAt)
        center.post(name: names.memoryWarning, object: nil); tracker.drainForTesting()
        XCTAssertEqual(try record().footprintBytes, 700 << 20); XCTAssertNotNil(try record().sampledAt)
    }
    func testSampleWritesMemoryThermalAndDebugger() throws {
        makeTracker(debugger: true).sampleOnce()
        let value = try record()
        XCTAssertEqual(value.footprintBytes, 700 << 20); XCTAssertEqual(value.availableBytes, 50 << 20)
        XCTAssertEqual(value.thermalState, 2); XCTAssertTrue(value.debuggerSeen); XCTAssertNotNil(value.sampledAt)
    }
    func testDebuggerFlagIsSticky() throws {
        makeTracker(debugger: true).sampleOnce()
        makeTracker(debugger: false).sampleOnce()
        XCTAssertTrue(try record().debuggerSeen)
    }
    func testSimulatorZeroHeadroomIsUnknown() throws {
        makeTracker(available: 0, simulator: true).sampleOnce(); XCTAssertNil(try record().availableBytes)
        makeTracker(available: 0, simulator: false).sampleOnce(); XCTAssertEqual(try record().availableBytes, 0)
        makeTracker(available: nil).sampleOnce(); XCTAssertNil(try record().availableBytes)
    }
    func testOutstandingMainPingBecomesAStall() throws {
        let tracker = makeTracker()
        tracker.sampleOnce(); XCTAssertEqual(pings.count, 1)
        clock.ms += 6_000; tracker.sampleOnce()
        XCTAssertEqual(try record().mainStallMs, 6_000); XCTAssertEqual(pings.count, 1)
        pings.run(0); tracker.drainForTesting()
        XCTAssertEqual(try record().mainStallMs, 6_000)   // cleared by the next sample, not by the ping itself
        clock.ms += 5_000; tracker.sampleOnce(); XCTAssertEqual(try record().mainStallMs, 0); XCTAssertEqual(pings.count, 2)
    }
    func testBackgroundClearsAnOutstandingStall() throws {
        let tracker = makeTracker()
        tracker.sampleOnce(); clock.ms += 6_000; tracker.sampleOnce()
        XCTAssertEqual(try record().mainStallMs, 6_000)
        center.post(name: names.background, object: nil); tracker.drainForTesting()
        XCTAssertEqual(try record().mainStallMs, 0)
    }
    func testRealSampleCostStaysUnderOneHundredMicroseconds() {
        var readers = TerminationTracker.Readers(); readers.sampling = false
        let tracker = TerminationTracker(file: file, readers: readers, queue: DispatchQueue(label: "bench"), center: center,
            notifications: names, initial: .active, ping: { _ in })
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<10_000 { tracker.sampleOnce() }
        let mean = Double(DispatchTime.now().uptimeNanoseconds - start) / 10_000 / 1_000
        print("termination sample mean µs:", mean)
        XCTAssertLessThan(mean, 100)
    }
    func testPlatformGate() {
        XCTAssertFalse(TerminationPlatform.isEligible(bundleURL: URL(fileURLWithPath: "/x/TopShelf.appex"), process: .processInfo))
        #if !os(iOS) && !os(tvOS)
        XCTAssertFalse(TerminationPlatform.isEligible(bundleURL: URL(fileURLWithPath: "/x/App.app"), process: .processInfo))
        #endif
    }
}
