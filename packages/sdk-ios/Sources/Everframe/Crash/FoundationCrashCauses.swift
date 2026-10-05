// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Foundation exposes a linear underlying error, not a per-cause throw stack.
internal func captureFoundationCauseChain(
    _ error: any Error, redact: (String) throws -> String, stillOwned: () -> Bool
) -> EverframeCrashCauseChain? {
    guard stillOwned() else { return nil }
    var causes: [EverframeCrashCause] = []
    var truncated = false
    var visited = Set<ObjectIdentifier>()
    func identity(_ value: any Error) -> ObjectIdentifier? {
        guard type(of: value) is AnyClass else { return nil }
        return ObjectIdentifier(value as AnyObject)
    }
    if let outer = identity(error) { visited.insert(outer) }

    func underlying(_ value: any Error) -> (next: (any Error)?, lost: Bool) {
        let info: [String: Any]
        if type(of: value) is NSError.Type { info = (value as NSError).userInfo }
        else if let custom = value as? any CustomNSError { info = custom.errorUserInfo }
        else { return (nil, false) }
        guard stillOwned() else { return (nil, false) }
        let branching = info[NSMultipleUnderlyingErrorsKey] != nil
        guard let raw = info[NSUnderlyingErrorKey] else { return (nil, branching) }
        guard let next = raw as? any Error else { return (nil, true) }
        return (next, branching)
    }
    var link = underlying(error)
    guard stillOwned() else { return nil }
    truncated = link.lost
    while let current = link.next {
        guard stillOwned() else { return nil }
        if causes.count == 8 { truncated = true; break }
        if let id = identity(current), !visited.insert(id).inserted { truncated = true; break }
        // Read the next link before descriptions; every host step is followed by
        // an ownership check. Never describe arbitrary non-Error metadata.
        link = underlying(current)
        guard stillOwned() else { return nil }
        truncated = truncated || link.lost
        let exceptionType: String
        if type(of: current) is NSError.Type {
            let native = current as NSError
            let domain = native.domain
            guard stillOwned() else { return nil }
            let code = native.code
            guard stillOwned() else { return nil }
            exceptionType = "\(domain):\(code)"
        } else { exceptionType = String(reflecting: type(of: current)) }
        let message = current.localizedDescription
        guard stillOwned() else { return nil }
        let typePrefix = CrashCauseText.prefix(exceptionType, limit: 8192)
        let messagePrefix = CrashCauseText.prefix(message, limit: 8192)
        truncated = truncated || typePrefix.lost || messagePrefix.lost
        causes.append(EverframeCrashCause(exceptionType: typePrefix.text, frames: [], framesTruncated: false, message: messagePrefix.text))
    }
    guard !causes.isEmpty || truncated else { return nil }
    return normalizeCrashCauseChain(RNCrashCausesWire(causes: causes, truncated: truncated), redact: redact, stillOwned: stillOwned)
}
