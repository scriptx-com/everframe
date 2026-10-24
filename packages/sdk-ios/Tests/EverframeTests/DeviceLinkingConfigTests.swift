// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Records every config request and answers 200 with a fixed body.
private final class RecordingConfigFetcher: URLSessionFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    let body: Data

    init(body: Data) { self.body = body }

    var recorded: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    private func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        record(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (body, response)
    }
}

final class DeviceLinkingConfigTests: XCTestCase {
    private func body(_ block: String) -> Data {
        Data((#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"# + block + "}").utf8)
    }

    private func provider(_ fetcher: URLSessionFetching, token: @escaping @Sendable () -> String?) -> ReplayConfigProvider {
        ReplayConfigProvider(configUrl: URL(string: "https://everframe.dev/api/config")!, sdkKey: "k",
                             fetcher: fetcher, deviceTokenProvider: token)
    }

    func testFeatureHeaderDeclaresDeviceLinkingButNotCaptureGesture() {
        let tokens = ReplayConfigProvider.sdkFeaturesHeaderValue.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertTrue(tokens.contains("devicelinking"))
        // Only tvOS builds bind a TV gesture.
        #if os(tvOS)
        XCTAssertTrue(tokens.contains("capturegesture"))
        #else
        XCTAssertFalse(tokens.contains("capturegesture"))
        #endif
    }

    func testDecodesEnabledAndLink() throws {
        let c = try ReplayConfigProvider.__decodeForTesting(
            body(#""deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"user","name":"Aurimas"}}}"#))
        XCTAssertEqual(c.deviceLinking?.enabled, true)
        XCTAssertEqual(c.deviceLinking?.link, .init(status: .linked, owner: .user(name: "Aurimas")))
        XCTAssertNil(c.deviceLinking?.requestTokenFingerprint)
    }

    func testUnlinkedAndTeam() throws {
        let unlinked = try ReplayConfigProvider.__decodeForTesting(
            body(#""deviceLinking":{"enabled":true,"link":{"status":"unlinked"}}"#))
        XCTAssertEqual(unlinked.deviceLinking?.link, .init(status: .unlinked, owner: nil))
        let team = try ReplayConfigProvider.__decodeForTesting(
            body(#""deviceLinking":{"enabled":false,"link":{"status":"linked","owner":{"kind":"team"}}}"#))
        XCTAssertEqual(team.deviceLinking?.enabled, false)
        XCTAssertEqual(team.deviceLinking?.link, .init(status: .linked, owner: .team))
    }

    func testAbsentBlockIsNil() throws {
        let c = try ReplayConfigProvider.__decodeForTesting(body(#""captureHotkey":{"enabled":true}"#))
        XCTAssertNil(c.deviceLinking)
        XCTAssertNil(ReplayConfig.off.deviceLinking)
    }

    func testMalformedRecordingIsDropped() throws {
        let c = try ReplayConfigProvider.__decodeForTesting(body(
            #""deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"team"},"recording":{"id":"x","expiresAt":"y"}}}"#))
        XCTAssertEqual(c.deviceLinking?.link, .init(status: .linked, owner: .team))
    }

    func testRecordingDecodesForALinkedDevice() throws {
        let id = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
        let expected = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-24T10:00:00Z"))
        for stamp in ["2026-10-24T10:00:00.000Z", "2026-10-24T10:00:00Z"] {
            let c = try ReplayConfigProvider.__decodeForTesting(body(
                #""deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"user","name":"Aurimas"},"recording":{"id":"\#(id)","expiresAt":"\#(stamp)"}}}"#))
            XCTAssertEqual(c.deviceLinking?.link?.status, .linked, stamp)
            XCTAssertEqual(c.deviceLinking?.link?.recording, DeviceLinkRecordingRequest(id: id, expiresAt: expected), stamp)
        }
        let fractional = try ReplayConfigProvider.__decodeForTesting(body(
            #""deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"team"},"recording":{"id":"r-1","expiresAt":"2026-10-24T10:00:00.250Z"}}}"#))
        XCTAssertEqual(fractional.deviceLinking?.link?.recording?.expiresAt, expected.addingTimeInterval(0.25))
    }

    func testBadRecordingDropsOnlyTheRecording() throws {
        let tooLong = String(repeating: "a", count: 65)
        for recording in [#"{"id":"a/b","expiresAt":"2026-10-24T10:00:00.000Z"}"#,
                          #"{"id":"","expiresAt":"2026-10-24T10:00:00.000Z"}"#,
                          #"{"id":"\#(tooLong)","expiresAt":"2026-10-24T10:00:00.000Z"}"#,
                          #"{"id":7,"expiresAt":"2026-10-24T10:00:00.000Z"}"#,
                          #"{"id":"abc","expiresAt":"tomorrow"}"#,
                          #"{"id":"abc"}"#, #""abc""#] {
            let c = try ReplayConfigProvider.__decodeForTesting(body(
                #""deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"team"},"recording":"# + recording + "}}"))
            XCTAssertEqual(c.deviceLinking?.link?.status, .linked, recording)
            XCTAssertEqual(c.deviceLinking?.link?.owner, .team, recording)
            XCTAssertNil(c.deviceLinking?.link?.recording, recording)
        }
    }

    func testUnlinkedNeverCarriesARecording() throws {
        let c = try ReplayConfigProvider.__decodeForTesting(body(
            #""deviceLinking":{"enabled":true,"link":{"status":"unlinked","recording":{"id":"abc","expiresAt":"2026-10-24T10:00:00.000Z"}}}"#))
        XCTAssertEqual(c.deviceLinking?.link, .init(status: .unlinked, owner: nil))
        XCTAssertNil(c.deviceLinking?.link?.recording)
    }

    func testMalformedBlockDegradesToNil() throws {
        for raw in [#"{"enabled":"yes"}"#, "true", "[]", #"{"link":{"status":"linked"}}"#, "null"] {
            let c = try ReplayConfigProvider.__decodeForTesting(body(#""deviceLinking":"# + raw))
            XCTAssertNil(c.deviceLinking, raw)
            XCTAssertEqual(c.replayDurationSec, 30, raw)
            XCTAssertTrue(c.replayEnabled, raw)
        }
    }

    func testMalformedLinkKeepsEnabled() throws {
        for raw in [#"{"status":"weird"}"#, #""linked""#, #"{"status":"linked","owner":{"kind":"user","name":" "}}"#,
                    #"{"status":"linked"}"#, #"{"status":"linked","owner":{"kind":"robot"}}"#] {
            let c = try ReplayConfigProvider.__decodeForTesting(body(#""deviceLinking":{"enabled":true,"link":"# + raw + "}"))
            XCTAssertEqual(c.deviceLinking?.enabled, true, raw)
            XCTAssertNil(c.deviceLinking?.link, raw)
        }
    }

    func testConfigFetchSendsOnlyAValidDeviceToken() async {
        let cases: [(String?, String?)] = [(fixtureToken, fixtureToken), ("evf_cap_abc", nil), (nil, nil), ("", nil)]
        for (index, (provided, expected)) in cases.enumerated() {
            let fetcher = RecordingConfigFetcher(body: body(#""deviceLinking":{"enabled":true}"#))
            let p = provider(fetcher, token: { provided })
            await p.refresh(force: true)
            XCTAssertEqual(fetcher.recorded.count, 1, "case \(index)")
            let sent = fetcher.recorded.first?.value(forHTTPHeaderField: "X-Everframe-Capture-Token")
            // Compare without putting the value in the failure message.
            XCTAssertTrue(sent == expected, "case \(index)")
            XCTAssertNil(fetcher.recorded.first?.url?.query, "case \(index)")
        }
    }

    func testResponseRecordsFingerprintOfTokenSent() async {
        let fetcher = RecordingConfigFetcher(body: body(#""deviceLinking":{"enabled":true,"link":{"status":"unlinked"}}"#))
        let p = provider(fetcher, token: { fixtureToken })
        await p.refresh(force: true)
        let fingerprint = await p.current.deviceLinking?.requestTokenFingerprint
        XCTAssertEqual(fingerprint, DeviceLinkToken.fingerprint(fixtureToken))

        let none = provider(RecordingConfigFetcher(body: body(#""deviceLinking":{"enabled":true}"#)), token: { nil })
        await none.refresh(force: true)
        let enabled = await none.current.deviceLinking?.enabled
        let noFingerprint = await none.current.deviceLinking?.requestTokenFingerprint
        XCTAssertEqual(enabled, true)
        XCTAssertNil(noFingerprint)
    }

    func testTokenIsReadPerFetch() async {
        let box = TokenBox(fixtureToken)
        let fetcher = RecordingConfigFetcher(body: body(#""deviceLinking":{"enabled":true}"#))
        let p = provider(fetcher, token: { box.value })
        await p.refresh(force: true)
        box.value = otherToken
        await p.refresh(force: true)
        let sent = fetcher.recorded.map { $0.value(forHTTPHeaderField: "X-Everframe-Capture-Token") }
        XCTAssertTrue(sent == [fixtureToken, otherToken])
        let fingerprint = await p.current.deviceLinking?.requestTokenFingerprint
        XCTAssertEqual(fingerprint, DeviceLinkToken.fingerprint(otherToken))
    }
}

private final class TokenBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?
    init(_ value: String?) { stored = value }
    var value: String? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
