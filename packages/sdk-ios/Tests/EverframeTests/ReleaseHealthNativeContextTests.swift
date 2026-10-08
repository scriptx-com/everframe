// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class ReleaseHealthNativeContextTests: XCTestCase {
    private func pointer(build: String = "native-a") -> EverframeNativeExposure {
        .init(exposureID: UUID().uuidString.lowercased(), loadedBuildID: nil, loadedBundleStatus: .notApplicable,
            nativeBuildID: build, processLaunchID: UUID().uuidString.lowercased(), startedAt: Date(timeIntervalSince1970: 1791421323.456))
    }
    private func context(_ pointer: EverframeNativeExposure?) throws -> NativeCrashRecoveryContext {
        let old = try NativeRecoveryTestData.context()
        return try NativeCrashRecoveryContext(sdkKey: old.sdkKey, endpoint: old.endpoint, identitySubject: nil,
            envelopeTemplate: old.envelopeTemplate, redaction: old.redaction, releaseHealthExposure: pointer)
    }
    func testLegacyContextHasNoInventedExposure() throws {
        let old = try NativeRecoveryTestData.context(), restored = try NativeCrashRecoveryContext.decode(old.encoded())
        XCTAssertNil(restored.releaseHealthExposure)
        let raw = try NativeCrashRecordDecoder.decode(NativeRecoveryTestData.raw(context: UUID()), redact: { $0 })
        XCTAssertNil(try EverframeReportEnvelope(data: restored.entry(for: raw).envelopeBytes).payload.crash?.native?.releaseHealthEvidence)
    }
    func testFrozenPointerSurvivesNewLaunchAndMaintainsExactWireIdentity() throws {
        let a = pointer(), original = try context(a), contextID = UUID()
        _ = try context(pointer(build: "native-b"))
        let restored = try NativeCrashRecoveryContext.decode(original.encoded())
        let raw = try NativeCrashRecordDecoder.decode(NativeRecoveryTestData.raw(context: contextID), redact: { $0 })
        let entry = try restored.entry(for: raw), parsed = try EverframeReportEnvelope(data: entry.envelopeBytes)
        let evidence = try XCTUnwrap(parsed.payload.crash?.native?.releaseHealthEvidence)
        XCTAssertEqual(evidence.contextID, contextID.uuidString.lowercased()); XCTAssertEqual(evidence.exposure.exposureID, a.exposureID)
        XCTAssertEqual(evidence.exposure.nativeBuildID, "native-a"); XCTAssertEqual(evidence.attribution, .immutableFatalContext)
        let json = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        let payload = json["payload"] as! [String: Any], crash = payload["crash"] as! [String: Any]
        let native = crash["native"] as! [String: Any], wire = native["releaseHealthEvidence"] as! [String: Any]
        let exposure = wire["exposure"] as! [String: Any]
        XCTAssertEqual(exposure["startedAt"] as? String, "2026-10-08T01:02:03.456Z"); XCTAssertTrue(exposure["loadedBuildId"] is NSNull)
        XCTAssertEqual(try restored.entry(for: raw).envelopeBytes, entry.envelopeBytes)
    }
    func testMalformedFrozenPointerCannotEnterDurableContext() throws {
        let a = pointer()
        XCTAssertThrowsError(try context(a.with(processLaunchID: "not-a-uuid")))
        XCTAssertThrowsError(try context(a.with(loadedBundleStatus: .known)))
        XCTAssertThrowsError(try context(a.with(nativeBuildID: "")))
    }
    func testHealthRevocationClosesNewNativeAdmissionBeforeDiskAndKeepsAdmittedContext() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x74, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let entered = expectation(description: "health erasure blocked"), release = DispatchSemaphore(value: 0), blocked = HealthNativeFlag()
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, beforeCommit: {
            if blocked.value { blocked.value = false; entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        let enabled = try await sdk.setReleaseHealth(.init(nativeBuildId: "native-a", loadedBuildId: nil, loadedBundleStatus: .notApplicable))
        XCTAssertTrue(enabled)
        let admitted = probe.snapshot(), contextID = try XCTUnwrap(admitted.context)
        let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(admitted.path).deletingLastPathComponent().lastPathComponent))
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        let before = try contexts.readContext(runID: runID, contextID: contextID)
        let frozen = try NativeCrashRecoveryContext.decode(before)
        XCTAssertEqual(frozen.releaseHealthExposure?.nativeBuildID, "native-a")
        blocked.value = true
        let disable = Task { await sdk.setReleaseHealth(nil) }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertNil(health.readyPointer)
        // A concurrent SDK startup tail may already rearm independent native
        // capture. Any such NEW admission must be unlinked while health erases.
        let duringErase = probe.snapshot()
        if duringErase.enabled {
            let current = try XCTUnwrap(duringErase.context)
            XCTAssertNil(try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: current)).releaseHealthExposure)
        }
        release.signal(); let erased = await disable.value; XCTAssertTrue(erased)
        let currentID = try XCTUnwrap(probe.snapshot().context)
        XCTAssertNil(try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: currentID)).releaseHealthExposure)
        XCTAssertEqual(try contexts.readContext(runID: runID, contextID: contextID), before)
        let raw = try NativeCrashRecordDecoder.decode(NativeRecoveryTestData.raw(context: contextID), redact: { $0 })
        XCTAssertEqual(try EverframeReportEnvelope(data: frozen.entry(for: raw).envelopeBytes).payload.crash?.native?.releaseHealthEvidence?.exposure.nativeBuildID, "native-a")
        sdk.kill(); await health.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
}

private final class HealthNativeFlag: @unchecked Sendable {
    private let lock = NSLock(); private var flag = false
    var value: Bool { get { lock.withLock { flag } } set { lock.withLock { flag = newValue } } }
}
private final class HealthNativeRecorderProbe: @unchecked Sendable {
    struct State { var path: URL?; var context: UUID?; var enabled = false }
    private let lock = NSLock(); private var state = State()
    func snapshot() -> State { lock.withLock { state } }
    var adapter: NativeCrashRuntime.Recorder {
        .init(install: { path in self.lock.withLock { self.state.path = path }; return true },
            disable: { self.lock.withLock { self.state.enabled = false } },
            publish: { id in self.lock.withLock { self.state.context = id; self.state.enabled = true }; return true })
    }
}
