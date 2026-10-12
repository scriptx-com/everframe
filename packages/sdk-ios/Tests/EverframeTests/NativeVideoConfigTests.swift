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
    @Test(arguments: [
        ("", 5),
        (",\"nativeVideo\":{\"framesPerSecond\":1}", 1),
        (",\"nativeVideo\":{\"framesPerSecond\":2}", 2),
        (",\"nativeVideo\":{\"framesPerSecond\":5}", 5),
        (",\"nativeVideo\":{\"framesPerSecond\":10}", 10),
        (",\"nativeVideo\":{\"framesPerSecond\":3}", nil),
        (",\"nativeVideo\":{\"framesPerSecond\":7}", nil),
        (",\"nativeVideo\":null", nil),
    ] as [(String, Int?)])
    func decode(_ suffix: String, expected: Int?) async throws {
        let body = "{\"replayEnabled\":true,\"replayDurationSec\":30,\"samplingRate\":1\(suffix)}"
        let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/api/config")!,
            sdkKey: "test", fetcher: Fetcher(body))
        let fresh = await provider.refresh(force: true)
        let config = await provider.current
        #expect(effectiveNativeVideo(config: config, fetchConfirmed: fresh)?.framesPerSecond == expected)
        #expect(effectiveNativeVideo(config: config, fetchConfirmed: false) == nil)
    }
    @Test(arguments: [(1, 240_000), (2, 480_000), (5, 1_200_000), (10, 1_200_000)])
    func bitrateScalesBelowFiveFramesPerSecond(fps: Int, bitrate: Int) {
        #expect(NativeVideoSettings.averageBitRate(framesPerSecond: fps) == bitrate)
    }
    @Test func configRequestDeclaresLowFrameRatesNextToNativeVideo() {
        let tokens = ReplayConfigProvider.sdkFeaturesHeaderValue
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        #expect(tokens.contains("nativevideo"))
        #expect(tokens.contains("nativevideolowfps"))
    }
    @Test func replayOffRemainsOff() {
        #expect(effectiveNativeVideo(config: .off, fetchConfirmed: true) == nil)
    }
}
