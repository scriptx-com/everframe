// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import EverframeProtocol
public func oldNativeCopy(_ value: EverframeNativeCrashMetadata) -> EverframeNativeCrashMetadata {
    value.with(timestampMicros: "12")
}
public func oldNativeMake(_ error: EverframeNativeCrashError) -> EverframeNativeCrashMetadata {
    EverframeNativeCrashMetadata(crashedThreadIndex: 0, error: error, frames: [], framesIncomplete: false,
        images: [], imagesIncomplete: false, platform: .apple, timestampMicros: "11")
}
