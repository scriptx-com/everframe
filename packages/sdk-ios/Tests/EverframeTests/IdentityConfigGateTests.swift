// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The gate that keeps a project with no signing secret from ever presenting an
// identity header. Note the capability negotiation: the server only SENDS the
// identity block when the caller declares `identity` in X-Everframe-SDK-Features
// (the server configuration contract:131). Miss that and `enabled` is always
// false and the whole feature silently never activates — which is why the
// header token is pinned by a test here rather than left to review.
//
// Decode path note: `ReplayConfig` itself is deliberately NOT `Decodable` —
// only the file-private `ReplayConfigWire` in ReplayConfigProvider.swift is,
// so the fail-closed validation (samplingRate bounds, networkBodies caps,
// etc.) lives on the wire type and can never be bypassed by a caller decoding
// the public type directly. So, like every test in
// ReplayConfigProviderTests.swift, this suite drives a real
// `ReplayConfigProvider.refresh()` through a stub `URLSessionFetching` and
// reads back `.current` rather than decoding `ReplayConfig` directly.
import XCTest
@testable import EverframeKit

private final class SingleResponseFetcher: URLSessionFetching, @unchecked Sendable {
    private let body: Data
    init(_ json: String) { self.body = Data(json.utf8) }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return (body, response)
    }
}

final class IdentityConfigGateTests: XCTestCase {

    private func decode(_ json: String) async -> ReplayConfig {
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://everframe.dev/api/config")!,
            apiKey: "evr_test_key",
            fetcher: SingleResponseFetcher(json)
        )
        await provider.refresh()
        return await provider.current
    }

    func testIdentityEnabledTrueDecodes() async {
        let cfg = await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true}}"#)
        XCTAssertTrue(isIdentityEnabled(cfg))
    }

    func testIdentityEnabledFalseDecodes() async {
        let cfg = await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":false}}"#)
        XCTAssertFalse(isIdentityEnabled(cfg))
    }

    func testAbsentIdentityBlockIsDisabled() async {
        // The ordinary shape for every project without a signing secret, and
        // for every server that predates the block.
        let cfg = await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1}"#)
        XCTAssertFalse(isIdentityEnabled(cfg))
    }

    func testUnknownKeysInsideTheIdentityBlockDoNotBreakDecoding() async {
        let cfg = await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true,"futureField":"x"}}"#)
        XCTAssertTrue(isIdentityEnabled(cfg))
    }

    func testTheConfigRequestDeclaresTheIdentityCapability() {
        // the server configuration contract:131 gates the identity block on
        // this token. Without it the block never arrives and isIdentityEnabled
        // is false forever — a silent, total no-op.
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("identity"))
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("networkbodies"),
                      "the pre-existing capability must not be dropped")
    }
}
