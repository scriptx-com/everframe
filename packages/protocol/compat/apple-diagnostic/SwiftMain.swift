// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
@_silgen_name("e8_payload_roundtrip")
func e8PayloadCopy(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
let input = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
guard let output = input.withCString({ e8PayloadCopy($0) }) else { fatalError("frozen E8 payload caller failed") }
print(String(cString: output))
free(output)
