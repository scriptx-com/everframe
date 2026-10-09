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
        let entry = try restored.entry(for: raw)
        let parsed = try ReleaseHealthDate.decoder().decode(EverframeReportEnvelope.self, from: entry.envelopeBytes)
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
    func testFrozenPointerKeepsExactMillisecondStartWithoutLenientFoundationParsing() throws {
        // Before Swift 6.2 Foundation (iOS 15-18), `.iso8601` rejects the fractional
        // seconds that every frozen pointer carries, including whole-second starts.
        let starts = [1_791_421_323.456, 1_791_421_323, Date().timeIntervalSince1970]
        for start in starts.map({ ReleaseHealthDate.canonical(Date(timeIntervalSince1970: $0)) }) {
            let a = pointer().with(startedAt: start)
            let restored = try NativeCrashRecoveryContext.decode(context(a).encoded())
            let exposure = try XCTUnwrap(restored.releaseHealthExposure)
            XCTAssertEqual(exposure.exposureID, a.exposureID); XCTAssertEqual(exposure.startedAt, a.startedAt)
            let raw = try NativeCrashRecordDecoder.decode(NativeRecoveryTestData.raw(context: UUID()), redact: { $0 })
            let json = try JSONSerialization.jsonObject(with: restored.entry(for: raw).envelopeBytes) as! [String: Any]
            let crash = (json["payload"] as! [String: Any])["crash"] as! [String: Any]
            let wire = (crash["native"] as! [String: Any])["releaseHealthEvidence"] as! [String: Any]
            XCTAssertEqual((wire["exposure"] as! [String: Any])["startedAt"] as? String, ReleaseHealthDate.text(start))
        }
    }
    func testMalformedFrozenPointerCannotEnterDurableContext() throws {
        let a = pointer()
        XCTAssertThrowsError(try context(a.with(processLaunchID: "not-a-uuid")))
        XCTAssertThrowsError(try context(a.with(loadedBundleStatus: .known)))
        XCTAssertThrowsError(try context(a.with(nativeBuildID: "")))
    }
    func testForegroundTransitionsRefreshActualFatalContextAndBackgroundCaptureStaysUnlinked() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x64, count: 32), probe = HealthNativeRecorderProbe()
        let entered = expectation(description: "background end blocked"), release = DispatchSemaphore(value: 0), blocked = HealthNativeFlag()
        defer { release.signal() }
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, beforeCommit: {
            if blocked.value { blocked.value = false; entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        let enabled = try await sdk.setReleaseHealth(.init(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable))
        XCTAssertTrue(enabled)
        let first = try XCTUnwrap(health.readyPointer)
        let initial = probe.snapshot(), oldContext = try XCTUnwrap(initial.context)
        let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(initial.path).deletingLastPathComponent().lastPathComponent))
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        let oldBytes = try contexts.readContext(runID: runID, contextID: oldContext)
        blocked.value = true
        let background = sdk.releaseHealthForegroundChanged(false)
        XCTAssertNil(health.readyPointer)
        await fulfillment(of: [entered], timeout: 3)
        await background.value
        let backgroundState = probe.snapshot(); XCTAssertTrue(backgroundState.enabled)
        let unlinked = try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(backgroundState.context)))
        XCTAssertNil(unlinked.releaseHealthExposure)
        release.signal()
        await sdk.releaseHealthForegroundChanged(true).value
        let second = try XCTUnwrap(health.readyPointer); XCTAssertNotEqual(first.exposureID, second.exposureID)
        let reentered = try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(probe.snapshot().context)))
        XCTAssertEqual(reentered.releaseHealthExposure?.exposureID, second.exposureID)
        XCTAssertEqual(try contexts.readContext(runID: runID, contextID: oldContext), oldBytes)
        sdk.kill(); await health.barrier()
        await sdk.releaseHealthForegroundChanged(false).value
        await sdk.releaseHealthForegroundChanged(true).value
        XCTAssertNil(health.readyPointer); XCTAssertFalse(probe.snapshot().enabled)
        _ = await sdk.setReleaseHealth(nil)
    }
    func testMoreThan256ForegroundCyclesKeepCaptureArmedAndRetainReferencedContexts() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x65, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, transport: { _, admission in
            admission({}) ? .settled : .retry
        })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        let enabled = try await sdk.setReleaseHealth(.init(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable))
        XCTAssertTrue(enabled)
        let first = probe.snapshot(), oldContext = try XCTUnwrap(first.context), recorderPath = try XCTUnwrap(first.path)
        let runID = try XCTUnwrap(UUID(uuidString: recorderPath.deletingLastPathComponent().lastPathComponent))
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        let oldBytes = try contexts.readContext(runID: runID, contextID: oldContext)
        let reports = recorderPath.appendingPathComponent("Reports")
        try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let rawPath = reports.appendingPathComponent("Everframe-report-0000000000000001.json")
        let raw = try NativeRecoveryTestData.raw(context: oldContext)
        try raw.write(to: rawPath)
        for cycle in 0..<270 {
            await sdk.releaseHealthForegroundChanged(false).value
            await health.barrier(); await health.flush()
            await sdk.releaseHealthForegroundChanged(true).value
            await health.flush()
            let state = probe.snapshot()
            guard state.enabled else { XCTFail("capture disabled at foreground cycle \(cycle)"); break }
            let current = try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(state.context)))
            let pointer = try XCTUnwrap(health.readyPointer, "durable session missing at cycle \(cycle)")
            XCTAssertEqual(current.releaseHealthExposure?.exposureID, pointer.exposureID)
            XCTAssertTrue(try ReleaseHealthStore(root: root.appendingPathComponent("health"), keyProvider: { key }).pending().isEmpty)
        }
        XCTAssertEqual(try contexts.readContext(runID: runID, contextID: oldContext), oldBytes)
        XCTAssertEqual(try Data(contentsOf: rawPath), raw)
        XCTAssertLessThanOrEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("native/contexts/" + runID.uuidString.lowercased()).path).count, 257)
        sdk.kill(); await health.barrier(); _ = await sdk.setReleaseHealth(nil)
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
        let envelope = try ReleaseHealthDate.decoder().decode(EverframeReportEnvelope.self, from: frozen.entry(for: raw).envelopeBytes)
        XCTAssertEqual(envelope.payload.crash?.native?.releaseHealthEvidence?.exposure.nativeBuildID, "native-a")
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
            publish: { id in self.lock.withLock { self.state.context = id; self.state.enabled = true }; return true },
            retainedContextIdentifiers: { self.lock.withLock {
                self.state.enabled ? nil : Set(self.state.context.map { [$0] } ?? [])
            } })
    }
}
