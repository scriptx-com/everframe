// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Byte-budgeted ring buffer for captured network request/response bodies
// (spec network-body-capture). Unlike NetworkRingBuffer (count-capped at
// 100), this buffer is budgeted by TOTAL UTF-8 byte cost of the stored
// bodies — reqBody + resBody summed across all entries — since bodies can
// vary from empty to hundreds of KB each. Entries are appended in `t`
// order, so eviction is head-first (oldest first), same shape as the
// metadata ring buffers.
//
// Freeze/discardAndResume/takeFrozen/clear lifecycle + NSLock discipline
// mirror BreadcrumbRingBuffer.swift:143-175 exactly.
import Foundation
import TraceItXProtocol

public final class NetworkBodyRingBuffer: @unchecked Sendable {
    public static let shared = NetworkBodyRingBuffer()

    /// Default total byte budget across all buffered reqBody + resBody
    /// strings (spec default).
    public static let defaultTotalBudget = 262_144

    /// Final-review Finding 1 (post-kill capture): when true (default),
    /// `append` consults `TraceItX.shared.captureGate` — mirrors
    /// `NetworkRingBuffer.honorsKillGate` exactly (same rationale: a
    /// still-in-flight request's completion handler can race `kill()` and
    /// try to append after the kill switch has flipped; the buffer itself
    /// must refuse, not just the caller). Set to false ONLY for unit tests
    /// that exercise budget/eviction independently of global kill-switch
    /// state, since cross-suite parallel tests can flip the global gate
    /// mid-run.
    internal let honorsKillGate: Bool

    /// Test-only seam (PR review round 4 Finding F15): invoked, when set, at
    /// the exact point between the cheap pre-lock gate read below and the
    /// `lock.lock()` call — i.e. the window a paused thread could otherwise
    /// occupy while `kill()` flips the gate and `clear()` zeroizes the
    /// buffer out from under it. Always nil in production (zero overhead:
    /// one optional-closure check). See `NetworkBodyRingBufferTests` for the
    /// regression test that drives this hook from a second thread.
    internal var preLockHook: (() -> Void)?

    private let lock = NSLock()
    private var entries: [NetworkBody] = []
    private var frozen: [NetworkBody]?
    private var totalBytes: Int = 0
    private var budget: Int = NetworkBodyRingBuffer.defaultTotalBudget

    public init() {
        self.honorsKillGate = true
    }

    /// Test-only init that bypasses the global kill-gate check (mirrors
    /// `NetworkRingBuffer`'s test-only init).
    internal init(honorsKillGate: Bool) {
        self.honorsKillGate = honorsKillGate
    }

    /// Final-review Finding 2 (unbounded zero-cost entries): a fixed
    /// per-entry overhead so an entry with NO bodies (204s, content-type
    /// skips) still costs something and remains subject to eviction —
    /// without this, zero-body entries' refs/skip-metadata/header maps could
    /// grow the buffer without bound while `totalBytes` never crossed the
    /// budget.
    private static let entryOverhead = 256

    /// Byte cost of a single entry: UTF-8 byte count of `reqBody` +
    /// `resBody` (nil bodies cost 0) + UTF-8 byte count of every header key
    /// and value in `reqHeaders`/`resHeaders` + a fixed `entryOverhead` so
    /// body-less entries are still bounded (Finding 2).
    private static func cost(_ entry: NetworkBody) -> Int {
        (entry.reqBody?.utf8.count ?? 0) + (entry.resBody?.utf8.count ?? 0)
            + headerBytes(entry.reqHeaders) + headerBytes(entry.resHeaders)
            + entryOverhead
    }

    private static func headerBytes(_ headers: [String: String]?) -> Int {
        guard let headers else { return 0 }
        return headers.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
    }

    /// Re-budget the buffer. Non-positive values are ignored (config/host
    /// input — never let a bad value zeroize the chain). Shrinking evicts
    /// oldest entries immediately to bring `totalBytes` back under budget.
    public func setTotalBudget(_ bytes: Int) {
        lock.lock(); defer { lock.unlock() }
        guard bytes >= 1 else { return }
        budget = bytes
        evictToFitLocked()
    }

    /// Add an entry, then evict oldest (by append order / `t`) while the
    /// running total exceeds the budget. Honors the kill switch — capture-
    /// side responsibility per DEFE-03, mirrors `NetworkRingBuffer.append`.
    ///
    /// PR review round 4 Finding F15: the check above is only a cheap fast
    /// path — it runs BEFORE the lock is acquired, so a thread that reads
    /// `captureGate == true` here can still be descheduled before
    /// `lock.lock()`, let `kill()` run to completion on another thread
    /// (which flips `captureGate` false and THEN calls `clear()` — see
    /// `TraceItX.kill()`), and only then resume and insert into a buffer
    /// `clear()` just zeroized. The re-check below, taken while HOLDING the
    /// lock immediately before the insert, is the authoritative one and is
    /// what makes this race-free: because `kill()` flips the gate strictly
    /// before calling `clear()`, if we observe the gate still open here,
    /// `clear()` has not run yet and will subsequently take this same lock
    /// and wipe the entry we're about to add; if we observe it closed, we
    /// simply never insert. Either way the post-kill buffer ends up empty.
    ///
    /// Round-7 review Finding F34: `` `guard` ``, when non-nil, is evaluated
    /// INSIDE `lock` — the very last thing checked before the insert —
    /// exactly like the kill-gate re-check above, and for the same reason.
    /// The production call site (`NetworkCaptureProtocol.swift`) passes a
    /// closure capturing the `NetworkBodyCaptureGate` generation observed at
    /// DECISION time (before the possibly-slow `NetworkBodyCapture.makeEntry`
    /// work), so a remote `captureBodies: false` config refresh that lands
    /// between that decision and this append — bumping the gate's
    /// generation — is caught here even though nothing upstream of `append`
    /// re-checks the gate. `nil` (the default) skips the check entirely, so
    /// every existing call site that doesn't care about gate-generation
    /// validity (budget/eviction/freeze/kill-gate unit tests) is unaffected.
    public func append(_ entry: NetworkBody, `guard`: (() -> Bool)? = nil) {
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        preLockHook?()
        lock.lock(); defer { lock.unlock() }
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        if let `guard`, !`guard`() { return }
        entries.append(entry)
        totalBytes += Self.cost(entry)
        evictToFitLocked()
    }

    private func evictToFitLocked() {
        while totalBytes > budget, !entries.isEmpty {
            let removed = entries.removeFirst()
            totalBytes -= Self.cost(removed)
        }
    }

    /// Snapshot the chain at reporter-open. Idempotent — never a second
    /// snapshot while one is already held.
    public func freeze() {
        lock.lock(); defer { lock.unlock() }
        if frozen == nil { frozen = entries }
    }

    /// Drop the frozen snapshot (reporter cancelled). Live capture continues.
    public func discardAndResume() {
        lock.lock(); defer { lock.unlock() }
        frozen = nil
    }

    /// Return + clear the frozen snapshot, or nil if freeze() was never called.
    public func takeFrozen() -> [NetworkBody]? {
        lock.lock(); defer { lock.unlock() }
        let out = frozen
        frozen = nil
        return out
    }

    /// Non-destructive copy of the LIVE chain. Independent of the freeze
    /// lifecycle.
    public func snapshot() -> [NetworkBody] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    /// Zeroize everything (logout / identity change / kill switch).
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
        totalBytes = 0
        frozen = nil
    }
}
