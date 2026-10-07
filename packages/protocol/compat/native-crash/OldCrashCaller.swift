// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Compile against the predecessor module, then keep this object unchanged.
import Foundation
import Darwin
import EverframeProtocol
@_cdecl("old_native_crash_roundtrip")
public func oldNativeCrashRoundtrip(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    do {
        let constructed = EverframeCrash(causeChain: nil, details: nil, exceptionType: "Synthetic",
            fatal: true, fingerprint: "aaaaaaaaaaaaaaaa", frames: [], handled: false, jsBundle: nil,
            jvm: nil, mechanism: "native-mach", message: "constructed", occurredAt: Date(timeIntervalSince1970: 1),
            threadName: nil)
        guard constructed.message == "constructed" else { return nil }
        let decoded = try EverframeCrash(String(cString: json))
        let copied = decoded.with(causeChain: .some(decoded.causeChain), message: "old copy")
        let olderCopy = copied.with(message: "older copy")
        return strdup(try olderCopy.jsonString())
    } catch { return nil }
}
