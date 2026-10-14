// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CoreFoundation

/// Local permissions only. Dashboard settings may disable but cannot broaden them.
public struct InteractionEventPolicy: Sendable, Equatable {
    public struct URLRule: Sendable, Equatable {
        let origin: String
        let queryKeys: Set<String>
        let routes: Set<String>
        let literalPaths: Set<String>
    }
    public let disabled: Bool
    public let valueTestIds: Set<String>
    public let urlRules: [URLRule]
    public let launchArgumentKeys: Set<String>

    public static func parse(_ json: String?) -> Self {
        func empty(_ disabled: Bool) -> Self { .init(disabled: disabled, valueTestIds: [], urlRules: [], launchArgumentKeys: []) }
        guard let json else { return empty(false) }
        guard json.utf8.count <= 262144, let data = json.data(using: .utf8),
              let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return empty(true) }
        if let disabled = input["disabled"], interactionBool(disabled) != false { return empty(true) }
        let rules: [URLRule] = entries(input["urlRules"]).compactMap { value in
            guard let rule = value as? [String: Any], let declared = rule["origin"] as? String,
                  identifier(declared, max: 1024), let url = URLComponents(string: declared), let origin = interactionOrigin(url),
                  declared == origin || declared == origin + "/", url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
            return .init(origin: origin, queryKeys: strings(rule["queryKeys"], max: 128),
                         routes: Set(strings(rule["routes"], max: 1024).filter { path($0, template: true) }),
                         literalPaths: Set(strings(rule["literalPaths"], max: 1024).filter { path($0, template: false) }))
        }
        return .init(disabled: false, valueTestIds: strings(input["valueTestIds"], max: 256), urlRules: rules, launchArgumentKeys: strings(input["launchArgumentKeys"], max: 128))
    }
    private static func entries(_ input: Any?) -> [Any] { guard let array = input as? [Any], array.count <= 64 else { return [] }; return array }
    private static func strings(_ input: Any?, max: Int) -> Set<String> { Set(entries(input).compactMap { ($0 as? String).flatMap { identifier($0, max: max) ? $0 : nil } }) }
    static func identifier(_ value: String, max: Int) -> Bool {
        !value.isEmpty && value.utf16.count <= max && value.trimmingCharacters(in: .whitespacesAndNewlines) == value &&
            !value.unicodeScalars.contains { $0.value <= 31 || $0.value == 127 || $0 == "*" }
    }
    private static func path(_ value: String, template: Bool) -> Bool {
        value.hasPrefix("/") && !value.contains(where: { "?#\\%".contains($0) }) && value.components(separatedBy: "/").allSatisfy {
            $0 != "." && $0 != ".." && (!$0.contains(":") || (template && $0.range(of: #"\A:[A-Za-z][A-Za-z0-9_]*\z"#, options: .regularExpression) != nil))
        }
    }
}

func interactionBool(_ input: Any?) -> Bool? {
    guard let n = input as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
}
func interactionNumber(_ input: Any?) -> Double? {
    guard let n = input as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }; return n.doubleValue
}
func interactionOrigin(_ url: URLComponents) -> String? {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
    let port = url.port.flatMap { (scheme == "http" && $0 == 80) || (scheme == "https" && $0 == 443) ? nil : $0 }
    return "\(scheme)://\(host)" + (port.map { ":\($0)" } ?? "")
}
