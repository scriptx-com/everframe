// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class TerminationStateFileTests: XCTestCase {
    static let identity = TerminationIdentity(appVersion: "1.2.3", appBuild: "45",
        executableUUID: UUID(uuidString: "11111111-2222-3333-4444-555555555555"), osVersion: "Version 26.5 (Build 23L470)", bootTime: 1_760_000_000)
    private var directory: URL!
    private var url: URL { directory.appendingPathComponent(TerminationLayout.fileName) }
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    func testFieldsWrittenThroughTheMappingSurviveUnmapAndDecode() throws {
        let launch = UUID(), context = UUID()
        do {
            let file = try TerminationStateFile.create(at: url)
            file.writeHeader(launchID: launch, identity: Self.identity, startedAt: Date(timeIntervalSince1970: 1_760_000_100))
            file.store(TerminationAppState.active.rawValue, at: TerminationLayout.appStateAt)
            file.store(Date(timeIntervalSince1970: 1_760_000_200), at: TerminationLayout.stateChangedAt)
            file.store(3, at: TerminationLayout.warningsAt)
            file.store(1_400_000_000, at: TerminationLayout.footprintAt)
            file.store(40_000_000, at: TerminationLayout.availableAt)
            file.store(Date(timeIntervalSince1970: 1_760_000_205), at: TerminationLayout.sampledAt)
            file.arm(contextID: context)
        } // deinit unmaps without msync; the dirty page stays in the kernel's cache, as after SIGKILL.
        let record = try TerminationRunRecord(bytes: Data(contentsOf: url))
        XCTAssertEqual(record.launchID, launch); XCTAssertEqual(record.identity, Self.identity)
        XCTAssertEqual(record.appState, .active); XCTAssertEqual(record.memoryWarnings, 3)
        XCTAssertEqual(record.footprintBytes, 1_400_000_000); XCTAssertEqual(record.availableBytes, 40_000_000)
        XCTAssertTrue(record.armed); XCTAssertEqual(record.contextID, context)
        XCTAssertEqual(record.lastSeenAt, Date(timeIntervalSince1970: 1_760_000_205))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testUnsampledMemoryIsUnknownAndDisarmClearsArming() throws {
        let file = try TerminationStateFile.create(at: url)
        file.writeHeader(launchID: UUID(), identity: Self.identity, startedAt: Date(timeIntervalSince1970: 1_760_000_100))
        file.arm(contextID: UUID()); file.disarm()
        let record = try TerminationRunRecord(bytes: Data(contentsOf: url))
        XCTAssertNil(record.footprintBytes); XCTAssertNil(record.availableBytes); XCTAssertNil(record.sampledAt)
        XCTAssertFalse(record.armed); XCTAssertEqual(record.appState, .unknown)
    }
    func testAZeroHeadroomReadingIsKeptDistinctFromUnsampled() throws {
        let file = try TerminationStateFile.create(at: url)
        file.writeHeader(launchID: UUID(), identity: Self.identity, startedAt: Date(timeIntervalSince1970: 1_760_000_100))
        file.store(0, at: TerminationLayout.availableAt)
        XCTAssertEqual(try TerminationRunRecord(bytes: Data(contentsOf: url)).availableBytes, 0)
    }
    func testMemoryWarningAndPressureTimesCountAsLastSeen() throws {
        let file = try TerminationStateFile.create(at: url)
        file.writeHeader(launchID: UUID(), identity: Self.identity, startedAt: Date(timeIntervalSince1970: 1_760_000_100))
        file.store(Date(timeIntervalSince1970: 1_760_000_150), at: TerminationLayout.sampledAt)
        file.store(Date(timeIntervalSince1970: 1_760_000_152), at: TerminationLayout.lastWarningAt)
        XCTAssertEqual(try TerminationRunRecord(bytes: Data(contentsOf: url)).lastSeenAt, Date(timeIntervalSince1970: 1_760_000_152))
        file.store(Date(timeIntervalSince1970: 1_760_000_153), at: TerminationLayout.pressureChangedAt)
        XCTAssertEqual(try TerminationRunRecord(bytes: Data(contentsOf: url)).lastSeenAt, Date(timeIntervalSince1970: 1_760_000_153))
    }
    func testCreateRefusesAnExistingFileAndASymlink() throws {
        _ = try TerminationStateFile.create(at: url)
        XCTAssertThrowsError(try TerminationStateFile.create(at: url))
        let link = directory.appendingPathComponent("link.state")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: directory.appendingPathComponent("target"))
        XCTAssertThrowsError(try TerminationStateFile.create(at: link))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("target").path))
    }
    func testDecodeRejectsWrongSizeMagicAndVersion() throws {
        let file = try TerminationStateFile.create(at: url)
        file.writeHeader(launchID: UUID(), identity: Self.identity, startedAt: Date())
        let good = try Data(contentsOf: url)
        XCTAssertNoThrow(try TerminationRunRecord(bytes: good))
        XCTAssertThrowsError(try TerminationRunRecord(bytes: good.prefix(4095)))
        XCTAssertThrowsError(try TerminationRunRecord(bytes: good + Data([0])))
        var magic = good; magic[0] ^= 0xFF; XCTAssertThrowsError(try TerminationRunRecord(bytes: magic))
        var version = good; version[TerminationLayout.versionAt] = 2; XCTAssertThrowsError(try TerminationRunRecord(bytes: version))
        var state = good; state[TerminationLayout.appStateAt] = 9; XCTAssertThrowsError(try TerminationRunRecord(bytes: state))
        XCTAssertThrowsError(try TerminationRunRecord(bytes: Data(count: TerminationLayout.size)))
    }
    func testDecodeAcceptsASliceWithANonZeroStart() throws {
        let file = try TerminationStateFile.create(at: url)
        file.writeHeader(launchID: UUID(), identity: Self.identity, startedAt: Date())
        let padded = Data([1, 2, 3]) + (try Data(contentsOf: url))
        XCTAssertEqual(try TerminationRunRecord(bytes: padded.dropFirst(3)).identity, Self.identity)
    }
    func testLongVersionTextIsTruncatedOnACharacterBoundary() throws {
        let long = String(repeating: "a", count: 62) + "é" + "tail"   // é straddles byte 63
        let file = try TerminationStateFile.create(at: url)
        file.writeHeader(launchID: UUID(), identity: .init(appVersion: long, appBuild: "1", executableUUID: UUID(), osVersion: "x", bootTime: 1), startedAt: Date())
        XCTAssertEqual(try TerminationRunRecord(bytes: Data(contentsOf: url)).identity.appVersion, String(repeating: "a", count: 62))
    }
    func testSystemReadersReturnPlausibleValues() {
        XCTAssertGreaterThan(TerminationSystem.bootTime(), 0)
        XCTAssertGreaterThan(TerminationSystem.uptimeMs(), 0)
        XCTAssertEqual(TerminationSystem.wallMs(Date(timeIntervalSince1970: 2.25)), 2250)
        XCTAssertEqual(TerminationSystem.wallMs(Date(timeIntervalSince1970: -5)), 0)
        _ = TerminationSystem.debuggerAttached()
        _ = TerminationSystem.executableUUID()
    }
}
