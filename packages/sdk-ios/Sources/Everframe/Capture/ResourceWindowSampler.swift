// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report EverframeResource Window (spec 2026-09-05) — periodic CPU/memory sampler
// feeding `ResourceRingBuffer.shared`. CPU comes from `task_info` with
// `TASK_THREAD_TIMES_INFO` (user + system time delta over wall-clock delta);
// memory from `task_vm_info`'s `phys_footprint`. Every mach call checks its
// `kern_return_t` and skips the affected value on failure — never traps,
// never force-unwraps.
//
// Deviation from the brief's literal "Produces: ResourceWindowSampler
// (start(windowProvider:), stop())": the brief's OWN test code constructs
// the type as `ResourceWindowSampler(windowProvider: { 60 })` — i.e. the
// constructor, not `start()`, takes the window provider. Followed the test
// code (authoritative) over the prose summary; `start()`/`stop()` take no
// arguments.
//
// CPU-baseline-across-suspend bug (constraint, mirrors a real fix the web
// Everframe SDK already needed): a CPU-TIME delta taken across a suspended app
// reports the ENTIRE frozen gap as usage, since wall-clock time keeps
// advancing while the process is stopped but its consumed CPU time does
// not (so the fraction blows up, or in degenerate cases looks like 100%+
// sustained usage for the whole background span). Sampling pauses while
// backgrounded and the baseline RESETS on resume (`noteResumed`), so the
// very next sample measures only its own post-resume interval.
import Foundation
#if canImport(UIKit)
import UIKit
#endif

public final class ResourceWindowSampler: @unchecked Sendable {
    /// Mirrors protocol's `RESOURCE_SAMPLE_INTERVAL_MS` (2_000ms). Fixed —
    /// not configurable; only the window length is a knob.
    public static let sampleIntervalSec: TimeInterval = 2.0

    private let windowProvider: () -> Int
    private let lock = NSLock()

    private var timer: Timer?
    private var isPaused = false
    private var hasBaseline = false
    private var baselineWallSec: Double = 0
    private var baselineCpuSec: Double = 0

    #if canImport(UIKit)
    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?
    #endif

    public init(windowProvider: @escaping () -> Int) {
        self.windowProvider = windowProvider
    }

    // MARK: - Pure arithmetic (the testable seam)

    /// Mirrors protocol's `MAX_CPU_CORES` (`packages/protocol/src/resources.ts`)
    /// — the schema's hard ceiling on `cpu` (`z.number().min(0).max(1024)`).
    /// A value past this (a clock anomaly, not a real multicore reading —
    /// even a 64-core box tops out nowhere near 1024) must be CLAMPED, not
    /// shipped verbatim: one over-ceiling sample fails schema validation and
    /// rejects the whole report, non-retryably, the same catastrophic
    /// failure mode `cpu: nil`-on-negative below exists to prevent.
    static let maxCPUCores: Double = 1024

    /// Fraction of ONE core: a delta of one second of CPU over one second of
    /// wall time is 1.0; two cores fully busy is 2.0. Guards against a
    /// zero/negative wall delta (clock oddities) by returning 0 rather than
    /// dividing by zero or reporting a negative fraction.
    ///
    /// Deliberately NOT clamped/floored here — this is the pure arithmetic
    /// primitive `ResourceRingBufferTests.testCPUFractionArithmetic` pins
    /// verbatim (brief task-10), and it can legitimately be asked to compute
    /// a negative quotient (a negative `cpuDeltaSec`). The decision of what
    /// to SHIP for a negative or over-ceiling result belongs one layer up,
    /// in `fractionSinceBaseline`'s caller (`tick()`, via
    /// `safeFractionSinceBaseline`) — this function stays an honest
    /// division, nothing more.
    public static func cpuFraction(cpuDeltaSec: Double, wallDeltaSec: Double) -> Double {
        guard wallDeltaSec > 0 else { return 0 }
        return cpuDeltaSec / wallDeltaSec
    }

    /// Establishes a fresh baseline at (atWallSec, cpuSec) — called on
    /// `start()` (seed) and on every foreground resume (reset), so the delta
    /// taken across a suspended app is NEVER measured: the gap itself is
    /// discarded, not reported as usage.
    public func noteResumed(atWallSec: Double, cpuSec: Double) {
        lock.lock(); defer { lock.unlock() }
        baselineWallSec = atWallSec
        baselineCpuSec = cpuSec
        hasBaseline = true
    }

    /// The CPU fraction over the interval since the last baseline (set by
    /// `noteResumed` or a previous call to this method), then MOVES the
    /// baseline forward to (atWallSec, cpuSec) so the next call measures
    /// only its own interval. Returns 0 (never traps/force-unwraps) when no
    /// baseline has been established yet — production call sites instead
    /// check `noteResumed` was already called via the tick's own bookkeeping
    /// (see `tick()`) so a genuinely baseline-less first sample ships with
    /// `cpu: nil`, not a fabricated 0.0.
    @discardableResult
    public func fractionSinceBaseline(atWallSec: Double, cpuSec: Double) -> Double {
        lock.lock()
        defer {
            baselineWallSec = atWallSec
            baselineCpuSec = cpuSec
            hasBaseline = true
            lock.unlock()
        }
        guard hasBaseline else { return 0 }
        return Self.cpuFraction(cpuDeltaSec: cpuSec - baselineCpuSec, wallDeltaSec: atWallSec - baselineWallSec)
    }

    /// Fix round 1, CRITICAL 2 — the production call site's actual seam.
    /// `TASK_THREAD_TIMES_INFO` reports CUMULATIVE cpu time for LIVE THREADS
    /// ONLY: when a thread that had accrued time exits between two samples,
    /// the aggregate DECREASES, so `cpuSec - baselineCpuSec` can go
    /// negative even though nothing is wrong — ordinary behaviour for any
    /// app whose thread pool churns across a 2s sampling interval, not a
    /// theoretical edge case. Shipping that raw negative verbatim fails the
    /// schema's `cpu: z.number().min(0)...` and rejects the WHOLE report,
    /// non-retryably — the identical failure mode the "omit cpu, never
    /// null" rule exists to prevent, arriving through a different door.
    ///
    /// A negative result here means the baseline itself is stale/impossible
    /// to reconcile against this reading, so the honest answer is "no valid
    /// sample" (`nil`), not a fabricated non-negative number — mirrors the
    /// existing no-baseline-yet posture in `tick()`. `fractionSinceBaseline`
    /// ALWAYS re-baselines via its own `defer` (moves forward to
    /// `(atWallSec, cpuSec)` regardless of this guard), so the very next
    /// call measures a fresh interval from here, never compounding the
    /// stale reading forward.
    ///
    /// The upper end is independently clamped to `maxCPUCores` — a clock
    /// anomaly (not a real reading) must not exceed the schema's ceiling
    /// either, for the identical reject-the-whole-report reason.
    func safeFractionSinceBaseline(atWallSec: Double, cpuSec: Double) -> Double? {
        let raw = fractionSinceBaseline(atWallSec: atWallSec, cpuSec: cpuSec)
        guard raw >= 0 else { return nil }
        return min(raw, Self.maxCPUCores)
    }

    // MARK: - Lifecycle

    /// Whether the repeating timer is currently armed. Internal (not
    /// public) — a test-observability seam (mirrors `NetworkBodyCaptureGate
    /// .isActive`), not part of the public capture API; production callers
    /// only ever need `start()`/`stop()`, which are already idempotent.
    internal var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return timer != nil
    }

    /// Fix round 1, IMPORTANT 1 — test-observability seam. The wall-clock
    /// instant of the CURRENT baseline (nil if none has been established
    /// yet). Lets a test PROVE the foreground-resume observer actually
    /// moved the baseline forward to "now", rather than trusting internal
    /// state no test could otherwise observe (the baseline fields
    /// themselves are `private`, and `resumeFromForeground()`'s reset uses
    /// the REAL clock — a test cannot predict its exact value, only bound
    /// it between two real `ProcessInfo.processInfo.systemUptime` reads
    /// taken immediately before/after posting the notification).
    internal var baselineWallSecForTesting: Double? {
        lock.lock(); defer { lock.unlock() }
        return hasBaseline ? baselineWallSec : nil
    }

    /// Idempotent. Starts the 2s repeating timer and (on platforms that
    /// have it) registers background/foreground observers. No-op if already
    /// running.
    public func start() {
        lock.lock()
        guard timer == nil else { lock.unlock(); return }
        lock.unlock()

        let t = Timer(timeInterval: Self.sampleIntervalSec, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(t, forMode: .common)

        lock.lock()
        timer = t
        isPaused = false
        hasBaseline = false
        lock.unlock()

        #if canImport(UIKit)
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.pauseForBackground() }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.resumeFromForeground() }
        #endif
    }

    /// Idempotent. Invalidates the timer and tears down any lifecycle
    /// observers.
    public func stop() {
        lock.lock()
        timer?.invalidate()
        timer = nil
        lock.unlock()

        #if canImport(UIKit)
        if let o = backgroundObserver { NotificationCenter.default.removeObserver(o) }
        if let o = foregroundObserver { NotificationCenter.default.removeObserver(o) }
        backgroundObserver = nil
        foregroundObserver = nil
        #endif
    }

    private func pauseForBackground() {
        lock.lock(); isPaused = true; lock.unlock()
    }

    /// Resets the baseline HERE, synchronously, on resume — not lazily on
    /// the next tick — so the frozen background span is discarded
    /// immediately rather than being folded into whatever tick happens to
    /// run next.
    private func resumeFromForeground() {
        let wall = ProcessInfo.processInfo.systemUptime
        if let cpuSec = Self.readCPUTimeSec() {
            noteResumed(atWallSec: wall, cpuSec: cpuSec)
        } else {
            lock.lock(); hasBaseline = false; lock.unlock()
        }
        lock.lock(); isPaused = false; lock.unlock()
    }

    private func tick() {
        lock.lock()
        let paused = isPaused
        let hadBaseline = hasBaseline
        lock.unlock()
        guard !paused else { return }

        // Memory is mandatory on a `ResourceSample` — a failed mach call
        // skips the WHOLE sample rather than shipping a fabricated value.
        guard let memBytes = Self.readMemoryFootprint() else { return }

        var cpu: Double?
        let wall = ProcessInfo.processInfo.systemUptime
        if let cpuSec = Self.readCPUTimeSec() {
            if hadBaseline {
                // safeFractionSinceBaseline (fix round 1, CRITICAL 2): ships
                // nil rather than a fabricated negative number when a
                // thread-exit makes the raw delta go negative, and clamps
                // an anomalous upper end to the schema's ceiling.
                cpu = safeFractionSinceBaseline(atWallSec: wall, cpuSec: cpuSec)
            } else {
                // First tick since start()/resume(): no valid interval to
                // measure yet. Seed the baseline and ship `cpu: nil` for
                // this one sample rather than a fabricated delta against
                // an implicit zero baseline.
                noteResumed(atWallSec: wall, cpuSec: cpuSec)
            }
        }
        // cpu read failure: never traps — `cpu` simply stays nil for this
        // sample, mirrored by every consumer that already treats `cpu` as
        // absent-on-some-platforms (web has no CPU API at all).

        ResourceRingBuffer.shared.windowSec = windowProvider()
        let sample = ResourceSample(
            t: Int64(Date().timeIntervalSince1970 * 1000),
            cpu: cpu,
            mem: memBytes
        )
        ResourceRingBuffer.shared.append(sample)
    }

    // MARK: - Mach calls (Darwin) — every call checks kern_return_t; never traps.

    private static func readCPUTimeSec() -> Double? {
        var info = task_thread_times_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_thread_times_info_data_t>.size / MemoryLayout<integer_t>.size
        )
        let kr: kern_return_t = withUnsafeMutablePointer(to: &info) { infoPtr -> kern_return_t in
            infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                task_info(mach_task_self_, task_flavor_t(TASK_THREAD_TIMES_INFO), intPtr, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        let user = Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1_000_000
        let system = Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1_000_000
        return user + system
    }

    private static func readMemoryFootprint() -> Int64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
        )
        let kr: kern_return_t = withUnsafeMutablePointer(to: &info) { infoPtr -> kern_return_t in
            infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), intPtr, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        return Int64(info.phys_footprint)
    }
}
