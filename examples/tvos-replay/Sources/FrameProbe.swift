// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import UIKit
import Darwin

/// Host-only probe. No metric hooks or file output are added to the Everframe SDK.
@MainActor final class FrameProbe: NSObject {
    private var link: CADisplayLink?
    private var previous: CFTimeInterval?
    private var started: CFTimeInterval = 0
    private var lastSave: CFTimeInterval = 0
    private var intervals: [Double] = []
    private var resources: [[String: Double]] = []
    private var focusChanges = 0
    var animate: ((Double) -> Void)?

    func start() {
        started = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFramesPerSecond = 60
        link.add(to: .main, forMode: .common)
        self.link = link
    }
    func focused() { focusChanges += 1 }

    @objc private func tick(_ link: CADisplayLink) {
        let elapsed = link.timestamp - started
        // Fixed five-second warmup excluded equally for every configuration.
        if elapsed > 5, let previous, intervals.count < 120_000 {
            intervals.append((link.timestamp - previous) * 1000)
        }
        previous = link.timestamp
        animate?(max(0, elapsed - 5))
        if elapsed - lastSave >= 5 {
            lastSave = elapsed
            save(elapsed: elapsed)
        }
    }

    private func save(elapsed: Double) {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        let cpu = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
            + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
        if resources.count < 1000 {
            resources.append(["elapsedSec": elapsed, "cpuSeconds": cpu,
                "footprintMiB": status == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1])
        }
        let frames = intervals, samples = resources, focus = focusChanges
        let run = ProcessInfo.processInfo.environment["REPLAY_TV_RUN"] ?? "manual"
        let mode = ProcessInfo.processInfo.environment["REPLAY_TV_MODE"] ?? "server-config"
        let output = ProbeFiles.url("metrics.json")
        Task.detached(priority: .utility) {
            let sorted = frames.sorted()
            func percentile(_ fraction: Double) -> Double {
                guard !sorted.isEmpty else { return 0 }
                return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * fraction))]
            }
            let json: [String: Any] = ["run": run, "modeLabel": mode, "elapsedSec": elapsed,
                "warmupSec": 5, "frameSamples": frames.count, "focusChanges": focus,
                "p50Ms": percentile(0.5), "p95Ms": percentile(0.95), "p99Ms": percentile(0.99),
                "maxMs": sorted.last ?? 0, "over33ms": frames.filter { $0 > 33.5 }.count,
                "over50ms": frames.filter { $0 > 50 }.count, "resources": samples]
            do { try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .prettyPrinted]).write(to: output, options: .atomic) }
            catch { NSLog("ReplayTV metrics write failed") }
        }
    }
    deinit { link?.invalidate() }
}
