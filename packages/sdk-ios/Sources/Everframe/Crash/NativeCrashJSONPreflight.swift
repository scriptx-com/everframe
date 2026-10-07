// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Bounds allocation and rejects ambiguous object keys before typed Foundation decoding.
/// JSON syntax and numeric validity remain JSONDecoder's responsibility.
enum NativeCrashJSONPreflight {
    private struct Container {
        let object: Bool
        var expectingKey: Bool
        var keys = Set<String>()
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
                    stack[last].expectingKey = false
                }
            } else if byte == 123 || byte == 91 {
                guard stack.count < 64 else { throw Failure.inputLimit }
                stack.append(Container(object: byte == 123, expectingKey: byte == 123))
            } else if byte == 125 || byte == 93 {
                guard let top = stack.popLast(), top.object == (byte == 125) else { throw Failure.malformed }
            } else if byte == 44, let last = stack.indices.last, stack[last].object {
                stack[last].expectingKey = true
            }
            index += 1
        }
        guard stack.isEmpty else { throw Failure.malformed }
    }
}
