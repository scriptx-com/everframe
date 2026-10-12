// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Stored with original context. Recovery never loads today's patterns.
struct NativeCrashRedactionSnapshot: Codable, Sendable {
    struct Rule: Codable, Sendable {
        let regex: String
        let options: UInt
        let replacement: String
        let luhn: Bool
    }
    enum Failure: Error { case invalidPolicy }
    let schemaVersion: Int
    let rules: [Rule]

    init(rules: [Rule]) { schemaVersion = 1; self.rules = rules }

    static func capture(config: RedactionConfig) throws -> Self {
        let defaults = SharedData.redactionPatterns
        guard !defaults.isEmpty else { throw Failure.invalidPolicy }
        // Match the existing text engine's replacement spelling and Luhn gate.
        let rules = defaults.map { Rule(regex: $0.regex, options: 0,
            replacement: "[REDACTED:\($0.id)]", luhn: $0.id == "luhn-cc") }
            + config.customPatterns.map { Rule(regex: $0.pattern, options: $0.options.rawValue,
                replacement: "[REDACTED]", luhn: false) }
        let value = Self(rules: rules)
        _ = try value.compiled()
        return value
    }

    func compiled() throws -> (String) -> String {
        guard schemaVersion == 1, !rules.isEmpty, rules.count <= 64 else { throw Failure.invalidPolicy }
        let compiled: [(NSRegularExpression, Rule)]
        do {
            compiled = try rules.map { rule in
                guard rule.regex.utf16.count <= 4096, rule.replacement.utf16.count <= 256,
                      rule.options & ~UInt(127) == 0 else { throw Failure.invalidPolicy }
                return (try NSRegularExpression(pattern: rule.regex, options: .init(rawValue: rule.options)), rule)
            }
        } catch { throw Failure.invalidPolicy }
        return { input in
            var output = Self.bounded(input)
            for (expression, rule) in compiled {
                let range = NSRange(output.startIndex..., in: output)
                if rule.luhn {
                    let matches = expression.matches(in: output, range: range)
                    var ns = output as NSString
                    for match in matches.reversed() {
                        let digits = ns.substring(with: match.range).compactMap { Int(String($0)) }
                        guard (13...19).contains(digits.count) else { continue }
                        let sum = digits.reversed().enumerated().reduce(0) { total, item in
                            let doubled = item.offset % 2 == 1 ? item.element * 2 : item.element
                            return total + (doubled > 9 ? doubled - 9 : doubled)
                        }
                        if sum % 10 == 0 { ns = ns.replacingCharacters(in: match.range, with: rule.replacement) as NSString }
                    }
                    output = ns as String
                } else {
                    output = expression.stringByReplacingMatches(in: output, range: range,
                        withTemplate: NSRegularExpression.escapedTemplate(for: rule.replacement))
                }
                // Literal replacements bound intermediate expansion; cap after each rule.
                output = Self.bounded(output)
            }
            return output
        }
    }

    private static func bounded(_ value: String) -> String {
        var scalars = String.UnicodeScalarView(), units = 0
        for scalar in value.unicodeScalars {
            let count = scalar.value > 0xffff ? 2 : 1
            if units + count > 4096 { break }
            scalars.append(scalar); units += count
        }
        return String(scalars)
    }
}
