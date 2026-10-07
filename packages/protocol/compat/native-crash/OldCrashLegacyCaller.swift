// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
import EverframeProtocol
@_cdecl("old_native_crash_legacy_roundtrip")
public func oldNativeCrashLegacyRoundtrip(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    do {
        let decoded = try EverframeCrash(String(cString: json))
        let copy = decoded.with(details:exceptionType:fatal:fingerprint:frames:handled:jsBundle:jvm:mechanism:message:occurredAt:threadName:)
        return strdup(try copy(nil, nil, nil, nil, nil, nil, nil, nil, nil, "legacy copy", nil, nil).jsonString())
    } catch { return nil }
}
