// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public struct NativeVideoSettings: Decodable, Sendable, Equatable {
    public let framesPerSecond: Int
    public init() { framesPerSecond = 5 }
    private enum CodingKeys: String, CodingKey { case framesPerSecond }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fps = try container.decode(Int.self, forKey: .framesPerSecond)
        guard fps == 5 || fps == 10 else {
            throw DecodingError.dataCorruptedError(forKey: .framesPerSecond,
                in: container, debugDescription: "Native video requires 5 or 10 fps")
        }
        framesPerSecond = fps
    }
}

public func effectiveNativeVideo(config: ReplayConfig, fetchConfirmed: Bool) -> NativeVideoSettings? {
    guard fetchConfirmed, config.replayEnabled else { return nil }
    return config.nativeVideo
}
