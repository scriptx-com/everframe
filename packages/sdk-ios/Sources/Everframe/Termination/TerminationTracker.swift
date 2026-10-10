// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Writers for one run's termination state. Lifecycle callbacks run synchronously on the posting
/// (main) thread and only store into the mapping; sampling runs on a utility queue every 5 s while
/// not in background. Reuses ProcessResources (Vitals/ResourceSampler.swift) for memory readings.
final class TerminationTracker: @unchecked Sendable {
    struct Readers: Sendable {
        var footprint: @Sendable () -> Int64 = { ProcessResources.physFootprintBytes() }
        var available: @Sendable () -> Int64? = { ProcessResources.availableMemoryBytes() }
        var thermal: @Sendable () -> Int = { ProcessResources.thermalState() }
        var debugger: @Sendable () -> Bool = { TerminationSystem.debuggerAttached() }
        var uptimeMs: @Sendable () -> UInt64 = { TerminationSystem.uptimeMs() }
        var now: @Sendable () -> Date = { Date() }
        /// Tests turn the 5 s timer off and drive `sampleOnce()` themselves.
        var sampling = true
        /// os_proc_available_memory() returns 0 on the simulator; that is unknown, not "at the limit".
        #if targetEnvironment(simulator)
        var simulator = true
        #else
        var simulator = false
        #endif
    }
    struct Notifications: Sendable { let active, inactive, background, foreground, terminate, memoryWarning: Notification.Name }
    static let interval: DispatchTimeInterval = .seconds(5)

    private let file: TerminationStateFile, readers: Readers, queue: DispatchQueue, center: NotificationCenter
    private let ping: @Sendable (@escaping @Sendable () -> Void) -> Void
    private var tokens: [NSObjectProtocol] = []
    private var warnings: UInt64 = 0                         // posting (main) thread only
    private var pingSince: UInt64?                           // queue only
    private var timer: DispatchSourceTimer?                  // queue only
    private var pressure: DispatchSourceMemoryPressure?      // set once in init, before it can fire

    init(file: TerminationStateFile, readers: Readers, queue: DispatchQueue, center: NotificationCenter,
         notifications: Notifications, initial: TerminationAppState, ping: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void) {
        self.file = file; self.readers = readers; self.queue = queue; self.center = center; self.ping = ping
        lifecycle(initial)
        let observe = { (name: Notification.Name, action: @escaping @Sendable () -> Void) -> NSObjectProtocol in
            center.addObserver(forName: name, object: nil, queue: nil) { _ in action() }
        }
        tokens = [
            observe(notifications.active) { [weak self] in self?.lifecycle(.active) },
            observe(notifications.inactive) { [weak self] in self?.lifecycle(.inactive) },
            observe(notifications.background) { [weak self] in self?.lifecycle(.background) },
            // Returning to the foreground is inactive until didBecomeActive.
            observe(notifications.foreground) { [weak self] in self?.lifecycle(.inactive) },
            observe(notifications.terminate) { [weak self] in self?.file.store(1, at: TerminationLayout.terminateAt) },
            observe(notifications.memoryWarning) { [weak self] in self?.memoryWarning() },
        ]
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: queue)
        source.setEventHandler { [weak self] in self?.pressureChanged() }
        pressure = source
        source.resume()
    }
    deinit { for token in tokens { center.removeObserver(token) }; timer?.cancel(); pressure?.cancel() }

    private func lifecycle(_ state: TerminationAppState) {
        file.store(state.rawValue, at: TerminationLayout.appStateAt)
        file.store(readers.now(), at: TerminationLayout.stateChangedAt)
        queue.async { if state == .background { self.pause() } else { self.resume() } }
    }
    private func memoryWarning() {
        warnings += 1
        file.store(warnings, at: TerminationLayout.warningsAt)
        file.store(readers.now(), at: TerminationLayout.lastWarningAt)
        queue.async { self.sampleOnce() }
    }
    /// Queue only.
    private func pressureChanged() {
        guard let event = pressure?.data else { return }
        let level: TerminationPressure = event.contains(.critical) ? .critical : event.contains(.warning) ? .warning : .normal
        file.store(level.rawValue, at: TerminationLayout.pressureAt)
        file.store(readers.now(), at: TerminationLayout.pressureChangedAt)
        sampleOnce()
    }
    /// Queue only (tests call it directly with a private queue they never use concurrently).
    /// An outstanding main-thread ping becomes the stall; a new ping is sent only once it returns.
    /// The returning ping clears the stored stall at once: a stall that resolved must not turn a
    /// later force-quit, before the next sample, into an unresponsive termination.
    func sampleOnce() {
        let uptime = readers.uptimeMs()
        file.store(pingSince.map { uptime &- $0 } ?? 0, at: TerminationLayout.stallAt)
        file.store(UInt64(max(0, readers.footprint())), at: TerminationLayout.footprintAt)
        let available = readers.available().flatMap { readers.simulator && $0 == 0 ? nil : UInt64(max(0, $0)) }
        file.store(available ?? TerminationLayout.unknown, at: TerminationLayout.availableAt)
        file.store(UInt64(max(0, readers.thermal())), at: TerminationLayout.thermalAt)
        if readers.debugger() { file.store(1, at: TerminationLayout.debuggerAt) }
        file.store(uptime, at: TerminationLayout.sampleUptimeAt)
        file.store(readers.now(), at: TerminationLayout.sampledAt)
        guard pingSince == nil else { return }
        pingSince = uptime
        ping { [weak self] in
            guard let self else { return }
            self.file.store(self.readers.uptimeMs(), at: TerminationLayout.mainSeenAt)
            self.file.store(0, at: TerminationLayout.stallAt)
            // Again on the queue: a sample that read the outstanding ping before this ran may have
            // stored the stall after the clear above.
            self.queue.async { self.pingSince = nil; self.file.store(0, at: TerminationLayout.stallAt) }
        }
    }
    func drainForTesting() { queue.sync {} }
    private func resume() {
        guard readers.sampling, timer == nil else { return }
        let next = DispatchSource.makeTimerSource(queue: queue)
        next.schedule(deadline: .now(), repeating: Self.interval, leeway: .seconds(1))
        next.setEventHandler { [weak self] in self?.sampleOnce() }
        timer = next; next.resume()
    }
    /// Background audio and PiP keep the process alive, but background kills are out of scope.
    private func pause() { timer?.cancel(); timer = nil; pingSince = nil; file.store(0, at: TerminationLayout.stallAt) }
}

nonisolated(unsafe) private var terminationExitFile: TerminationStateFile?
nonisolated(unsafe) private var terminationExitInstalled = false
/// exit() and a return from main run atexit handlers; SIGKILL and _exit() do not.
private func terminationExitHandler() { terminationExitFile?.store(1, at: TerminationLayout.exitAt) }

#if canImport(UIKit)
extension TerminationTracker {
    nonisolated(unsafe) private static var retained: TerminationTracker?
    /// Called once per process from the native-crash worker after the header is written.
    static func startForApplication(_ file: TerminationStateFile) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                terminationExitFile = file
                if !terminationExitInstalled { terminationExitInstalled = true; atexit(terminationExitHandler) }
                let initial: TerminationAppState
                switch UIApplication.shared.applicationState {
                case .active: initial = .active
                case .inactive: initial = .launching
                case .background: initial = .background
                @unknown default: initial = .unknown
                }
                retained = TerminationTracker(file: file, readers: Readers(), queue: DispatchQueue(label: "dev.everframe.termination", qos: .utility),
                    center: .default, notifications: .init(active: UIApplication.didBecomeActiveNotification,
                        inactive: UIApplication.willResignActiveNotification, background: UIApplication.didEnterBackgroundNotification,
                        foreground: UIApplication.willEnterForegroundNotification, terminate: UIApplication.willTerminateNotification,
                        memoryWarning: UIApplication.didReceiveMemoryWarningNotification),
                    initial: initial, ping: { DispatchQueue.main.async(execute: $0) })
            }
        }
    }
}
#endif
