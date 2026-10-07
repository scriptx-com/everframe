// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
@_silgen_name("old_payload_roundtrip")
func oldPayloadCopy(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
let input = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
guard let output = input.withCString({ oldPayloadCopy($0) }) else { fatalError("frozen payload caller failed") }
print(String(cString: output))
free(output)
