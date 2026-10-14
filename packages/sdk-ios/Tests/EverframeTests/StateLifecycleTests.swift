// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit
@Suite(.serialized)
struct StateLifecycleTests {
    @Test func automaticVersionUsesHostBundleInsteadOfSdkRelease() throws {
        defer { Everframe.shared.kill() }
        try Everframe.shared.start(config: EverframeConfig(sdkKey: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", release: "sdk-version", capture: CaptureConfig(logs: false)))
        let facts = try #require(Everframe.shared.captureSessionSnapshot().state).initial.automatic
        let release = AppRelease.current(debugBuild: nil)
        #expect(StateSanitizer.equal(facts["app.version"], .string(release.version)))
        #expect(StateSanitizer.equal(facts["app.build"], .string(release.build ?? "unknown")))
    }
    private func start() throws {
        try Everframe.shared.start(config: EverframeConfig(sdkKey: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", capture: CaptureConfig(logs: false)))
    }
    @Test func sessionCaptureIsImmutableAndResetClearsState() throws {
        defer { Everframe.shared.kill() }
        try start()
        #expect(Everframe.shared.setState("plan", value: .string("premium")))
        let captured = try #require(Everframe.shared.captureSessionSnapshot().state)
        #expect(Everframe.shared.clearState("plan"))
        #expect(captured.current.custom["plan"] != nil)
        #expect(Everframe.shared.captureSessionSnapshot().state?.current.custom["plan"] == nil)
        try start()
        #expect(Everframe.shared.captureSessionSnapshot().state?.current.custom.isEmpty == true)
        Everframe.shared.kill()
        #expect(!Everframe.shared.setState("afterKill", value: .bool(true)))
        #expect(Everframe.shared.captureSessionSnapshot().state == nil)
    }
    @Test func capturedStateSurvivesEnvelopeEncoding() throws {
        defer { Everframe.shared.kill() }
        try start()
        _ = Everframe.shared.setState("plan", value: .string("premium"))
        let captured = Everframe.shared.captureSessionSnapshot()
        let encoded = try EnvelopeBuilder().buildEncoded(reportId: UUID(), sdkVersion: "test", state: captured.state)
        let report = try EverframeReportEnvelope(data: encoded.bytes)
        #expect(report.payload.state?.current.custom["plan"] != nil)
        Everframe.shared.setIdentityToken(nil)
        #expect(captured.state == nil)
    }
    @Test func staleAutomaticCallbackIsIgnored() throws {
        defer { Everframe.shared.kill() }
        try start()
        let oldEpoch = Everframe.shared.currentStartEpoch
        try start()
        Everframe.shared.applyAutomaticState(["network.type": .string("from-old-session")], owner: oldEpoch)
        let value = Everframe.shared.captureSessionSnapshot().state?.current.automatic["network.type"]
        #expect(!StateSanitizer.equal(value, .string("from-old-session")))
    }
    #if canImport(UIKit)
    @Test @MainActor func manualReportFreezesStateAtOpen() throws {
        defer { Everframe.shared.kill() }
        try start()
        _ = Everframe.shared.setState("plan", value: .string("free"))
        Everframe.shared.__replayFreeze()
        _ = Everframe.shared.setState("plan", value: .string("premium"))
        let frozen = Everframe.shared.takeFrozenState(epoch: Everframe.shared.currentStartEpoch)
        #expect(StateSanitizer.equal(frozen?.current.custom["plan"], .string("free")))
    }
    #endif
    @Test func automaticUserFactAndIdentityClearing() throws {
        defer { Everframe.shared.kill() }
        try start()
        #expect(Everframe.shared.captureSessionSnapshot().state?.current.automatic["user.status"] != nil)
        _ = Everframe.shared.setState("plan", value: .string("premium"))
        Everframe.shared.applyAutomaticState(["network.type": .string("wifi")], owner: Everframe.shared.currentStartEpoch)
        Everframe.shared.setIdentityToken(nil)
        #expect(StateSanitizer.equal(Everframe.shared.captureSessionSnapshot().state?.current.automatic["network.type"], .string("wifi")))
        #expect(Everframe.shared.captureSessionSnapshot().state?.current.custom.isEmpty == true)
        #expect(Everframe.shared.setState("plan", value: .string("free")))
    }
}
