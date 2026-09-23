// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RED-phase tests for safeWrap (`dispatch{}`) sync + async overloads. The
// dispatch helper must NEVER propagate errors to the host — it returns nil and
// records an internal failure.
import Testing
import Foundation
@testable import EverframeKit

@Suite(.serialized)
struct SafeWrapTests {
    @Test func dispatchSync_swallowsThrowingError_returnsNil() {
        // Drain first to isolate from parallel test runs.
        InternalLogger.drainFailures()
        let result: Int? = dispatch("test-sync-unique-label-1") { () throws -> Int in
            throw NSError(domain: "x", code: 1)
        }
        #expect(result == nil)
        let drained = InternalLogger.drainFailures()
        #expect(drained.contains(where: { $0.label == "test-sync-unique-label-1" }))
    }

    @Test func dispatchSync_returnsValue_onSuccess() {
        let result: Int? = dispatch("ok-sync") { 42 }
        #expect(result == 42)
    }

    @Test func dispatchAsync_swallowsThrowingError_returnsNil() async {
        InternalLogger.drainFailures()  // clear from any prior tests
        let result: Int? = await dispatch("test-async") { () async throws -> Int in
            throw NSError(domain: "y", code: 2)
        }
        #expect(result == nil)
        let drained = InternalLogger.drainFailures()
        #expect(drained.contains(where: { $0.label == "test-async" }))
    }

    @Test func dispatchAsync_returnsValue_onSuccess() async {
        let result: Int? = await dispatch("ok-async") { () async throws -> Int in
            return 7
        }
        #expect(result == 7)
    }

    @Test func dispatchVoid_swallowsThrowingError() {
        InternalLogger.drainFailures()
        dispatch("void-test") { () throws -> Void in
            throw NSError(domain: "z", code: 3)
        }
        let drained = InternalLogger.drainFailures()
        #expect(drained.contains(where: { $0.label == "void-test" }))
    }
}
