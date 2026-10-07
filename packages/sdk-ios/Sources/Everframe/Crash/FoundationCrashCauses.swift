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
    // Hold each visited class-backed error. An identifier alone does not retain,
    // so an error that `userInfo` built on demand and then freed could lend its
    // address to a later link and look like a cycle.
    var visited: [AnyObject] = []
    func object(_ value: any Error) -> AnyObject? {
        type(of: value) is AnyClass ? value as AnyObject : nil
    }
    if let outer = object(error) { visited.append(outer) }

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
        if let node = object(current) {
            if visited.contains(where: { $0 === node }) { truncated = true; break }
            visited.append(node)
        }
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
