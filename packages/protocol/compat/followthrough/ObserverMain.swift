// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
@_silgen_name("observer_payload_roundtrip")
func roundtrip(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
guard let output = text.withCString({ roundtrip($0) }) else { fatalError("roundtrip failed") }
print(String(cString: output)); free(output)
