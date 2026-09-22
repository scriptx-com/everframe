// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Swift Testing runs different `@Suite` types CONCURRENTLY by default;
// `.serialized` on a suite only serializes tests WITHIN that suite.
// `BreadcrumbRingBufferTests` and `BreadcrumbAdaptersTests` both drive the
// same process-wide `BreadcrumbRingBuffer.shared` singleton's LIVE config
// (`applyConfig`) — a reset in one suite (`resetBreadcrumbState()`'s
// `applyConfig(nil)`, which re-enables ALL kinds) can land in the middle of
// another suite's mutate -> act -> assert window on a disabled-kind test,
// flipping an "isEmpty" assertion that filters by kind rather than by a
// unique per-test message.
//
// Both test files acquire this lock around any section that mutates OR
// asserts on `.shared`'s live config, to serialize those windows across
// suites.
//
// Invariant: never acquire this lock while ALREADY HOLDING the buffer's
// internal lock. Holding THIS lock while calling buffer methods (which take
// their own lock) is the intended usage — the ordering is test-lock-outer,
// buffer-lock-inner. Every acquisition site in these test files follows that
// order already (lock this lock first, then call into
// `BreadcrumbRingBuffer.shared`), so there is no lock-ordering deadlock risk
// in practice; the invariant just says which direction is safe.
import Foundation

enum BreadcrumbSharedStateTestLock {
    static let lock = NSLock()
}
