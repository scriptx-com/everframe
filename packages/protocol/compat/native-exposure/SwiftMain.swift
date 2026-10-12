// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
@_silgen_name("old_diagnostic_roundtrip")
func oldDiagnosticCopy(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
let input = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
guard let output = input.withCString({ oldDiagnosticCopy($0) }) else { fatalError("frozen diagnostic caller failed") }
print(String(cString: output))
free(output)
