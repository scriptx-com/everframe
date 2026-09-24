// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Repeating-timer seam so the collector engine is testable with a fake clock.
import Foundation

protocol VitalsCancellable: AnyObject, Sendable { func cancel() }

protocol VitalsScheduler: Sendable {
    func repeating(intervalMs: Int64, _ tick: @escaping @Sendable () -> Void) -> VitalsCancellable
}

final class DispatchVitalsScheduler: VitalsScheduler {
    private let queue: DispatchQueue
    init(queue: DispatchQueue = VitalsQueue.shared) { self.queue = queue }

    func repeating(intervalMs: Int64, _ tick: @escaping @Sendable () -> Void) -> VitalsCancellable {
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + .milliseconds(Int(intervalMs)), repeating: .milliseconds(Int(intervalMs)), leeway: .seconds(1))
        source.setEventHandler(handler: tick)
        source.resume()
        return TimerHandle(source)
    }

    private final class TimerHandle: VitalsCancellable, @unchecked Sendable {
        private let source: DispatchSourceTimer
        private let lock = NSLock()
        private var cancelled = false
        init(_ source: DispatchSourceTimer) { self.source = source }
        func cancel() {
            lock.lock(); defer { lock.unlock() }
            guard !cancelled else { return }
            cancelled = true
            source.setEventHandler {}
            source.cancel()
        }
    }
}
