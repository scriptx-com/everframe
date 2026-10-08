// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class NativeCrashStartupTests: XCTestCase {
    private let device = DeviceMetadata(model: "iPhone", osName: "iOS", osVersion: "26.5", locale: "en_US", timezone: "UTC",
        appVersion: "1.2.3", appBuild: "42", bundleIdentifier: "dev.example.host")
    func testTemplateIsDeterministicAndKeepsDeclaredIdentityVerbatim() throws {
        // Other report paths send the declared user and app/device identity as
        // given. Masked ids/emails would merge people or overwrite stored emails.
        let config = EverframeConfig(appId: "sdk-A", release: "release-secret", redaction: .init(customPatterns: [
            try NSRegularExpression(pattern: "secret"), try NSRegularExpression(pattern: "[a-z]+@example\\.com")]))
        let user = EFUser(id: "4111111111111111", email: "alice@example.com", displayName: "secret")
        let host = DeviceMetadata(model: "iPhone", osName: "iOS", osVersion: "26.5", locale: "en_US", timezone: "UTC",
            appVersion: "1.2.3", appBuild: "42", bundleIdentifier: "io.mycompanyname.customerportal.production")
        let context = try NativeCrashStartupContext.make(config: config, user: user, device: host, endpoint: "https://example.invalid")
        let again = try NativeCrashStartupContext.make(config: config, user: user, device: host, endpoint: "https://example.invalid")
        XCTAssertEqual(try context.encoded(), try again.encoded())
        XCTAssertEqual(context.sdkKey, "sdk-A"); XCTAssertNil(context.identitySubject)
        let envelope = try EverframeReportEnvelope(data: context.envelopeTemplate)
        XCTAssertEqual(envelope.reporter.user?.id, "4111111111111111")
        XCTAssertEqual(envelope.reporter.user?.email, "alice@example.com")
        XCTAssertEqual(envelope.reporter.user?.displayName, "secret")
        XCTAssertEqual(envelope.context.app.name, "io.mycompanyname.customerportal.production")
        XCTAssertEqual(envelope.context.app.version, "release-secret")
        // The frozen policy still redacts the recovered crash record's strings.
        XCTAssertEqual(try context.redaction.compiled()("crash secret"), "crash [REDACTED]")
        XCTAssertEqual(envelope.context.app.build, "42"); XCTAssertEqual(envelope.context.device.model, "iPhone")
        XCTAssertTrue(envelope.attachments.isEmpty); XCTAssertNil(envelope.sessionID)
        XCTAssertNil(envelope.payload.breadcrumbs); XCTAssertNil(envelope.payload.vitals)
        XCTAssertNil(envelope.payload.resources); XCTAssertNil(envelope.payload.crash)
    }
    func testAnonymousContextDoesNotInventUserAndUsesOriginalAppVersion() throws {
        let context = try NativeCrashStartupContext.make(config: .init(appId: "sdk-A"), user: nil, device: device, endpoint: "https://example.invalid")
        let envelope = try EverframeReportEnvelope(data: context.envelopeTemplate)
        XCTAssertNil(envelope.reporter.user); XCTAssertEqual(envelope.context.app.version, "1.2.3")
        XCTAssertNil(context.identitySubject)
    }
    func testNormalBreadcrumbInstallationDoesNotReplaceProcessFatalHandler() {
        // This local sentinel detects the install side effect even if another
        // test previously exercised the legacy adapter's direct installation.
        let old = NSGetUncaughtExceptionHandler()
        defer { NSSetUncaughtExceptionHandler(old) }
        NSSetUncaughtExceptionHandler(nil)
        BreadcrumbAdapters.install()
        XCTAssertNil(NSGetUncaughtExceptionHandler())
    }
    func testLaunchWaitsForRecoveryWhenUserChangesDuringDeviceSnapshot() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let key = Data(repeating: 0x47, count: 32)
        let native = root.appendingPathComponent("native")
        let store = try NativeCrashRecovery(rootURL: native, activeRunIDs: [], keyProvider: { key })
        let old = try store.prepareRun()
        let context = try store.writeContext(NativeRecoveryTestData.context(), runID: old.id)
        let reports = old.recorderURL.appendingPathComponent("Reports")
        try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let reportID = UUID(), raw = reports.appendingPathComponent("Everframe-report-0000000000000001.json")
        try NativeRecoveryTestData.raw(context: context, report: reportID).write(to: raw)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: raw.path)
        let box = JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key })
        let probe = NativeStartupRecorderProbe()
        let runtime = NativeCrashRuntime(rootURL: native, outbox: box, recorder: probe.adapter, keyProvider: { key })
        let first = expectation(description: "launch snapshot"), second = expectation(description: "user snapshot")
        let gate = NativeStartupSnapshotGate(device: device, entered: [first, second])
        let sdk = Everframe(nativeCrashRuntime: runtime, nativeDeviceSnapshot: { await gate.snapshot() })
        defer {
            sdk.kill(); gate.releaseAll(); Everframe.__beforeLaunchDrainHookForTesting = nil
            try? FileManager.default.removeItem(at: root)
        }
        let tail = expectation(description: "launch drain about to start")
        // Runs before the drain reads its queue, not after it returns.
        Everframe.__beforeLaunchDrainHookForTesting = { instance in
            guard instance === sdk else { return }
            XCTAssertEqual(try? box.hydrate().map(\.reportId), [reportID], "recovery must finish before the launch drain")
            XCTAssertTrue(probe.snapshot().enabled)
            tail.fulfill()
        }
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        await fulfillment(of: [first], timeout: 5)
        sdk.setUser(.init(id: "user-B"))
        await fulfillment(of: [second], timeout: 5)
        // Only release the obsolete launch snapshot. The independent setUser
        // refresh stays parked, so the launch must itself retry current state.
        gate.release(0)
        await fulfillment(of: [tail], timeout: 5)
    }
    func testNormalLifecyclePublishesMatchingOwnerAndDisablesImmediately() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let probe = NativeStartupRecorderProbe()
        let key = Data(repeating: 0x47, count: 32)
        let runtime = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let sdk = Everframe(nativeCrashRuntime: runtime)
        defer { sdk.kill() }
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        sdk.setUser(.init(id: "user-A"))
        let armedA = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(armedA)
        let store = try NativeCrashContextStore(rootURL: root.appendingPathComponent("native/contexts"), keyProvider: { key })
        func current() throws -> NativeCrashRecoveryContext {
            let value = probe.snapshot()
            let run = try XCTUnwrap(UUID(uuidString: XCTUnwrap(value.path).deletingLastPathComponent().lastPathComponent))
            return try NativeCrashRecoveryContext.decode(store.readContext(runID: run, contextID: XCTUnwrap(value.context)))
        }
        XCTAssertEqual(try current().sdkKey, "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertEqual(try EverframeReportEnvelope(data: current().envelopeTemplate).reporter.user?.id, "user-A")
        // Change while the worker is occupied: synchronous state transition
        // must disable before the asynchronous new context can publish.
        let entered = expectation(description: "worker occupied"), release = DispatchSemaphore(value: 0)
        let occupying = Task { await runtime.refresh(ticket: runtime.invalidate(), context: {
            entered.fulfill(); _ = release.wait(timeout: .now() + 5); return nil
        }) }
        await fulfillment(of: [entered], timeout: 5)
        sdk.setUser(.init(id: "user-B"))
        XCTAssertFalse(probe.snapshot().enabled)
        release.signal(); _ = await occupying.value
        let armedB = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(armedB)
        XCTAssertEqual(try EverframeReportEnvelope(data: current().envelopeTemplate).reporter.user?.id, "user-B")
        try sdk.start(config: .init(appId: "evf_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", capture: .init(logs: false)))
        let newProject = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(newProject); XCTAssertEqual(try current().sdkKey, "evf_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        XCTAssertNil(try EverframeReportEnvelope(data: current().envelopeTemplate).reporter.user)
        sdk.kill(); XCTAssertFalse(probe.snapshot().enabled)
        let killed = await sdk.refreshNativeCrashContext()
        XCTAssertFalse(killed)
        try sdk.start(config: .init(appId: "evf_live_cccccccccccccccccccccccccccccccc", capture: .init(logs: false, crash: false)))
        let disabled = await sdk.refreshNativeCrashContext()
        XCTAssertFalse(disabled); XCTAssertFalse(probe.snapshot().enabled)
        XCTAssertEqual(probe.snapshot().installs, 1)
    }
    func testRecorderReceivesCanonicalSpellingOfFoundationRunDirectory() throws {
        // Like a device container (/var -> /private/var), macOS temporary storage
        // is reported by Foundation without the /private prefix realpath(3) adds.
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let key = Data(repeating: 0x47, count: 32)
        let run = try NativeCrashRecovery(rootURL: root.appendingPathComponent("native"), activeRunIDs: [], keyProvider: { key }).prepareRun()
        let resolved = try XCTUnwrap(realpath(run.recorderURL.path, nil))
        defer { free(resolved) }
        let canonical = String(cString: resolved)
        XCTAssertNotEqual(run.recorderURL.path, canonical, "fixture must use an aliased container path")
        XCTAssertEqual(NativeCrashRecorderAdapter.recorderDirectory(run.recorderURL), canonical)
    }
    func testAcceptedFatalJavaScriptCrashClosesNativeCaptureUntilNextStart() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let probe = NativeStartupRecorderProbe()
        let key = Data(repeating: 0x47, count: 32)
        let runtime = NativeCrashRuntime(rootURL: root.appendingPathComponent("native"),
            outbox: JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { key }), recorder: probe.adapter, keyProvider: { key })
        let sdk = Everframe(nativeCrashRuntime: runtime)
        CrashReporter.__closeNativeCaptureForTesting = { sdk.closeNativeCrashCaptureAfterAcceptedFatal() }
        CrashReporter.__scheduleDrainForTesting = { _ in }
        defer {
            sdk.kill(); CrashReporter.__closeNativeCaptureForTesting = nil; CrashReporter.__scheduleDrainForTesting = nil
            try? FileManager.default.removeItem(at: root)
        }
        let config = EverframeConfig(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false))
        try sdk.start(config: config)
        let armed = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(armed)
        let reports = JSONLOutbox(fileURL: root.appendingPathComponent("reports"), keyProvider: { key })
        XCTAssertTrue(CrashReporter.captureFacts(json: #"{"exceptionType":"TypeError","fatal":false}"#, outbox: reports, config: config))
        XCTAssertTrue(probe.snapshot().enabled, "a surviving runtime keeps native capture")
        // React Native aborts through RCTFatalException after its JS fatal is stored.
        XCTAssertTrue(CrashReporter.captureFacts(json: #"{"exceptionType":"TypeError","fatal":true}"#, outbox: reports, config: config))
        XCTAssertFalse(probe.snapshot().enabled, "the host abort must not become a second native crash")
        sdk.setUser(.init(id: "user-B"))
        let rearmed = await sdk.refreshNativeCrashContext()
        XCTAssertFalse(rearmed); XCTAssertFalse(probe.snapshot().enabled)
        try sdk.start(config: config)
        let restarted = await sdk.refreshNativeCrashContext()
        XCTAssertTrue(restarted); XCTAssertTrue(probe.snapshot().enabled)
        XCTAssertEqual(try reports.hydrate().count, 2)
    }
}

private final class NativeStartupRecorderProbe: @unchecked Sendable {
    struct State { var path: URL?; var context: UUID?; var enabled = false; var installs = 0 }
    private let lock = NSLock()
    private var state = State()
    func snapshot() -> State { lock.withLock { state } }
    var adapter: NativeCrashRuntime.Recorder {
        .init(install: { path in self.lock.withLock { self.state.path = path; self.state.installs += 1 }; return true },
            disable: { self.lock.withLock { self.state.enabled = false } },
            publish: { context in self.lock.withLock { self.state.context = context; self.state.enabled = true }; return true })
    }
}

private final class NativeStartupSnapshotGate: @unchecked Sendable {
    let device: DeviceMetadata
    let entered: [XCTestExpectation]
    private let lock = NSLock()
    private var calls = 0
    private var waiting: [Int: CheckedContinuation<DeviceMetadata, Never>] = [:]
    init(device: DeviceMetadata, entered: [XCTestExpectation]) { self.device = device; self.entered = entered }
    func snapshot() async -> DeviceMetadata {
        await withCheckedContinuation { continuation in
            let index = lock.withLock { () -> Int in
                let index = calls; calls += 1
                if index < entered.count { waiting[index] = continuation }
                return index
            }
            if index < entered.count { entered[index].fulfill() }
            else { continuation.resume(returning: device) }
        }
    }
    func release(_ index: Int) { lock.withLock { waiting.removeValue(forKey: index) }?.resume(returning: device) }
    func releaseAll() { for index in entered.indices { release(index) } }
}

import Testing
@Suite(.serialized)
struct NativeCrashStartupIsolationTests {
    @Test func nativeRecorderIsNotCreatedBySwiftTestingRunner() {
        #expect(NativeCrashRecorderAdapter.makeRuntime() == nil)
    }
}

extension NativeCrashStartupIsolationTests {
    @Test func defaultOutboxCannotDrainApplicationStorageFromSwiftTesting() throws {
        // Observe the real default instance without adding a product API or
        // writing a test record into what may be an application's queue.
        let box = JSONLOutbox()
        let destination = try #require(Mirror(reflecting: box).children.first(where: { $0.label == "fileURL" })?.value as? URL)
        #expect(destination.standardizedFileURL.path.hasPrefix(FileManager.default.temporaryDirectory.standardizedFileURL.path + "/"))
    }
}
