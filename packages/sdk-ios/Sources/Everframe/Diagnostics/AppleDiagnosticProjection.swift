// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CoreFoundation

enum AppleDiagnosticProjection {
    static func stack(_ bytes: Data) -> AppleDiagnosticStack {
        func empty(_ status: String) -> AppleDiagnosticStack { .init(status: status, truncated: false, frames: []) }
        guard bytes.count <= 256 * 1024 else { return empty("oversized") }
        guard let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let tree = object["callStackTree"] as? [String: Any],
              let stacks = tree["callStacks"] as? [[String: Any]] else { return empty("malformed") }
        var frames: [AppleDiagnosticFrame] = []
        var pending: [(Any, Int)] = []
        var truncated = stacks.count > 512, malformed = false
        for stack in stacks.prefix(512) {
            guard let roots = stack["callStackRootFrames"] as? [Any] else { malformed = true; continue }
            let room = 512 - pending.count
            for root in roots.prefix(room) { pending.append((root, 1)) }
            if roots.count > room { truncated = true }
            if pending.count == 512 { truncated = true; break }
        }
        pending.reverse()
        var visited = 0
        while let (node, depth) = pending.popLast() {
            guard visited < 512, frames.count < 64 else { truncated = true; break }
            visited += 1
            guard depth <= 32 else { truncated = true; continue }
            guard let object = node as? [String: Any] else { malformed = true; continue }
            if let rawUUID = object["binaryUUID"] as? String, rawUUID.utf8.count <= 36,
               let uuid = UUID(uuidString: rawUUID), let name = object["binaryName"] as? String,
               name.utf8.count <= 128, !name.isEmpty, name.range(of: "^[A-Za-z0-9_.+-]+$", options: .regularExpression) != nil,
               let address = hexadecimal(object["address"]), let offset = hexadecimal(object["offsetIntoBinaryTextSegment"]) {
                frames.append(.init(binaryUUID: uuid.uuidString.lowercased(), binaryName: name, address: address, offset: offset))
            } else { malformed = true; truncated = true }
            if let children = object["subFrames"] {
                guard let children = children as? [Any] else { malformed = true; continue }
                let remaining = max(0, 512 - visited - pending.count)
                if children.count > remaining { truncated = true }
                for child in children.prefix(remaining).reversed() { pending.append((child, depth + 1)) }
            }
        }
        if frames.isEmpty { return empty(malformed ? "malformed" : "unavailable") }
        return .init(status: "available", truncated: truncated || malformed, frames: frames)
    }

    private static func hexadecimal(_ value: Any?) -> String? {
        let integer: UInt64?
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            // Integer JSON numbers are retained exactly by Foundation. Reject
            // floating-point or negative values instead of rounding an address.
            let text = number.stringValue
            integer = UInt64(text)
        } else if let text = value as? String, text.utf8.count <= 20 {
            integer = text.hasPrefix("0x") ? UInt64(text.dropFirst(2), radix: 16) : UInt64(text)
        } else { integer = nil }
        return integer.map { "0x" + String($0, radix: 16) }
    }
}
