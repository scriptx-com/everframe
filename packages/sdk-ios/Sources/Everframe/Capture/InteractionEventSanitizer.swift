// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

enum InteractionEventSanitizer {
    static func kind(_ type: String) -> EverframeBreadcrumbKind {
        switch type { case "deep_link": return .navigation; case "permission", "launch": return .lifecycle; default: return .custom }
    }
    static func message(_ type: String) -> String {
        switch type {
        case "text_edit": return "Text edited"
        case "control_change": return "Control changed"
        case "scroll": return "Scrolled"
        case "deep_link": return "Link opened"
        case "permission": return "Permission observed"
        default: return "App entered foreground"
        }
    }
    static func sanitize(_ input: [String: Any], policy: InteractionEventPolicy, liveTestId: String? = nil) -> [String: Any]? {
        guard !policy.disabled else { return nil }
        var fields = input
        if liveTestId.map({ policy.valueTestIds.contains($0) }) != true { fields.removeValue(forKey: "value") }
        if input["type"] as? String == "deep_link" {
            guard let raw = input["url"] as? String, let url = sanitizeURL(raw, policy: policy) else { return nil }
            fields["url"] = url
        }
        if input["type"] as? String == "launch" {
            fields.removeValue(forKey: "arguments")
            if let arguments = input["arguments"] as? [String: Any] {
                let keys = arguments.keys.filter { policy.launchArgumentKeys.contains($0) }.sorted().prefix(16)
                if !keys.isEmpty { fields["arguments"] = Dictionary(uniqueKeysWithValues: keys.map { ($0, arguments[$0]!) }) }
            }
        }
        return (redact(fields) as? [String: Any]).flatMap(bound)
    }
    static func bound(_ input: [String: Any]) -> [String: Any]? {
        guard let type = input["type"] as? String, let source = input["source"] as? String, ["native", "app"].contains(source),
              let time = interactionNumber(input["observedAt"]), time >= 0 else { return nil }
        var out: [String: Any] = ["type": type, "source": source, "observedAt": time]
        func required(_ key: String, _ options: Set<String>) -> Bool {
            guard let value = input[key] as? String, options.contains(value) else { return false }; out[key] = value; return true
        }
        func requiredText(_ key: String, _ max: Int) -> Bool {
            guard let value = text(input[key] as? String, max: max), !value.isEmpty else { return false }; out[key] = value; return true
        }
        func value() { if let value = text(input["value"] as? String, max: 256) { out["value"] = value } }
        switch type {
        case "text_edit":
            guard let length = position(input["length"]), required("reason", ["idle", "end", "submit", "freeze"]) else { return nil }
            out["length"] = length; value()
        case "control_change":
            guard required("control", ["switch", "checkbox", "slider", "radio", "picker"]) else { return nil }
            switch input["control"] as? String {
            case "switch", "checkbox": guard let checked = interactionBool(input["checked"]) else { return nil }; out["checked"] = checked
            case "slider": guard let number = interactionNumber(input["position"]) else { return nil }; out["position"] = number
            default: guard requiredText("optionId", 128) else { return nil }; value()
            }
        case "scroll":
            guard required("axis", ["x", "y"]), required("direction", ["forward", "backward"]) else { return nil }
            if let item = input["item"] as? [String: Any], let bounded = target(item) { out["item"] = bounded }
        case "deep_link":
            guard var url = input["url"] as? String, !url.contains("\0"), required("delivery", ["initial", "subsequent"]) else { return nil }
            if url.utf16.count > 1024 { url = String(url.prefix(while: { $0 != "?" })) }
            guard !url.isEmpty, url.utf16.count <= 1024 else { return nil }; out["url"] = url
        case "permission":
            guard requiredText("permission", 128), required("phase", ["requested", "result"]) else { return nil }
            if input["phase"] as? String == "result", !required("result", ["granted", "denied", "blocked", "limited", "unavailable", "unknown"]) { return nil }
        case "launch":
            guard required("start", ["cold", "warm"]) else { return nil }
            if let trigger = input["trigger"] as? String, ["link", "notification"].contains(trigger) { out["trigger"] = trigger }
            if let args = input["arguments"] as? [String: Any] {
                var safe: [String: Any] = [:]
                for key in args.keys.sorted().prefix(16) {
                    guard let safeKey = text(RedactionEngine().redact(key), max: 128), !safeKey.isEmpty else { continue }
                    if let string = args[key] as? String, let bounded = text(string, max: 128) { safe[safeKey] = bounded }
                    else if let boolean = interactionBool(args[key]) { safe[safeKey] = boolean }
                    else if let number = interactionNumber(args[key]) { safe[safeKey] = number }
                }
                if !safe.isEmpty { out["arguments"] = safe }
            }
        default: return nil
        }
        func oversized() -> Bool { (try? JSONSerialization.data(withJSONObject: out).count).map { $0 > 4096 } ?? true }
        if oversized() { out.removeValue(forKey: "arguments") }
        if oversized(), type == "deep_link", let url = out["url"] as? String { out["url"] = String(url.prefix(while: { $0 != "?" })) }
        if oversized() { out.removeValue(forKey: "value") }
        if oversized() { out.removeValue(forKey: "item") }
        return oversized() ? nil : out
    }
    static func storageData(_ data: [String: EverframeJSONAny]) -> [String: EverframeJSONAny]? {
        guard let input = data["interaction"]?.value as? [String: Any], let event = bound(input) else { return nil }
        var out: [String: Any] = ["interaction": event]
        if let input = data["target"]?.value as? [String: Any], let bounded = target(input) { out["target"] = bounded }
        return BreadcrumbRingBuffer.coerceHostData(out)
    }
    static func target(_ input: [String: Any]) -> [String: Any]? {
        var out: [String: Any] = [:]
        for key in ["name", "testId", "role", "screen"] {
            if let value = text(input[key] as? String, max: key == "role" ? 64 : 256), !value.isEmpty { out[key] = value }
        }
        if let source = input["nameFrom"] as? String, ["accessibility", "text", "testId", "className", "annotation"].contains(source) { out["nameFrom"] = source }
        if interactionBool(input["masked"]) == true { out["masked"] = true }
        if let container = input["container"] as? [String: Any] {
            var nested: [String: Any] = [:]
            for key in ["name", "testId", "role"] {
                if let value = text(container[key] as? String, max: key == "role" ? 64 : 256), !value.isEmpty { nested[key] = value }
            }
            let index = position(container["index"]), count = position(container["count"])
            if index == nil || count == nil || index! < count! { nested["index"] = index; nested["count"] = count }
            if !nested.isEmpty { out["container"] = nested }
        }
        return out.isEmpty ? nil : out
    }
    static func redact(_ input: Any) -> Any {
        if let string = input as? String { return RedactionEngine().redact(string) }
        if let object = input as? [String: Any] { return object.mapValues(redact) }
        if let array = input as? [Any] { return array.map(redact) }
        return input
    }
    private static func sanitizeURL(_ raw: String, policy: InteractionEventPolicy) -> String? {
        guard raw.utf16.count <= 8192, !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0 == "\\" }),
              let components = URLComponents(string: raw), let origin = interactionOrigin(components) else { return nil }
        let rule = policy.urlRules.first { $0.origin == origin }
        let path = components.percentEncodedPath
        let safePath = rule?.literalPaths.first { $0 == path } ?? rule?.routes.sorted().first { route in
            let parts = route.components(separatedBy: "/"), actual = path.components(separatedBy: "/")
            return parts.count == actual.count && parts.indices.allSatisfy { parts[$0] == actual[$0] || (parts[$0].hasPrefix(":") && !actual[$0].isEmpty) }
        } ?? ""
        var query: [String] = [], seen: Set<String> = []
        let safeCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
        for pair in (components.percentEncodedQuery ?? "").components(separatedBy: "&") {
            let pieces = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let key = pieces.first.map(String.init)?.replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  rule?.queryKeys.contains(key) == true, seen.insert(key).inserted, query.count < 16,
                  let rawValue = (pieces.count == 2 ? String(pieces[1]) : "").replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = text(RedactionEngine().redact(rawValue), max: 128), let safeKey = text(RedactionEngine().redact(key), max: 128),
                  let encodedKey = safeKey.addingPercentEncoding(withAllowedCharacters: safeCharacters), let encodedValue = value.addingPercentEncoding(withAllowedCharacters: safeCharacters) else { continue }
            query.append(encodedKey + "=" + encodedValue)
        }
        return origin + safePath + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
    }
    private static func position(_ value: Any?) -> Double? {
        guard let number = interactionNumber(value), number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }; return number
    }
    private static func text(_ value: String?, max: Int) -> String? {
        guard let value, !value.contains("\0") else { return nil }
        var units = Array(value.utf16.prefix(max))
        if let last = units.last, (0xD800...0xDBFF).contains(last) { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }
}
