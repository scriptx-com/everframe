// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Bounds allocation and rejects ambiguous object keys before typed Foundation decoding.
/// Structural integer lexemes are checked before Foundation can round decimals.
/// JSON syntax and integer ranges remain JSONDecoder's responsibility.
enum NativeCrashJSONPreflight {
    private struct Container {
        let object: Bool
        let path: [String]
        var key: String?
        var expectingKey: Bool
        var keys = Set<String>()
    }
    private static let integerPaths: Set<[String]> = {
        var paths: Set<[String]> = [["report", "timestamp"], ["crash", "error", "address"],
            ["crash", "threads", "index"], ["crash", "threads", "backtrace", "skipped"]]
        for key in ["image_addr", "image_vmaddr", "image_size", "cpu_type", "cpu_subtype"] {
            paths.insert(["binary_images", key])
        }
        for key in ["instruction_addr", "object_addr"] {
            paths.insert(["crash", "threads", "backtrace", "contents", key])
        }
        for key in ["exception", "code", "subcode"] { paths.insert(["crash", "error", "mach", key]) }
        for key in ["signal", "code"] { paths.insert(["crash", "error", "signal", key]) }
        return paths
    }()
    private static func valuePath(_ container: Container?) -> [String] {
        guard let container else { return [] }
        return container.object ? container.path + (container.key.map { [$0] } ?? []) : container.path
    }
    static func validate(_ data: Data) throws {
        typealias Failure = NativeCrashRecordDecoder.Failure
        guard !data.isEmpty, data.count <= 2 * 1024 * 1024 else { throw Failure.inputLimit }
        let bytes = Array(data)
        var stack: [Container] = [], index = 0
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 34 {
                let start = index
                index += 1
                while index < bytes.count, bytes[index] != 34 {
                    if bytes[index] == 92 { index += 1 }
                    index += 1
                }
                guard index < bytes.count else { throw Failure.malformed }
                if let last = stack.indices.last, stack[last].object, stack[last].expectingKey {
                    // An escaped key can consume at most six bytes per decoded ASCII byte.
                    guard index - start <= 6145 else { throw Failure.inputLimit }
                    let key: String
                    do { key = try JSONDecoder().decode(String.self, from: Data(bytes[start...index])) }
                    catch { throw Failure.malformed }
                    guard key.utf8.count <= 1024 else { throw Failure.inputLimit }
                    guard stack[last].keys.insert(key).inserted else { throw Failure.duplicateKey }
                    stack[last].key = key
                    stack[last].expectingKey = false
                }
            } else if byte == 123 || byte == 91 {
                guard stack.count < 64 else { throw Failure.inputLimit }
                stack.append(Container(object: byte == 123, path: valuePath(stack.last), expectingKey: byte == 123))
            } else if byte == 125 || byte == 93 {
                guard let top = stack.popLast(), top.object == (byte == 125) else { throw Failure.malformed }
            } else if byte == 44, let last = stack.indices.last, stack[last].object {
                stack[last].expectingKey = true
                stack[last].key = nil
            } else if byte == 45 || (48...57).contains(byte) {
                let start = index
                while index < bytes.count, (48...57).contains(bytes[index]) || [43, 45, 46, 69, 101].contains(bytes[index]) {
                    index += 1
                }
                if integerPaths.contains(valuePath(stack.last)),
                   bytes[start..<index].contains(where: { $0 == 46 || $0 == 69 || $0 == 101 }) {
                    // Pinned recorder structural fields use integer spelling. Even integral
                    // decimal/exponent forms are rejected; ignored metadata may use them.
                    throw Failure.malformed
                }
                index -= 1
            }
            index += 1
        }
        guard stack.isEmpty else { throw Failure.malformed }
    }
}
