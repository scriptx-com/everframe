// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — lock-protected FIFO ring buffer
// for CPU/memory samples. Attached to report and crash envelopes as
// `payload.resources`. Mirrors `packages/protocol/src/resources.ts`'s
// `ResourceSample` shape (t/cpu/mem) and `MAX_RESOURCE_SAMPLES` cap.
//
// Template: LogRingBuffer.swift (NSLock, cap, kill-gate — mirrored exactly,
// including the test-only `honorsKillGate`-bypassing init). Deliberately NOT
// lock-free/atomic: iOS crash capture is not an async-signal context today
// (CrashReporter.swift already calls BreadcrumbRingBuffer.shared.snapshot()
// under a lock on the crash path), so this buffer follows the same
// discipline as its siblings rather than an async-signal-safe design.
//
// `windowSec` is a mutable, lock-guarded property (not captured once at
// construction) so a live `/api/config` refresh can widen or narrow the
// eviction horizon without an SDK restart — see ReplayConfigProvider.swift's
// `ResourcesConfigWire` and ReplaySession.swift's `applyConfig`, which writes
// `ResourceRingBuffer.shared.windowSec` on every resolved config, the same
// way it reads `configBox.value.replayDurationSec` live rather than caching
// it.
import Foundation

public struct ResourceSample: Codable, Sendable {
    /// Epoch ms — same shared clock as breadcrumbs.
    public let t: Int64
    /// Fraction of ONE core (0–n; >1 legal on multicore). `nil` when a mach
    /// call failed for this tick (never force-unwrapped/trapped) — and
    /// Swift's default `JSONEncoder` OMITS a nil Optional from the encoded
    /// JSON rather than emitting `"cpu": null` (asserted by
    /// ResourceEnvelopeTests, not merely assumed): an explicit null fails
    /// the server's schema validation and drops the WHOLE report.
    public let cpu: Double?
    /// Bytes — iOS: `task_vm_info.phys_footprint`.
    public let mem: Int64

    public init(t: Int64, cpu: Double?, mem: Int64) {
        self.t = t
        self.cpu = cpu
        self.mem = mem
    }
}

public final class ResourceRingBuffer: @unchecked Sendable {
    public static let shared = ResourceRingBuffer(windowSec: ResourceRingBuffer.defaultWindowSec)

    /// Mirrors protocol's `MAX_RESOURCE_SAMPLES` — a stamp exceeding this
    /// makes the server reject the WHOLE report (400, non-retryable), not
    /// merely drop the resources block.
    public static let maxSamples = 256

    /// Mirrors protocol's `DEFAULT_RESOURCE_WINDOW_SEC`.
    public static let defaultWindowSec = 60

    /// See LogRingBuffer.honorsKillGate — same rationale.
    internal let honorsKillGate: Bool

    private let lock = NSLock()
    private var entries: [ResourceSample] = []
    private var _windowSec: Int

    public init(windowSec: Int = ResourceRingBuffer.defaultWindowSec) {
        self._windowSec = windowSec
        self.honorsKillGate = true
    }

    /// Test-only init that bypasses the global kill-gate check.
    internal init(windowSec: Int, honorsKillGate: Bool) {
        self._windowSec = windowSec
        self.honorsKillGate = honorsKillGate
    }

    /// Read/write live — a config refresh applies to every subsequent
    /// append/snapshot with no SDK restart (see ReplaySession.applyConfig).
    public var windowSec: Int {
        get { lock.lock(); defer { lock.unlock() }; return _windowSec }
        set { lock.lock(); defer { lock.unlock() }; _windowSec = newValue }
    }

    /// The real, testable seam — CONTROLLER RULING (task-10-brief.md):
    /// entries are stamped in epoch ms (t=0..70_000 in tests), so a bare
    /// `now()` read against the real clock would evict everything and every
    /// eviction assertion would be vacuous. Production call sites use the
    /// `append(_:)` convenience below.
    public func append(_ e: ResourceSample, now: Int64) {
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        lock.lock(); defer { lock.unlock() }
        entries.append(e)
        evictLocked(now: now)
    }

    /// Convenience defaulting `now` to the current epoch ms — the real
    /// production call site (the sampler's periodic tick).
    public func append(_ e: ResourceSample) {
        append(e, now: Self.nowMs())
    }

    /// The real, testable seam — see `append(_:now:)`'s doc comment; the
    /// same rationale applies here (CONTROLLER RULING).
    public func snapshot(now: Int64) -> [ResourceSample] {
        lock.lock(); defer { lock.unlock() }
        evictLocked(now: now)
        return entries
    }

    /// Convenience defaulting `now` to the current epoch ms — the real
    /// production call site (report/crash envelope stamping, Task 11).
    public func snapshot() -> [ResourceSample] {
        snapshot(now: Self.nowMs())
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
    }

    /// Evict by age FIRST (against the live `_windowSec`, read fresh on
    /// every call — never cached), THEN apply the hard cap, keeping the
    /// newest entries. Must be called with `lock` already held.
    private func evictLocked(now: Int64) {
        let windowMs = Int64(_windowSec) * 1000
        let cutoff = now - windowMs
        entries.removeAll { $0.t < cutoff }
        if entries.count > Self.maxSamples {
            entries.removeFirst(entries.count - Self.maxSamples)
        }
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
