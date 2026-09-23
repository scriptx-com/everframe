// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Fakes shared by the vitals controller / runtime / integration suites — twins
// of the private fakes in VitalsControllerTest.kt and Media3TestSupport.kt.
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class FakeIntegration: PlayerIntegration, @unchecked Sendable {
    let library: String
    let version: String?
    private let ok: Bool
    var ctx: PlayerIntegrationContext?
    /// Counted, like the Kotlin fake's: the runtime suites assert how many times a
    /// registration was handed to a controller (a shutdown refusal re-attaches, so
    /// "did it end up registered?" and "how often was attach() run?" are different
    /// questions and `ctx` alone cannot answer the second).
    var attached = 0
    var detached = 0
    var described = 0
    var snap: PlayerSnapshot?
    var deferSnapshot = false
    var deferred: ((PlayerSnapshot?) -> Bool)?
    var playing = false
    var buffering = false
    var onSnapshotAnswer: ((Bool) -> Void)?
    /// When set, detach(onComplete:) stores the completion instead of calling it (async teardown).
    var deferDetach = false
    var pendingComplete: (() -> Void)?
    var onAttach: (() -> Void)?

    init(ok: Bool = true, library: String = "fake", version: String? = "1") { self.ok = ok; self.library = library; self.version = version }

    func attach(_ ctx: PlayerIntegrationContext) -> Bool { self.ctx = ctx; attached += 1; onAttach?(); return ok }
    func snapshot(_ onResult: @escaping (PlayerSnapshot?) -> Bool) {
        if deferSnapshot { deferred = onResult; return }
        // `onSnapshotAnswer?(onResult(snap))` would SHORT-CIRCUIT: optional
        // chaining skips argument evaluation when the base is nil, so an
        // integration nobody is watching would never answer at all.
        let answered = onResult(snap)
        onSnapshotAnswer?(answered)
    }
    func startupTimings() -> StartupTimings? { nil }
    func describe(_ ctx: PlayerIntegrationContext) {
        described += 1
        ctx.emit("source_change", data: ["src": "s", "protocol": "hls"], t: nil)
        if playing { ctx.emit("play", data: nil, t: nil) }
        if buffering { ctx.emit("buffer_start", data: nil, t: nil) }
    }
    func detach() { detached += 1 }
    func detach(onComplete: @escaping () -> Void) {
        detach()
        if deferDetach { pendingComplete = onComplete } else { onComplete() }
    }
}

final class RecordingContext: PlayerIntegrationContext, @unchecked Sendable {
    struct Emitted: Equatable { let type: String; let data: [String: VitalsJSON]?; let t: Int64? }
    private(set) var emitted: [Emitted] = []
    var accepts = true
    /// Called with each type as it is emitted, BEFORE the emission is answered — the seam a
    /// test uses to drive a re-entrant transition from inside the collector callback.
    var onEmit: ((String) -> Void)?
    private let clock: () -> Int64
    init(clock: @escaping () -> Int64) { self.clock = clock }
    @discardableResult func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool {
        emitted.append(Emitted(type: type, data: JsonCoerce.toObject(data), t: t))
        onEmit?(type)
        return accepts
    }
    func now() -> Int64 { clock() }
    var types: [String] { emitted.map(\.type) }
    func last(_ type: String) -> Emitted? { emitted.last { $0.type == type } }
}

final class RecordingSink: VitalsSink, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var bodies: [Data] = []
    private(set) var closes = 0
    /// Round-1, #9 — a graceful finish is NOT a close: the server-disable path must let the
    /// trailing chunk and the final summary land, and only kill()/a superseding start() cancel.
    private(set) var finishes = 0
    private(set) var finishTimeoutMs: Int64?
    func send(_ body: Data) { lock.lock(); bodies.append(body); lock.unlock() }
    func close() { lock.lock(); closes += 1; lock.unlock() }
    func finish(timeoutMs: Int64) { lock.lock(); finishes += 1; finishTimeoutMs = timeoutMs; lock.unlock() }
    /// Decoded `payload` objects, in send order.
    var payloads: [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return bodies.compactMap { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["payload"] as? [String: Any] }
    }
    var kinds: [String] { payloads.compactMap { $0["kind"] as? String } }
    /// Every player-event `type` across every chunk, in order.
    var playerEventTypes: [String] {
        payloads.filter { $0["kind"] as? String == "chunk" }
            .flatMap { ($0["entries"] as? [[String: Any]]) ?? [] }
            .filter { $0["kind"] as? String == "player" }
            .compactMap { $0["type"] as? String }
    }
}
