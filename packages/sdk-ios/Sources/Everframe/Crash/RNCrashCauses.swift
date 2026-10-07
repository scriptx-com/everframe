// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Field-local decoding keeps malformed enrichment independent of outer facts.
internal struct RNCrashCausesWire: Decodable {
    let causes: [EverframeCrashCause]
    let truncated: Bool
    static var invalid: Self { Self(causes: [], truncated: true) }
    init(causes: [EverframeCrashCause], truncated: Bool) {
        self.causes = causes
        self.truncated = truncated
    }
    private enum Keys: String, CodingKey { case causes, truncated }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        guard let flag = try? values.decode(Bool.self, forKey: .truncated),
              var array = try? values.nestedUnkeyedContainer(forKey: .causes) else {
            self = .invalid
            return
        }
        var result: [EverframeCrashCause] = []
        var lost = flag
        while !array.isAtEnd && result.count < 8 {
            guard let cause = try? array.decode(RNDecodedCause.self) else { lost = true; break }
            result.append(cause.value)
            lost = lost || cause.lost
        }
        self.init(causes: result, truncated: lost || !array.isAtEnd)
    }
}

private struct RNDecodedCause: Decodable {
    let value: EverframeCrashCause
    let lost: Bool
    private enum Keys: String, CodingKey { case exceptionType, message, frames, framesTruncated }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        let type = CrashCauseText.scan(try values.decode(String.self, forKey: .exceptionType))
        let message = CrashCauseText.scan(try values.decode(String.self, forKey: .message))
        var framesLost = try values.decode(Bool.self, forKey: .framesTruncated)
        var frames: [EverframeCrashCauseFrame] = []
        if var array = try? values.nestedUnkeyedContainer(forKey: .frames) {
            while !array.isAtEnd && frames.count < 32 {
                guard let frame = try? array.decode(RNDecodedCauseFrame.self) else { framesLost = true; break }
                frames.append(frame.value)
                framesLost = framesLost || frame.lost
            }
            framesLost = framesLost || !array.isAtEnd
        } else { framesLost = true }
        value = EverframeCrashCause(exceptionType: type.text, frames: frames, framesTruncated: framesLost, message: message.text)
        lost = type.lost || message.lost
    }
}

private struct RNDecodedCauseFrame: Decodable {
    let value: EverframeCrashCauseFrame
    let lost: Bool
    private enum Keys: String, CodingKey { case raw, file, function, line, col }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        let raw = CrashCauseText.scan(try values.decode(String.self, forKey: .raw))
        var loss = raw.lost
        func text(_ key: Keys) -> String? {
            guard values.contains(key) else { return nil }
            guard let text = try? values.decode(String.self, forKey: key) else { loss = true; return nil }
            let scanned = CrashCauseText.scan(text)
            loss = loss || scanned.lost
            return scanned.text
        }
        func position(_ key: Keys) -> Int? {
            guard values.contains(key) else { return nil }
            guard let number = try? values.decode(Int.self, forKey: key), number >= 0, number <= 9_007_199_254_740_991 else {
                loss = true
                return nil
            }
            return number
        }
        value = EverframeCrashCauseFrame(col: position(.col), file: text(.file), function: text(.function), line: position(.line), raw: raw.text)
        lost = loss
    }
}
