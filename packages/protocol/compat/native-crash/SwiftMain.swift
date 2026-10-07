// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
@_silgen_name("old_native_crash_roundtrip")
func oldRoundtrip(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("old_native_crash_legacy_roundtrip")
func oldLegacyRoundtrip(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
let input = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
for call in [oldRoundtrip, oldLegacyRoundtrip] {
    guard let output = input.withCString({ call($0) }) else { fatalError("frozen caller failed") }
    print(String(cString: output))
    free(output)
}
