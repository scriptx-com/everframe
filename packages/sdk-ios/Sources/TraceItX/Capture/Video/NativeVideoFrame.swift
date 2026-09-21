// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

struct NativeVideoDimensions: Sendable { let width: Int; let height: Int }
struct NativeVideoPixels: Sendable {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let bgraBytes: Data
}
struct NativeVideoFrame: Sendable {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let bgraBytes: Data
    let timestampNanos: UInt64
}
