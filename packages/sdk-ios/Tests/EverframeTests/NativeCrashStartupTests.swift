// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class NativeCrashStartupTests: XCTestCase {
    private let device = DeviceMetadata(model: "iPhone", osName: "iOS", osVersion: "26.5", locale: "en_US", timezone: "UTC",
        appVersion: "1.2.3", appBuild: "42", bundleIdentifier: "dev.example.host")
    func testTemplateIsDeterministicAndRedactsEveryPersistedString() throws {
        let config = EverframeConfig(appId: "sdk-A", release: "release-secret", redaction: .init(customPatterns: [try NSRegularExpression(pattern: "secret")]))
        let user = EFUser(id: "user-secret", email: "secret@example.invalid", displayName: "secret")
        let context = try NativeCrashStartupContext.make(config: config, user: user, device: device, endpoint: "https://example.invalid")
        let again = try NativeCrashStartupContext.make(config: config, user: user, device: device, endpoint: "https://example.invalid")
        XCTAssertEqual(try context.encoded(), try again.encoded())
        XCTAssertEqual(context.sdkKey, "sdk-A"); XCTAssertNil(context.identitySubject)
        let envelope = try EverframeReportEnvelope(data: context.envelopeTemplate)
        XCTAssertEqual(envelope.reporter.user?.id, "user-[REDACTED]")
        XCTAssertEqual(envelope.reporter.user?.displayName, "[REDACTED]")
        XCTAssertFalse(envelope.reporter.user?.email?.contains("secret") ?? true)
        XCTAssertEqual(envelope.context.app.version, "release-[REDACTED]")
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
