// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// safeWrap (`dispatch{}`) — DEFE-02 foundation. All Everframe SDK entry points wrap their
// internal work in `dispatch("label") { ... }` so an unexpected throw is
// recorded internally rather than propagating into the host app. Per RESEARCH
// "Code Examples" we ship sync, async, and Void overloads (Swift overload
// resolution gets ambiguous on closures with no explicit return; the explicit
// Void overload disambiguates at call sites like
// `dispatch("foo") { try install() }` where `install()` returns Void).
import Foundation

@discardableResult
public func dispatch<T>(_ label: StaticString = "unspecified", _ work: () throws -> T) -> T? {
    do { return try work() }
    catch {
        InternalLogger.recordSafeWrapFailure(label: label, error: error)
        return nil
    }
}

@discardableResult
public func dispatch<T>(_ label: StaticString = "unspecified", _ work: () async throws -> T) async -> T? {
    do { return try await work() }
    catch {
        InternalLogger.recordSafeWrapFailure(label: label, error: error)
        return nil
    }
}

/// Void overload — disambiguates closures that return Void at call sites.
public func dispatch(_ label: StaticString = "unspecified", _ work: () throws -> Void) {
    do { try work() }
    catch {
        InternalLogger.recordSafeWrapFailure(label: label, error: error)
    }
}
