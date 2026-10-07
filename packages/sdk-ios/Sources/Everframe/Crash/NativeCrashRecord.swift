// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Healthy-process normalization only. Recovery decides retention and resolves original context.
struct NativeCrashRecord {
    let reportID: UUID
    let vendorRunID: UUID?
    let contextID: UUID?
    let crash: EverframeCrash
}
