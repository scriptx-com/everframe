// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

internal enum CrashCauseText {
    static func prefix(_ text: String, limit: Int) -> (text: String, lost: Bool) {
        (CrashText.capped(text, utf16Limit: limit), text.utf16.prefix(limit + 1).count > limit)
    }
    /// Retain the 8,192-unit redaction scan window. A cut can end inside a secret
    /// that redaction only matches whole, such as a JWT without its last segment,
    /// so a cut drops that token and any digit group before it, exactly as the
    /// shared TypeScript normalizer does.
    static func scan(_ text: String) -> (text: String, lost: Bool) {
        let window = prefix(text, limit: 8192)
        guard window.lost else { return window }
        let scalars = window.text.unicodeScalars
        var end = scalars.endIndex
        while end > scalars.startIndex, isTokenUnit(scalars[scalars.index(before: end)]) { end = scalars.index(before: end) }
        while end > scalars.startIndex, isDigitGroupUnit(scalars[scalars.index(before: end)]) { end = scalars.index(before: end) }
        return (String(scalars[..<end]), true)
    }
    /// Units of the tokens the shared redaction patterns match (JWT, bearer).
    private static func isTokenUnit(_ unit: Unicode.Scalar) -> Bool {
        switch unit.value {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2B, 0x2D, 0x2E, 0x2F, 0x3D, 0x5F, 0x7E: return true
        default: return false
        }
    }
    /// Digits, dashes and JavaScript whitespace: the units of card and SSN numbers.
    private static func isDigitGroupUnit(_ unit: Unicode.Scalar) -> Bool {
        switch unit.value {
        case 0x30...0x39, 0x2D, 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default: return false
        }
    }
}
private enum CauseNormalizationError: Error { case cancelled }

/// Re-fit against the actual native encoder after redaction; retain only owned values.
internal func normalizeCrashCauseChain(
    _ input: RNCrashCausesWire?, redact: (String) throws -> String, stillOwned: () -> Bool
) -> EverframeCrashCauseChain? {
    guard let input, stillOwned() else { return nil }
    do {
        var causes: [EverframeCrashCause] = []
        var truncated = input.truncated || input.causes.count > 8
        func text(_ value: String, limit: Int) throws -> (text: String, lost: Bool) {
            guard stillOwned() else { throw CauseNormalizationError.cancelled }
            let scanned = CrashCauseText.scan(value)
            let redacted = try redact(scanned.text)
            guard stillOwned() else { throw CauseNormalizationError.cancelled }
            let capped = CrashCauseText.prefix(redacted, limit: limit)
            return (capped.text, scanned.lost || capped.lost)
        }
        func fits() throws -> Bool {
            // false reserves one more byte than true for each mutable loss flag.
            let reserved = EverframeCrashCauseChain(causes: causes.map { $0.with(framesTruncated: false) }, truncated: false)
            return try EnvelopeBuilder.makeJSONEncoder().encode(reserved).count <= 65_536
        }
        func finish() -> EverframeCrashCauseChain? {
            guard stillOwned() else { return nil }
            return EverframeCrashCauseChain(causes: causes, truncated: truncated)
        }
        for cause in input.causes.prefix(8) {
            let type = try text(cause.exceptionType, limit: 256)
            let message = try text(cause.message, limit: 4096)
            causes.append(EverframeCrashCause(exceptionType: type.text, frames: [], framesTruncated: cause.framesTruncated || cause.frames.count > 32, message: message.text))
            guard try fits() else { causes.removeLast(); truncated = true; break }
            truncated = truncated || type.lost || message.lost
            for frame in cause.frames.prefix(32) {
                var loss = false
                func frameText(_ value: String?, limit: Int) throws -> String? {
                    guard let value else { return nil }
                    let normalized = try text(value, limit: limit)
                    loss = loss || normalized.lost
                    return normalized.text
                }
                func position(_ value: Int?) -> Int? {
                    guard let value else { return nil }
                    guard value >= 0 && value <= 9_007_199_254_740_991 else { loss = true; return nil }
                    return value
                }
                let normalized = try EverframeCrashCauseFrame(col: position(frame.col), file: frameText(frame.file, limit: 1024), function: frameText(frame.function, limit: 512), line: position(frame.line), raw: frameText(frame.raw, limit: 1024)!)
                let previous = causes[causes.count - 1]
                causes[causes.count - 1] = previous.with(frames: previous.frames + [normalized], framesTruncated: previous.framesTruncated || loss)
                guard try fits() else {
                    causes[causes.count - 1] = previous.with(framesTruncated: true)
                    truncated = true
                    return finish()
                }
            }
        }
        return finish()
    } catch { return nil }
}
