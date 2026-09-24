// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Testing
@testable import EverframeKit

struct NativeVideoConfigTests {
    private final class Fetcher: URLSessionFetching, @unchecked Sendable {
        let body: String
        init(_ body: String) { self.body = body }
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: nil, headerFields: nil)!)
        }
    }
    @Test(arguments: ["", ",\"nativeVideo\":{\"framesPerSecond\":10}",
                      ",\"nativeVideo\":{\"framesPerSecond\":7}", ",\"nativeVideo\":null"])
    func decode(_ suffix: String) async throws {
        let body = "{\"replayEnabled\":true,\"replayDurationSec\":30,\"samplingRate\":1\(suffix)}"
        let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/api/config")!,
            apiKey: "test", fetcher: Fetcher(body))
        let fresh = await provider.refresh(force: true)
        let config = await provider.current
        let effective = effectiveNativeVideo(config: config, fetchConfirmed: fresh)
        if suffix.isEmpty { #expect(effective?.framesPerSecond == 5) }
        else if suffix.contains(":10") { #expect(effective?.framesPerSecond == 10) }
        else { #expect(effective == nil) }
        #expect(effectiveNativeVideo(config: config, fetchConfirmed: false) == nil)
    }
    @Test func replayOffRemainsOff() {
        #expect(effectiveNativeVideo(config: .off, fetchConfirmed: true) == nil)
    }
}
