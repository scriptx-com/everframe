// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation
@testable import EverframeKit
import XCTest

final class RNDetailsDeliveryTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        CrashReporter.__scheduleDrainForTesting = { _ in }
        Everframe.shared.kill()
        Everframe.shared.setIdentityToken(nil)
        Everframe.shared.__replayConfigOverrideForTesting = nil
        Everframe.__setConfigForTesting(nil)
        Everframe.captureGate = true
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-rn-details-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        CrashReporter.__scheduleDrainForTesting = nil
        Everframe.shared.setUser(nil)
        Everframe.shared._identityHolder.set(nil)
        Everframe.shared._identityEnabledFlag.set(false)
        Everframe.shared.setIdentityToken(nil)
        Everframe.shared.__replayConfigOverrideForTesting = nil
        Everframe.__setConfigForTesting(nil)
        Everframe.captureGate = false
        try FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func outbox(_ name: String = "outbox.jsonl") -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent(name))
    }

    private func envelope(_ entry: OutboxEntry) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any])
    }

    private func crash(_ entry: OutboxEntry) throws -> [String: Any] {
        let payload = try XCTUnwrap(try envelope(entry)["payload"] as? [String: Any])
        return try XCTUnwrap(payload["crash"] as? [String: Any])
    }

    func testPublicFactsPreserveAbsenceAndIsolateInvalidOptionalDetails() throws {
        let config = EverframeConfig(appId: "rn-details-app")
        let legacy = outbox("legacy.jsonl")
        XCTAssertTrue(CrashReporter.captureHandledFacts(
            json: #"{"exceptionType":"Legacy"}"#,
            sdkName: "everframe-react-native", outbox: legacy, config: config
        ))
        XCTAssertNil(try crash(XCTUnwrap(try legacy.hydrate().first))["details"])

        for (index, value) in ["null", "42", "[]"].enumerated() {
            let invalid = outbox("invalid-\(index).jsonl")
            XCTAssertTrue(CrashReporter.captureHandledFacts(
                json: "{\"exceptionType\":\"Invalid\",\"details\":\(value)}",
                sdkName: "everframe-react-native", outbox: invalid, config: config
            ))
            let saved = try crash(XCTUnwrap(try invalid.hydrate().first))
            XCTAssertEqual(saved["details"] as? NSDictionary,
                           ["severity": "error", "truncated": true] as NSDictionary)
        }
    }

    func testHandledAndAutomaticFactsPersistOwnedDetailsAndEntryIdentity() throws {
        Everframe.__setConfigForTesting(EverframeConfig(appId: "entry-session-app"))
        Everframe.captureGate = true
        Everframe.shared.setUser(EFUser(id: "session-user"))
        let handled = outbox("handled.jsonl")
        let automatic = outbox("automatic.jsonl")
        let json = #"{"exceptionType":"RNError","fatal":true,"details":{"severity":"warning","context":"checkout","metadata":{"password":"private","attempt":2}},"jsBundle":{"engine":"hermes","platform":"ios","buildId":" js-build ","bundleName":"index.bundle"}}"#

        XCTAssertTrue(CrashReporter.captureHandledFacts(
            json: json, sdkName: "everframe-react-native", outbox: handled
        ))
        XCTAssertTrue(CrashReporter.captureFacts(
            json: json, sdkName: "everframe-react-native", outbox: automatic
        ))

        for (entry, isHandled) in [
            (try XCTUnwrap(try handled.hydrate().first), true),
            (try XCTUnwrap(try automatic.hydrate().first), false),
        ] {
            XCTAssertEqual(entry.sdkKey, "entry-session-app")
            XCTAssertEqual(entry.endpoint, "http://127.0.0.1:9")
            let savedEnvelope = try envelope(entry)
            XCTAssertEqual((savedEnvelope["sdk"] as? [String: Any])?["name"] as? String,
                           "everframe-react-native")
            XCTAssertEqual(((savedEnvelope["reporter"] as? [String: Any])?["user"] as? [String: Any])?["id"] as? String,
                           "session-user")
            let savedCrash = try crash(entry)
            XCTAssertEqual(savedCrash["handled"] as? Bool, isHandled)
            XCTAssertEqual(savedCrash["fatal"] as? Bool, isHandled ? false : true)
            XCTAssertEqual(savedCrash["jsBundle"] as? NSDictionary,
                           ["engine": "hermes", "platform": "ios", "buildId": " js-build ", "bundleName": "index.bundle"] as NSDictionary)
            XCTAssertEqual(savedCrash["details"] as? NSDictionary, [
                "severity": "warning", "context": "checkout",
                "metadata": ["password": "[REDACTED]", "attempt": 2],
            ] as NSDictionary)
            let stored = try Data(contentsOf: isHandled ? handled.resolvedFileURL : automatic.resolvedFileURL)
            XCTAssertEqual(String(decoding: stored.prefix(8), as: UTF8.self), "EVRBOX01")
            XCTAssertNil(stored.range(of: Data("private".utf8)))
        }
    }

    func testLifecycleAndConfigurationRefusalsDoNotPersistDetails() throws {
        let target = outbox()
        let json = #"{"exceptionType":"RNError","details":{"metadata":{"good":1}}}"#
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: json, outbox: target))
        XCTAssertFalse(CrashReporter.captureHandledFacts(
            json: json, outbox: target,
            config: EverframeConfig(appId: "app", capture: CaptureConfig(crash: false))
        ))
        Everframe.__setConfigForTesting(EverframeConfig(appId: "app"))
        Everframe.captureGate = true
        CrashReporter.__afterUserSnapshotHookForTesting = { Everframe.shared.kill() }
        defer { CrashReporter.__afterUserSnapshotHookForTesting = nil }
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: json, outbox: target))
        XCTAssertEqual(try target.hydrate().count, 0)
    }

    func testPublicFactsRetryByteIdenticalDetailsAndOriginalHeadersAfter503() async throws {
        let appId = "rn-details-retry-app"
        let identitySubject = "rn-details-retry-user"
        let token = jwt(sub: identitySubject, exp: Date().addingTimeInterval(300))
        let identityConfig = await enabledIdentityConfig(appId: appId)
        Everframe.__setConfigForTesting(EverframeConfig(appId: appId))
        Everframe.shared.__replayConfigOverrideForTesting = identityConfig
        Everframe.shared.setIdentityToken(.token(token))
        let persisted = outbox("retry.jsonl")
        let marker = "rn-facts-503-original"

        XCTAssertTrue(CrashReporter.captureHandledFacts(
            json: """
            {"exceptionType":"RNRetry","details":{"severity":"warning",\
            "context":"retry","metadata":{"marker":"\(marker)"}}}
            """,
            sdkName: "everframe-react-native", outbox: persisted
        ))
        let reopened = outbox("retry.jsonl")
        let accepted = try XCTUnwrap(try reopened.hydrate().first)
        XCTAssertEqual(accepted.sdkKey, appId)
        XCTAssertEqual(accepted.identitySubject, identitySubject)
        XCTAssertTrue(String(decoding: accepted.envelopeBytes, as: UTF8.self).contains(marker))

        let firstEntered = expectation(description: "RN facts 503 entered")
        let secondEntered = expectation(description: "RN facts retry accepted")
        let first = HandledDetailsHTTPAttempt(status: 503, entered: firstEntered)
        let second = HandledDetailsHTTPAttempt(status: 202, entered: secondEntered)
        HandledDetailsURLProtocol.prepare([first, second])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HandledDetailsURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer {
            HandledDetailsURLProtocol.releaseAll()
            session.invalidateAndCancel()
        }
        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: appId), outbox: reopened, session: session
        )
        let epoch = Everframe.shared.currentStartEpoch
        let identityHolder = Everframe.shared._identityHolder
        let firstDrain = Task {
            await submitter.drainOutbox(
                identityHolder: identityHolder,
                currentReplayConfig: { identityConfig },
                epochAtInitiation: epoch,
                currentEpoch: { epoch }
            )
        }
        await fulfillment(of: [firstEntered], timeout: 5)
        first.releaseResponse()
        await firstDrain.value
        let retained = try XCTUnwrap(try reopened.hydrate().first)
        XCTAssertEqual(retained.envelopeBytes, accepted.envelopeBytes)
        XCTAssertEqual(retained.reportId, accepted.reportId)
        XCTAssertEqual(retained.idempotencyKey, accepted.idempotencyKey)

        let secondDrain = Task {
            await submitter.drainOutbox(
                identityHolder: identityHolder,
                currentReplayConfig: { identityConfig },
                epochAtInitiation: epoch,
                currentEpoch: { epoch }
            )
        }
        await fulfillment(of: [secondEntered], timeout: 5)
        second.releaseResponse()
        await secondDrain.value
        XCTAssertTrue(try reopened.hydrate().isEmpty)
        let firstRequest = try XCTUnwrap(first.observation)
        let secondRequest = try XCTUnwrap(second.observation)
        for request in [firstRequest, secondRequest] {
            XCTAssertEqual(request.envelopeBytes, accepted.envelopeBytes)
            XCTAssertEqual(request.reportId, accepted.reportId)
            XCTAssertEqual(request.idempotencyKey, accepted.idempotencyKey)
            XCTAssertEqual(request.authorization, "Bearer \(appId)")
            XCTAssertEqual(request.identityToken, token)
        }
        XCTAssertEqual(secondRequest.envelopeBytes, firstRequest.envelopeBytes)
    }

    private func jwt(sub: String, exp: Date) -> String {
        let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
        let payload = try! JSONSerialization.data(
            withJSONObject: ["sub": sub, "exp": Int(exp.timeIntervalSince1970)]
        )
        func base64URL(_ data: Data) -> String {
            data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(base64URL(header)).\(base64URL(payload)).sig"
    }

    private func enabledIdentityConfig(appId: String) async -> ReplayConfig {
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://everframe.dev/api/config")!,
            apiKey: appId,
            fetcher: HandledDetailsConfigFetcher(
                body: Data(
                    #"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true}}"#.utf8
                )
            )
        )
        await provider.refresh()
        return await provider.current
    }
}
