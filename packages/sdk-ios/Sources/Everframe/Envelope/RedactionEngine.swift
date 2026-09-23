// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Default-deny redaction engine. Loads regex patterns + sensitive-header
// allowlist from SharedData (which mirrors packages/protocol/data/*.json).
//
// Behavior contract (mirrors packages/sdk-core/src/redaction/engine.ts):
//   • redact(_:) — applies all patterns to a freeform string. Luhn-CC has an
//     extra Luhn-validation gate to reject phone numbers / order IDs.
//   • filterHeaders(_:) — default-deny: only allowlisted headers are kept;
//     sensitive headers have their values replaced with `[REDACTED]`; any
//     other header is dropped entirely.
//
// Conformance to EnvelopeBuilder.RedactingHeaders is provided so `EnvelopeBuilder(redactor:)`
// (shipped by 04-01 with a `NoOpRedactor` default) can swap in this engine.
import Foundation

public struct RedactionEngine: Sendable {
    public init() {}

    /// Apply default-deny redaction to a freeform string. Used on log lines,
    /// description fields, query strings, etc.
    public func redact(_ input: String) -> String {
        var out = input
        for pattern in SharedData.redactionPatterns {
            guard let regex = try? NSRegularExpression(pattern: pattern.regex, options: []) else { continue }
            let replacement = "[REDACTED:\(pattern.id)]"
            if pattern.id == "luhn-cc" {
                // Luhn validation gates the regex match (most digit runs aren't credit cards).
                out = regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out)) { matched in
                    let digitsOnly = matched.filter(\.isNumber)
                    return luhnValid(digitsOnly) ? replacement : matched
                }
            } else {
                let nsRange = NSRange(out.startIndex..., in: out)
                out = regex.stringByReplacingMatches(in: out, options: [], range: nsRange, withTemplate: replacement)
            }
        }
        return out
    }

    /// Filter HTTP headers — default-deny semantics.
    /// • Headers whose lowercase name is in `allowedHeadersToCapture` → kept verbatim
    /// • Headers whose lowercase name is in `sensitiveHeadersToRedact` → value replaced with [REDACTED]
    /// • Any other header → dropped entirely
    public func filterHeaders(_ headers: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in headers {
            let lower = k.lowercased()
            if SharedData.allowedHeadersToCapture.contains(lower) {
                out[k] = v
            } else if SharedData.sensitiveHeadersToRedact.contains(lower) {
                out[k] = "[REDACTED]"
            }
            // else: default-deny (drop)
        }
        return out
    }

    private func luhnValid(_ s: String) -> Bool {
        let digits = s.compactMap { Int(String($0)) }
        guard digits.count >= 13 && digits.count <= 19 else { return false }
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            if i % 2 == 1 {
                let doubled = d * 2
                sum += doubled > 9 ? doubled - 9 : doubled
            } else {
                sum += d
            }
        }
        return sum % 10 == 0
    }
}

// EnvelopeBuilder.RedactingHeaders bridge — lets `EnvelopeBuilder(redactor:)`
// accept a real RedactionEngine without leaking implementation details into the
// builder's public surface.
extension RedactionEngine: EnvelopeBuilder.RedactingHeaders {}

// MARK: - NSRegularExpression closure-based replacement helper

fileprivate extension NSRegularExpression {
    /// Replace every match in `input` (within `range`) with the result of
    /// `replace(matchedString)`. Iterates matches in reverse to keep ranges
    /// valid as the string mutates.
    func stringByReplacingMatches(
        in input: String,
        options: MatchingOptions = [],
        range: NSRange,
        _ replace: (String) -> String
    ) -> String {
        let matches = self.matches(in: input, options: options, range: range)
        var ns = input as NSString
        for m in matches.reversed() {
            let matched = ns.substring(with: m.range)
            ns = ns.replacingCharacters(in: m.range, with: replace(matched)) as NSString
        }
        return ns as String
    }
}
