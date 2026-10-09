// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol
import OldNativeCaller
let input = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let value = try EverframeNativeCrashMetadata(data: input)
let copied = oldNativeCopy(value)
precondition(copied.timestampMicros == "12")
precondition(copied.releaseHealthEvidence?.contextID == value.releaseHealthEvidence?.contextID)
precondition(copied.releaseHealthEvidence != nil)
precondition(oldNativeMake(value.error).releaseHealthEvidence == nil)
print("OLD_NATIVE_SWIFT_OK")
