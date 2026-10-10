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
    func testLifecycleTransitionsWithoutReleaseHealthNeverPauseNativeCapture() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x66, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        let armed = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(armed)
        let before = probe.snapshot()
        // Without an opt-in no session pointer exists, so no transition may close the gate.
        for foreground in [false, true, false, true] {
            let transition = sdk.releaseHealthForegroundChanged(foreground)
            XCTAssertTrue(probe.snapshot().enabled, "capture paused on foreground=\(foreground)")
            await transition.value
            XCTAssertTrue(probe.snapshot().enabled, "capture not rearmed after foreground=\(foreground)")
        }
        let after = probe.snapshot()
        XCTAssertEqual(after.pauses, before.pauses); XCTAssertEqual(after.publications, before.publications)
        XCTAssertEqual(after.context, before.context); XCTAssertNil(health.readyPointer)
    }
    func testForegroundEntryKeepsUnlinkedCaptureArmedUntilTheDurableStartIsSwappedIn() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x67, count: 32), probe = HealthNativeRecorderProbe()
        let entered = expectation(description: "foreground start blocked"), release = DispatchSemaphore(value: 0), blocked = HealthNativeFlag()
        defer { release.signal() }
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, beforeCommit: {
            if blocked.value { blocked.value = false; entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        let enabled = try await sdk.setReleaseHealth(.init(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable))
        XCTAssertTrue(enabled)
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        func armedExposure() throws -> EverframeNativeExposure? {
            let state = probe.snapshot()
            let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(state.path).deletingLastPathComponent().lastPathComponent))
            return try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(state.context))).releaseHealthExposure
        }
        await sdk.releaseHealthForegroundChanged(false).value; await health.barrier()
        XCTAssertTrue(probe.snapshot().enabled); XCTAssertNil(try armedExposure())
        let unlinked = probe.snapshot()
        blocked.value = true
        let foreground = sdk.releaseHealthForegroundChanged(true)
        // The unlinked context stays armed while the new start is not yet durable.
        XCTAssertTrue(probe.snapshot().enabled)
        await fulfillment(of: [entered], timeout: 3)
        let pending = probe.snapshot()
        XCTAssertTrue(pending.enabled); XCTAssertEqual(pending.context, unlinked.context); XCTAssertEqual(pending.pauses, unlinked.pauses)
        release.signal(); await foreground.value
        let pointer = try XCTUnwrap(health.readyPointer)
        XCTAssertTrue(probe.snapshot().enabled); XCTAssertEqual(try armedExposure()?.exposureID, pointer.exposureID)
        sdk.kill(); await health.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testBackgroundCallbackOnMainReturnsWithTheUnlinkedTwinArmed() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x68, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        let enabled = try await sdk.setReleaseHealth(.init(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable))
        XCTAssertTrue(enabled)
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        let linked = probe.snapshot()
        let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(linked.path).deletingLastPathComponent().lastPathComponent))
        func decoded(_ id: UUID?) throws -> NativeCrashRecoveryContext {
            try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(id)))
        }
        XCTAssertNotNil(try decoded(linked.context).releaseHealthExposure)
        // UIKit posts the notification on main; work after it in the same turn is still captured.
        let (transition, returned) = await MainActor.run { () -> (Task<Void, Never>, HealthNativeRecorderProbe.State) in
            let transition = sdk.releaseHealthForegroundChanged(false)
            return (transition, probe.snapshot())
        }
        XCTAssertTrue(returned.enabled); XCTAssertNotEqual(returned.context, linked.context)
        let unlinked = try decoded(returned.context)
        XCTAssertNil(unlinked.releaseHealthExposure)
        XCTAssertEqual(unlinked.envelopeTemplate, try decoded(linked.context).envelopeTemplate)
        await transition.value
        let settled = probe.snapshot()
        XCTAssertTrue(settled.enabled); XCTAssertEqual(settled.context, returned.context)
        XCTAssertEqual(settled.pauses, returned.pauses); XCTAssertEqual(settled.publications, returned.publications)
        // A stored JavaScript fatal closes native capture until the next start; a later
        // background withdrawal must not reopen it with the twin.
        await sdk.releaseHealthForegroundChanged(true).value
        XCTAssertNotNil(try decoded(probe.snapshot().context).releaseHealthExposure)
        sdk.closeNativeCrashCaptureAfterAcceptedFatal()
        let (closing, closed) = await MainActor.run { () -> (Task<Void, Never>, HealthNativeRecorderProbe.State) in
            (sdk.releaseHealthForegroundChanged(false), probe.snapshot())
        }
        await closing.value
        XCTAssertFalse(closed.enabled); XCTAssertFalse(probe.snapshot().enabled)
        sdk.kill(); await health.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testIdenticalConfigureWithoutReleaseHealthNeverPausesNativeCapture() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x69, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        let config = EverframeConfig(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false))
        let first = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: nil))
        _ = await first()
        let armed = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(armed)
        let before = probe.snapshot(), epoch = sdk.currentStartEpoch
        // A remounted React Native provider repeats its configuration. Without a session
        // pointer nothing is withdrawn, so neither the call nor its deferred work may close the gate.
        let again = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: nil))
        let returned = probe.snapshot()
        XCTAssertEqual(sdk.currentStartEpoch, epoch)
        XCTAssertTrue(returned.enabled, "identical configure paused capture"); XCTAssertEqual(returned.pauses, before.pauses)
        let erased = await again(); XCTAssertTrue(erased)
        let after = probe.snapshot()
        XCTAssertTrue(after.enabled); XCTAssertEqual(after.pauses, before.pauses)
        XCTAssertEqual(after.publications, before.publications); XCTAssertEqual(after.context, before.context)
        XCTAssertNil(health.readyPointer)
    }
    func testIdenticalConfigureWithUnchangedReleaseHealthKeepsTheLinkedContextArmed() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x6a, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        let config = EverframeConfig(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false))
        let settings = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: "bundle", loadedBundleStatus: .known)
        let first = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: settings))
        let enabled = await first(); XCTAssertTrue(enabled)
        let pointer = try XCTUnwrap(health.readyPointer)
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        let linked = probe.snapshot()
        let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(linked.path).deletingLastPathComponent().lastPathComponent))
        func decoded(_ id: UUID?) throws -> NativeCrashRecoveryContext {
            try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(id)))
        }
        XCTAssertTrue(linked.enabled); XCTAssertEqual(try decoded(linked.context).releaseHealthExposure?.exposureID, pointer.exposureID)
        // The same pointer stays ready, so the context that carries it stays armed throughout.
        let same = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: settings))
        let returned = probe.snapshot()
        XCTAssertTrue(returned.enabled, "identical configure paused capture")
        XCTAssertEqual(returned.context, linked.context); XCTAssertEqual(returned.pauses, linked.pauses)
        let still = await same(); XCTAssertTrue(still)
        let after = probe.snapshot()
        XCTAssertEqual(health.readyPointer?.exposureID, pointer.exposureID)
        XCTAssertTrue(after.enabled); XCTAssertEqual(after.context, linked.context)
        XCTAssertEqual(after.pauses, linked.pauses); XCTAssertEqual(after.publications, linked.publications)
        // Its pointer-free twin stays published too: a background callback before the
        // deferred work finishes still rearms capture at once.
        let again = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: settings))
        let (transition, background) = await MainActor.run { () -> (Task<Void, Never>, HealthNativeRecorderProbe.State) in
            (sdk.releaseHealthForegroundChanged(false), probe.snapshot())
        }
        XCTAssertTrue(background.enabled, "background after an identical configure left capture closed")
        XCTAssertNil(try decoded(background.context).releaseHealthExposure)
        await transition.value
        let backgrounded = await again(); XCTAssertFalse(backgrounded)
        let settled = probe.snapshot()
        XCTAssertTrue(settled.enabled); XCTAssertEqual(settled.context, background.context); XCTAssertNil(health.readyPointer)
        sdk.kill(); await health.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testConfigureThatWithdrawsTheReadyPointerRetiresItsNativeContext() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x6b, count: 32), probe = HealthNativeRecorderProbe()
        let native = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let health = ReleaseHealthRuntime(root: root.appendingPathComponent("health"), keyProvider: { key }, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: native, appleDiagnosticRuntime: nil, releaseHealthRuntime: health)
        defer { sdk.kill() }
        let config = EverframeConfig(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false))
        func settings(_ user: String) throws -> ReleaseHealthConfiguration {
            try .init(nativeBuildId: "native", loadedBuildId: "bundle", loadedBundleStatus: .known, userId: user)
        }
        let first = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: settings("opaque-a")))
        let enabled = await first(); XCTAssertTrue(enabled)
        let a = try XCTUnwrap(health.readyPointer)
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(probe.snapshot().path).deletingLastPathComponent().lastPathComponent))
        func armedExposure(_ state: HealthNativeRecorderProbe.State) throws -> EverframeNativeExposure? {
            guard state.enabled else { return nil }
            return try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(state.context))).releaseHealthExposure
        }
        XCTAssertEqual(try armedExposure(probe.snapshot())?.exposureID, a.exposureID)
        // A new user ID ends the session before configure returns. On main its pointer-free
        // twin is armed at once; the deferred work then links the replacement session.
        let rotatedSettings = try settings("opaque-b")
        let rotated = try await MainActor.run { try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: rotatedSettings)) }
        let withdrawn = probe.snapshot()
        XCTAssertNil(health.readyPointer)
        XCTAssertTrue(withdrawn.enabled, "the withdrawn pointer's twin was not armed"); XCTAssertNil(try armedExposure(withdrawn))
        let replaced = await rotated(); XCTAssertTrue(replaced)
        let b = try XCTUnwrap(health.readyPointer); XCTAssertNotEqual(a.exposureID, b.exposureID)
        XCTAssertEqual(try armedExposure(probe.snapshot())?.exposureID, b.exposureID)
        // Disabling from the bridge's thread withdraws the pointer before returning, erases
        // the journal and rearms capture without a pointer.
        let disable = try await Task.detached { try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config, health: nil)) }.value
        XCTAssertNil(health.readyPointer); XCTAssertNil(try armedExposure(probe.snapshot()))
        let erased = await disable(); XCTAssertTrue(erased)
        let disabled = probe.snapshot()
        XCTAssertTrue(disabled.enabled); XCTAssertNil(try armedExposure(disabled)); XCTAssertNil(health.readyPointer)
        XCTAssertTrue(try ReleaseHealthStore(root: root.appendingPathComponent("health"), keyProvider: { key }).pending().isEmpty)
        sdk.kill(); await health.barrier(); _ = await sdk.setReleaseHealth(nil)
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
            // On main, as UIKit delivers it: the unlinked twin must be armed and still on disk.
            let (background, unlinked) = await MainActor.run { () -> (Task<Void, Never>, HealthNativeRecorderProbe.State) in
                (sdk.releaseHealthForegroundChanged(false), probe.snapshot())
            }
            await background.value
            guard unlinked.enabled else { XCTFail("capture disabled by background at cycle \(cycle)"); break }
            XCTAssertNil(try NativeCrashRecoveryContext.decode(contexts.readContext(runID: runID, contextID: XCTUnwrap(unlinked.context))).releaseHealthExposure)
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
    /// `pauses` counts enabled-to-disabled transitions, the windows without capture.
    struct State { var path: URL?; var context: UUID?; var enabled = false; var pauses = 0; var publications = 0 }
    private let lock = NSLock(); private var state = State()
    func snapshot() -> State { lock.withLock { state } }
    var adapter: NativeCrashRuntime.Recorder {
        .init(install: { path in self.lock.withLock { self.state.path = path }; return true },
            disable: { self.lock.withLock { if self.state.enabled { self.state.pauses += 1 }; self.state.enabled = false } },
            publish: { id in self.lock.withLock { self.state.context = id; self.state.enabled = true; self.state.publications += 1 }; return true },
            retainedContextIdentifiers: { self.lock.withLock {
                self.state.enabled ? nil : Set(self.state.context.map { [$0] } ?? [])
            } })
    }
}
