// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of VitalsTransport.kt. One retry after 5 s on network error / 5xx /
// 429 (Retry-After honoured, capped 60 s); never on any other 4xx; every
// failure swallowed; vitals never touch disk or the JSONL outbox; the kill
// predicate is read fresh at every send boundary INCLUDING the retry.
//
// One sink per COLLECTOR (Android round-2, Important 14): the controller
// builds one when a collector starts and closes it when that collector stops,
// so retries and in-flight tasks die at the boundary instead of no-op'ing later.
import Foundation

protocol VitalsSink: AnyObject, Sendable {
    func send(_ body: Data)
    /// Cancel every scheduled retry and every in-flight task. Idempotent.
    func close()
    /// GRACEFUL close, for the server-disable path (codex round-1, #9). The collector's
    /// `stop()` has just handed this sink its trailing chunk and its final summary as
    /// asynchronous tasks; `close()` cancels them mid-connection, so with any ordinary
    /// connection delay neither ever lands. `finish` stops new sends and suppresses retries
    /// immediately, lets what is already on the wire complete, and cancels the remainder after
    /// `timeoutMs`. `kill()` and a superseding `start()` keep using `close()`.
    func finish(timeoutMs: Int64)
}

extension VitalsSink {
    /// A sink with nothing asynchronous in flight has nothing to wait for.
    func finish(timeoutMs: Int64) { close() }
}

final class VitalsTransport: VitalsSink, @unchecked Sendable {
    private let session: URLSession
    private let endpoint: URL
    private let apiKey: String
    private let isKilled: @Sendable () -> Bool
    private let queue: DispatchQueue
    private let retryDelayMs: Int64
    private let maxRetryAfterMs: Int64

    private let lock = NSLock()
    private var closed = false
    /// Sealed for NEW work but not cancelled: `finish` sets it, and the timeout closes for real.
    private var finishing = false
    private var scheduled: [UUID: DispatchWorkItem] = [:]
    private var inFlight: [ObjectIdentifier: URLSessionTask] = [:]

    init(session: URLSession, endpoint: URL, apiKey: String, isKilled: @escaping @Sendable () -> Bool,
         queue: DispatchQueue = VitalsQueue.shared, retryDelayMs: Int64 = 5_000, maxRetryAfterMs: Int64 = 60_000) {
        self.session = session; self.endpoint = endpoint; self.apiKey = apiKey; self.isKilled = isKilled
        self.queue = queue; self.retryDelayMs = retryDelayMs; self.maxRetryAfterMs = maxRetryAfterMs
    }

    func send(_ body: Data) { dispatch("VitalsTransport.send") { attempt(body, isRetry: false) } }

    func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let items = Array(scheduled.values); scheduled.removeAll()
        let tasks = Array(inFlight.values); inFlight.removeAll()
        lock.unlock()
        items.forEach { $0.cancel() }
        tasks.forEach { $0.cancel() }
    }

    func finish(timeoutMs: Int64) {
        lock.lock()
        if closed || finishing { lock.unlock(); return }
        finishing = true
        let items = Array(scheduled.values); scheduled.removeAll()
        lock.unlock()
        // Retries are SUPPRESSED, not awaited: a request that has already failed once is not
        // worth holding a disabled session open for.
        items.forEach { $0.cancel() }
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs))) { [weak self] in self?.close() }
    }

    /// Sealed against new work — closed outright, or finishing what is already in flight.
    private var isSealed: Bool { lock.lock(); defer { lock.unlock() }; return closed || finishing }

    private func attempt(_ body: Data, isRetry: Bool) {
        if isSealed || isKilled() { return }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let taskIdBox = Locked<ObjectIdentifier?>(nil)
        // Strong `self` (not `[weak self]`): `send()` is fire-and-forget — the
        // caller isn't required to hold the sink alive across the async round
        // trip for its own retry to complete. This does form a momentary
        // self -> inFlight[task] -> closure -> self cycle, but it always
        // self-resolves: the completion below removes the task from
        // `inFlight` as its first act, and a cancelled task (via `close()`)
        // still invokes its completion handler with `.cancelled`.
        let task = session.dataTask(with: req) { [self] _, response, error in
            if let taskId = taskIdBox.value { self.lock.lock(); self.inFlight.removeValue(forKey: taskId); self.lock.unlock() }
            if isRetry { return }
            if let error {
                if (error as? URLError)?.code == .cancelled { return }
                self.retryLater(body, delayMs: self.retryDelayMs); return
            }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(code) { return }
            if code == 429 {
                self.retryLater(body, delayMs: Self.retryAfterMs(header: (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
                                                                 fallbackMs: self.retryDelayMs, maxMs: self.maxRetryAfterMs))
            } else if code >= 500 {
                self.retryLater(body, delayMs: self.retryDelayMs)
            }
            // any other 4xx: permanent rejection — dropped, vitals are lossy.
        }
        let taskId = ObjectIdentifier(task)
        taskIdBox.mutate { $0 = taskId }
        lock.lock()
        // Still `closed`, NOT `finishing`: this task is what `finish()` waits for.
        if closed {
            // Codex round-5, W5-I2 — CANCEL, and outside the lock. The task exists but never
            // entered `inFlight`, so the `close()` that just ran could not reclaim it and no
            // later one ever will: it belongs to a process-lifetime `URLSession`, its completion
            // retains this transport and the request body, and a task that was never resumed has
            // no timeout to end it either. Cancelling an unresumed task is well defined — it
            // moves to `.completing`/`.completed` and its completion handler runs with
            // `URLError.cancelled`, which the handler above returns from without retrying.
            lock.unlock()
            task.cancel()
            return
        }
        inFlight[taskId] = task
        lock.unlock()
        task.resume()
    }

    /// Negative/unparseable → fallback; otherwise seconds*1000 capped at `maxMs`.
    static func retryAfterMs(header: String?, fallbackMs: Int64, maxMs: Int64) -> Int64 {
        guard let raw = header?.trimmingCharacters(in: .whitespaces), let secs = Int64(raw), secs >= 0 else { return fallbackMs }
        return min(secs, maxMs / 1000) * 1000
    }

    /// Codex round-2, #2 — the key is a UUID minted BEFORE the work item, and the block captures
    /// that value, never the item. Keying on `ObjectIdentifier(item)` forced the block to close
    /// over the mutable `item` variable, and a captured `var` lives in a heap capture box that
    /// holds the work item strongly: `item → block → box → item` is a cycle `DispatchWorkItem`
    /// keeps alive for good, because it retains its block whether it runs, is cancelled, or is
    /// simply dropped. Removing the entry from `scheduled` broke only the transport's edge, so
    /// every network error and every 503 permanently leaked the work item, the request body and
    /// the strongly captured transport — one per failure.
    ///
    /// Strong `self` in the block is still deliberate, for the same fire-and-forget reason as
    /// `attempt`: with a UUID key the only cycle left is `self → scheduled[id] → item → block →
    /// self`, and the first act of the block (and of `close()`) is to break it.
    private func retryLater(_ body: Data, delayMs: Int64) {
        let id = UUID()
        let item = DispatchWorkItem { [self] in
            self.lock.lock(); self.scheduled.removeValue(forKey: id); self.lock.unlock()
            dispatch("VitalsTransport.retry") { self.attempt(body, isRetry: true) }
        }
        lock.lock()
        if closed || finishing { lock.unlock(); return }   // no retries once the session is over
        scheduled[id] = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(delayMs)), execute: item)
    }
}
