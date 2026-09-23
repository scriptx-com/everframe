// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation
import XCTest
@testable import EverframeKit

/// Host transport fixture for encrypted persistence and exact retry identity.
/// Installed-app HTTP and relaunch coverage belongs to the installed acceptance task.
final class HandledDetailsDeliveryTests: XCTestCase {
    private let appId = "ios-handled-details-delivery"

    override func setUpWithError() throws {
        try super.setUpWithError()
        Everframe.shared.kill()
        Everframe.shared.__replayConfigOverrideForTesting = nil
        Everframe.shared.setIdentityToken(nil)
        Everframe.shared._identityEnabledFlag.set(false)
        Everframe.__setConfigForTesting(EverframeConfig(appId: appId))
        Everframe.captureGate = true
        CrashReporter.__scheduleDrainForTesting = { _ in }
        try? FileManager.default.removeItem(at: JSONLOutbox().resolvedFileURL)
        HandledDetailsURLProtocol.reset()
    }

    override func tearDownWithError() throws {
        HandledDetailsURLProtocol.releaseAll()
        HandledDetailsURLProtocol.reset()
        CrashReporter.__scheduleDrainForTesting = nil
        Everframe.shared.setIdentityToken(nil)
        Everframe.shared.__replayConfigOverrideForTesting = nil
        Everframe.shared._identityEnabledFlag.set(false)
        Everframe.shared.kill()
        Everframe.__setConfigForTesting(nil)
        try? FileManager.default.removeItem(at: JSONLOutbox().resolvedFileURL)
        try super.tearDownWithError()
    }

    func testDefaultEncryptedPublicCaptureRetriesByteIdenticalAcceptedDetailsAfter503() async throws {
        let originalMarker = "delivery-owned-original-marker"
        let mutatedMarker = "delivery-owned-mutated-marker"
        let nested = NSMutableDictionary(dictionary: ["state": originalMarker])
        let expectedIdentitySubject = "delivery-fixture-user"
        let expectedIdentityToken = jwt(
            sub: expectedIdentitySubject,
            exp: Date().addingTimeInterval(300)
        )
        let expectedEndpoint = IngestEndpoint.url.absoluteString
        let expectedRequestURL = IngestEndpoint.url.appendingPathComponent("api/ingest")
        let identityConfig = await enabledIdentityConfig()
        Everframe.shared.__replayConfigOverrideForTesting = identityConfig
        Everframe.shared.setIdentityToken(.token(expectedIdentityToken))

        Everframe.shared.captureException(
            NSError(
                domain: "DeliveryDetails",
                code: 503,
                userInfo: [NSLocalizedDescriptionKey: "encrypted-delivery-message"]
            ),
            options: CaptureExceptionOptions(
                severity: .warning,
                context: "host retry fixture",
                metadata: ["nested": nested]
            )
        )
        nested["state"] = mutatedMarker

        let reopened = JSONLOutbox()
        let accepted = try XCTUnwrap(try reopened.hydrate().first)
        XCTAssertEqual(accepted.sdkKey, appId)
        XCTAssertEqual(accepted.endpoint, expectedEndpoint)
        XCTAssertEqual(accepted.identitySubject, expectedIdentitySubject)
        let envelope = try XCTUnwrap(
            JSONSerialization.jsonObject(with: accepted.envelopeBytes) as? [String: Any]
        )
        let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
        let crash = try XCTUnwrap(payload["crash"] as? [String: Any])
        let details = try XCTUnwrap(crash["details"] as? [String: Any])
        let metadata = try XCTUnwrap(details["metadata"] as? [String: Any])
        XCTAssertEqual((metadata["nested"] as? [String: Any])?["state"] as? String, originalMarker)
        XCTAssertEqual(envelope["reportId"] as? String, accepted.reportId.uuidString)

        let stored = try Data(contentsOf: reopened.resolvedFileURL)
        XCTAssertEqual(String(decoding: stored.prefix(8), as: UTF8.self), "EVRBOX01")
        XCTAssertNil(stored.range(of: Data(originalMarker.utf8)))
        XCTAssertNil(stored.range(of: Data(mutatedMarker.utf8)))
        XCTAssertNil(stored.range(of: Data("encrypted-delivery-message".utf8)))

        let firstEntered = expectation(description: "first 503 request entered fixture")
        let secondEntered = expectation(description: "later retry entered fixture")
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

        let retainedEntries = try reopened.hydrate()
        XCTAssertEqual(retainedEntries.count, 1)
        let retained = try XCTUnwrap(retainedEntries.first)
        XCTAssertEqual(retained.reportId, accepted.reportId)
        XCTAssertEqual(retained.envelopeBytes, accepted.envelopeBytes)
        XCTAssertEqual(retained.idempotencyKey, accepted.idempotencyKey)
        XCTAssertEqual(retained.attachmentRefs, accepted.attachmentRefs)
        XCTAssertEqual(retained.sdkKey, accepted.sdkKey)
        XCTAssertEqual(retained.endpoint, accepted.endpoint)
        XCTAssertEqual(retained.identitySubject, accepted.identitySubject)
        let firstObservation = try XCTUnwrap(first.observation)
        assertAcceptedIdentity(
            firstObservation,
            equals: accepted,
            expectedRequestURL: expectedRequestURL,
            expectedIdentityToken: expectedIdentityToken
        )

        let laterDrain = Task {
            await submitter.drainOutbox(
                identityHolder: identityHolder,
                currentReplayConfig: { identityConfig },
                epochAtInitiation: epoch,
                currentEpoch: { epoch }
            )
        }
        await fulfillment(of: [secondEntered], timeout: 5)
        second.releaseResponse()
        await laterDrain.value

        XCTAssertTrue(try reopened.hydrate().isEmpty)
        let secondObservation = try XCTUnwrap(second.observation)
        assertAcceptedIdentity(
            secondObservation,
            equals: accepted,
            expectedRequestURL: expectedRequestURL,
            expectedIdentityToken: expectedIdentityToken
        )
        XCTAssertEqual(secondObservation.envelopeBytes, firstObservation.envelopeBytes)
        XCTAssertEqual(secondObservation.reportId, firstObservation.reportId)
        XCTAssertEqual(secondObservation.idempotencyKey, firstObservation.idempotencyKey)
        XCTAssertEqual(secondObservation.url, firstObservation.url)
        XCTAssertEqual(secondObservation.authorization, firstObservation.authorization)
        XCTAssertEqual(secondObservation.identityToken, firstObservation.identityToken)
    }

    private func assertAcceptedIdentity(
        _ observation: HandledDetailsHTTPObservation,
        equals entry: OutboxEntry,
        expectedRequestURL: URL,
        expectedIdentityToken: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(observation.envelopeBytes, entry.envelopeBytes, file: file, line: line)
        XCTAssertEqual(observation.reportId, entry.reportId, file: file, line: line)
        XCTAssertEqual(observation.idempotencyKey, entry.idempotencyKey, file: file, line: line)
        XCTAssertEqual(observation.url, expectedRequestURL, file: file, line: line)
        XCTAssertEqual(observation.authorization, "Bearer \(appId)", file: file, line: line)
        XCTAssertEqual(observation.identityToken, expectedIdentityToken, file: file, line: line)
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

    private func enabledIdentityConfig() async -> ReplayConfig {
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://everframe.dev/api/config")!,
            apiKey: "task-2-fixture-key",
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

struct HandledDetailsHTTPObservation: Sendable {
    let envelopeBytes: Data
    let reportId: UUID
    let idempotencyKey: String
    let url: URL
    let authorization: String?
    let identityToken: String?
}

struct HandledDetailsConfigFetcher: URLSessionFetching {
    let body: Data

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (body, response)
    }
}

final class HandledDetailsHTTPAttempt: @unchecked Sendable {
    let status: Int
    private let entered: XCTestExpectation
    private let responseGate = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var storedObservation: HandledDetailsHTTPObservation?

    init(status: Int, entered: XCTestExpectation) {
        self.status = status
        self.entered = entered
    }

    var observation: HandledDetailsHTTPObservation? {
        lock.lock(); defer { lock.unlock() }
        return storedObservation
    }

    func record(_ observation: HandledDetailsHTTPObservation) {
        lock.lock(); storedObservation = observation; lock.unlock()
        entered.fulfill()
    }

    func waitForResponseRelease() -> Bool {
        responseGate.wait(timeout: .now() + 5) == .success
    }

    func releaseResponse() { responseGate.signal() }
}

final class HandledDetailsURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var attempts: [HandledDetailsHTTPAttempt] = []
    nonisolated(unsafe) private static var allAttempts: [HandledDetailsHTTPAttempt] = []
    private static let lock = NSLock()

    static func prepare(_ attempts: [HandledDetailsHTTPAttempt]) {
        lock.lock()
        self.attempts = attempts
        allAttempts = attempts
        lock.unlock()
    }

    static func reset() {
        lock.lock(); attempts = []; allAttempts = []; lock.unlock()
    }

    static func releaseAll() {
        lock.lock(); let current = allAttempts; lock.unlock()
        current.forEach { $0.releaseResponse() }
    }

    private static func takeAttempt() -> HandledDetailsHTTPAttempt? {
        lock.lock(); defer { lock.unlock() }
        guard !attempts.isEmpty else { return nil }
        return attempts.removeFirst()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let attempt = Self.takeAttempt(),
              let observation = Self.observation(from: request)
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        attempt.record(observation)
        guard attempt.waitForResponseRelease() else {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: attempt.status,
            httpVersion: "HTTP/1.1", headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func observation(from request: URLRequest) -> HandledDetailsHTTPObservation? {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
        } else if let direct = request.httpBody {
            body = direct
        }
        guard let contentType = request.value(forHTTPHeaderField: "Content-Type"),
              let boundary = contentType.components(separatedBy: "boundary=").last,
              !boundary.isEmpty,
              let headerEnd = body.range(of: Data("\r\n\r\n".utf8))?.upperBound,
              let closing = body.range(of: Data("\r\n--\(boundary)--\r\n".utf8)),
              headerEnd <= closing.lowerBound
        else { return nil }
        let envelopeBytes = Data(body[headerEnd..<closing.lowerBound])
        guard let envelope = try? JSONSerialization.jsonObject(with: envelopeBytes) as? [String: Any],
              let reportIdString = envelope["reportId"] as? String,
              let reportId = UUID(uuidString: reportIdString),
              let idempotencyKey = request.value(forHTTPHeaderField: "X-Everframe-Idempotency-Key")
        else { return nil }
        return HandledDetailsHTTPObservation(
            envelopeBytes: envelopeBytes,
            reportId: reportId,
            idempotencyKey: idempotencyKey,
            url: request.url!,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            identityToken: request.value(forHTTPHeaderField: IDENTITY_TOKEN_HEADER)
        )
    }
}
