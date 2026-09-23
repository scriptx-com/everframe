// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// One 20 s tick on the vitals queue (iOS spec 2026-09-05 §2).
//   cpu  = Δ clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID) / Δ MONOTONIC — fraction of one
//          core (may exceed 1 on multi-core); absent on the first tick after start/resume.
//   mem  = task_info(TASK_VM_INFO).phys_footprint in BYTES — the Xcode gauge / jetsam number.
//   extras = { availableMemory (os_proc_available_memory, iOS/tvOS only), thermalState (0–3) }
// Pause/resume/stop mirror ResourceSampler.kt: the flags are written under
// `lock` and re-checked inside the tick, on the queue, so a pause racing a
// tick can never re-arm the cadence.
import Foundation
import EverframeProtocol

enum ProcessResources {
    static func cpuTimeNs() -> UInt64 { clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID) }

    /// The CPU fraction's DENOMINATOR (codex round-4, M6). It was the entry's own epoch clock,
    /// which the user, NTP or a timezone-less DST correction can move under a running sampler:
    /// ten CPU-seconds over a real twenty-second interval read 0.0028 after an hour's forward
    /// adjustment, and a backward one dropped the sample entirely (`wallMs > 0` failed) or
    /// inflated it wildly. `CLOCK_UPTIME_RAW` cannot be set and, like the process CPU clock it is
    /// divided into, does not advance while the system is asleep — so the two agree about how
    /// much time the process was actually able to run for. The entry's `t` stays epoch time: that
    /// is a timestamp, and it has to be comparable with every other entry's.
    static func monotonicNs() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

    static func physFootprintBytes() -> Int64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
    }

    static func availableMemoryBytes() -> Int64? {
        #if os(iOS) || os(tvOS)
        return Int64(os_proc_available_memory())
        #else
        return nil
        #endif
    }

    static func thermalState() -> Int {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return 0
        case .fair: return 1
        case .serious: return 2
        case .critical: return 3
        @unknown default: return 0
        }
    }
}

class ResourceSampler: @unchecked Sendable {
    private let queue: DispatchQueue
    private let intervalMs: Int64
    private let now: @Sendable () -> Int64
    private let readCpuTimeNs: @Sendable () -> UInt64
    private let readMonotonicNs: @Sendable () -> UInt64
    private let readMemBytes: @Sendable () -> Int64
    private let readAvailableMemory: @Sendable () -> Int64?
    private let readThermalState: @Sendable () -> Int
    private let onSample: @Sendable (VitalsSample) -> Void
    private let onTick: @Sendable () -> Void

    private let lock = NSLock()
    private var running = false, paused = false, stopped = false
    private var pendingTick: DispatchWorkItem?
    private var lastCpuNs: UInt64?
    private var lastMonoNs: UInt64?

    init(queue: DispatchQueue = VitalsQueue.shared, intervalMs: Int64 = 20_000,
         now: @escaping @Sendable () -> Int64,
         readCpuTimeNs: @escaping @Sendable () -> UInt64 = { ProcessResources.cpuTimeNs() },
         readMonotonicNs: @escaping @Sendable () -> UInt64 = { ProcessResources.monotonicNs() },
         readMemBytes: @escaping @Sendable () -> Int64 = { ProcessResources.physFootprintBytes() },
         readAvailableMemory: @escaping @Sendable () -> Int64? = { ProcessResources.availableMemoryBytes() },
         readThermalState: @escaping @Sendable () -> Int = { ProcessResources.thermalState() },
         onSample: @escaping @Sendable (VitalsSample) -> Void,
         onTick: @escaping @Sendable () -> Void) {
        self.queue = queue; self.intervalMs = intervalMs; self.now = now
        self.readCpuTimeNs = readCpuTimeNs; self.readMonotonicNs = readMonotonicNs; self.readMemBytes = readMemBytes
        self.readAvailableMemory = readAvailableMemory; self.readThermalState = readThermalState
        self.onSample = onSample; self.onTick = onTick
    }

    private var active: Bool { lock.lock(); defer { lock.unlock() }; return running && !paused && !stopped }

    private func schedule() {
        let item = DispatchWorkItem { [weak self] in self?.tick() }
        pendingTick?.cancel(); pendingTick = item
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(intervalMs)), execute: item)
    }

    private func tick() {
        guard active else { return }
        dispatch("ResourceSampler.tick") { sampleOnce() }
        dispatch("ResourceSampler.onTick") { onTick() }
        lock.lock(); defer { lock.unlock() }
        if running && !paused && !stopped { schedule() }
    }

    private func sampleOnce() {
        let t = now()
        let cpuNow = readCpuTimeNs()
        let monoNow = readMonotonicNs()
        var cpu: Double?
        lock.lock()
        if let prev = lastCpuNs, let prevMono = lastMonoNs, monoNow > prevMono {
            cpu = cpuNow >= prev ? Double(cpuNow - prev) / Double(monoNow - prevMono) : 0
        }
        lastCpuNs = cpuNow; lastMonoNs = monoNow
        lock.unlock()
        var extras: [String: Double] = ["thermalState": Double(readThermalState())]
        if let avail = readAvailableMemory() { extras["availableMemory"] = Double(max(0, avail)) }
        onSample(VitalsSample(t: t, cpu: cpu, mem: max(0, readMemBytes()), extras: extras))
    }

    func start() {
        lock.lock(); defer { lock.unlock() }
        if stopped || running { return }
        running = true
        schedule()
    }

    func pause() {
        lock.lock(); defer { lock.unlock() }
        if !running || paused { return }
        paused = true
        pendingTick?.cancel(); pendingTick = nil
    }

    func resume() {
        lock.lock(); defer { lock.unlock() }
        if !running || !paused || stopped { return }
        paused = false
        lastCpuNs = nil; lastMonoNs = nil
        schedule()
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        stopped = true; running = false
        pendingTick?.cancel(); pendingTick = nil
    }

    /// Test seam: run one tick on the queue now instead of waiting `intervalMs`.
    func tickNowForTesting() { queue.async { [weak self] in self?.tick() } }
}
