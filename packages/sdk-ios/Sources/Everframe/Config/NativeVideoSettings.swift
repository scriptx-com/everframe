// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public struct NativeVideoSettings: Decodable, Sendable, Equatable {
    /// Every rate the recorder accepts. The server sends 1 or 2 only to SDKs
    /// that declare `nativevideolowfps`.
    public static let allowedFramesPerSecond: Set<Int> = [1, 2, 5, 10]

    public let framesPerSecond: Int
    public init() { framesPerSecond = 5 }
    private enum CodingKeys: String, CodingKey { case framesPerSecond }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fps = try container.decode(Int.self, forKey: .framesPerSecond)
        guard Self.allowedFramesPerSecond.contains(fps) else {
            throw DecodingError.dataCorruptedError(forKey: .framesPerSecond,
                in: container, debugDescription: "Native video requires 1, 2, 5 or 10 fps")
        }
        framesPerSecond = fps
    }

    /// H.264 average bitrate: 1.2 Mbps at 5 fps and above, and 1.2 Mbps × fps / 5
    /// below, so a frame below 5 fps keeps the 5 fps byte budget.
    static func averageBitRate(framesPerSecond: Int) -> Int {
        framesPerSecond >= 5 ? 1_200_000 : 1_200_000 * framesPerSecond / 5
    }
}

public func effectiveNativeVideo(config: ReplayConfig, fetchConfirmed: Bool) -> NativeVideoSettings? {
    guard fetchConfirmed, config.replayEnabled else { return nil }
    return config.nativeVideo
}
