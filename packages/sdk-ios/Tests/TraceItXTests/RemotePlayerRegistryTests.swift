// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import TraceItXKit

final class RemotePlayerRegistryTests: XCTestCase {
    private final class FakeHandle: PlayerHandle {
        let id: String; var tracked: [(String, Any?)] = []; var detached = 0
        init(id: String) { self.id = id }
        func track(_ name: String, data: Any?) { tracked.append((name, data)) }
        func detach() { detached += 1 }
    }
    private final class Ctx: PlayerIntegrationContext {
        var types: [String] = []
        func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool { types.append(type); return true }
        func now() -> Int64 { 0 }
    }
    private var registered: [(PlayerIntegration, String?)] = []
    private var handles: [FakeHandle] = []
    private var sessionLines: [(String, Any?)] = []
    private lazy var registry = RemotePlayerRegistry(
        register: { [unowned self] i, n in self.registered.append((i, n)); let h = FakeHandle(id: "p\(self.handles.count + 1)"); self.handles.append(h); return h },
        sessionTrack: { [unowned self] n, d in self.sessionLines.append((n, d)) },
        captureSourceQuery: { false })

    func testTrackRegistersWithLibraryVersionName() {
        XCTAssertTrue(registry.track(token: "rp1", library: "theoplayer", name: "main", libraryVersion: "9.0"))
        XCTAssertEqual(registered[0].1, "main"); XCTAssertEqual(registered[0].0.library, "theoplayer"); XCTAssertEqual(registered[0].0.version, "9.0")
    }
    func testDuplicateLiveTokenIgnored() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        XCTAssertFalse(registry.track(token: "rp1", library: "b", name: nil, libraryVersion: nil)); XCTAssertEqual(registered.count, 1)
    }
    func testDetachFreesTokenUnknownNoop() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        XCTAssertTrue(registry.detach(token: "rp1")); XCTAssertEqual(handles[0].detached, 1)
        XCTAssertFalse(registry.detach(token: "rp1")); XCTAssertFalse(registry.detach(token: "nope"))
        XCTAssertTrue(registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil))
    }
    /// `detachAll` is what the RN module calls on instance teardown (a Metro /
    /// OTA reload). Every handle is detached exactly ONCE (so each open
    /// play/buffer span closes once, not twice) and a second call is a no-op.
    ///
    /// Codex round-1, C5 — and the teardown is TERMINAL: the tokens do NOT become
    /// re-trackable. This registry belongs to one module instance (since C4 the iOS one is
    /// per-instance too), and the reload builds a NEW instance with a NEW registry for the
    /// new bundle, so anything still calling this one is code from the dead bundle.
    /// (Before C5 this test asserted the opposite — re-trackable tokens — which is the
    /// expectation the ruling changed.)
    func testDetachAllDetachesEachHandleOnceIsIdempotentAndClosesTheRegistry() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        _ = registry.track(token: "rp2", library: "b", name: nil, libraryVersion: nil)
        XCTAssertEqual(handles.count, 2)

        registry.detachAll()
        XCTAssertEqual(handles[0].detached, 1)
        XCTAssertEqual(handles[1].detached, 1)

        // Terminal: neither token comes back, and nothing new registers.
        XCTAssertFalse(registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil))
        XCTAssertFalse(registry.track(token: "rp3", library: "c", name: nil, libraryVersion: nil))
        XCTAssertEqual(registered.count, 2)

        // Idempotent — and it does not re-detach the handles it already closed.
        registry.detachAll()
        registry.detachAll()
        XCTAssertEqual(handles.count, 2)
        for h in handles { XCTAssertEqual(h.detached, 1) }
    }

    /// EVERY host-facing entry point no-ops once closed, `trackVitals` included.
    ///
    /// Codex round-8, J1 — this used to let a custom line fall through to `sessionTrack`
    /// (session-scoped by nature, no player to attribute it to). But `sessionTrack` is
    /// process-global: a line arriving through a torn-down module — the old bundle's
    /// unsubscribed listener, a queued callback — landed in the session a NEWER instance
    /// had since started. It is now dropped, with and without a token. (The unknown-token
    /// fallback while the registry is OPEN is unchanged; see the routing test below.)
    func testAfterDetachAllEveryEntryPointNoopsIncludingTrackVitals() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        registry.detachAll()
        XCTAssertFalse(registry.track(token: "rp2", library: "b", name: nil, libraryVersion: nil))
        XCTAssertFalse(registry.record(token: "rp1", type: "play", t: 1.757e12, data: nil))
        XCTAssertFalse(registry.updateStats(token: "rp1", stats: ["bufferAheadMs": 1.0]))
        XCTAssertFalse(registry.detach(token: "rp1"))
        registry.trackVitals(name: "x", dataJson: "1", token: "rp1")
        registry.trackVitals(name: "y", dataJson: "1", token: nil)
        XCTAssertTrue(sessionLines.isEmpty)                // neither form reaches the live session
        XCTAssertTrue(handles[0].tracked.isEmpty)          // the dead handle got nothing
    }

    /// Codex round-1, C5 — `register()` runs OUTSIDE the lock, so a `detachAll()` on
    /// another thread can land in the middle of a `track()`. A register callback that calls
    /// `detachAll()` itself drives that interleaving deterministically: the in-flight
    /// registration must be REFUSED, its handle detached, and the map left empty — otherwise
    /// it survives the teardown that was meant to end it.
    func testDetachAllDuringRegisterRefusesTheInFlightRegistration() {
        final class Box { var reg: RemotePlayerRegistry? }
        let box = Box()
        var made: [FakeHandle] = []
        let reg = RemotePlayerRegistry(
            register: { _, _ in
                box.reg?.detachAll()
                let h = FakeHandle(id: "p\(made.count + 1)"); made.append(h); return h
            },
            sessionTrack: { _, _ in },
            captureSourceQuery: { false })
        box.reg = reg
        XCTAssertFalse(reg.track(token: "rp1", library: "a", name: nil, libraryVersion: nil))
        XCTAssertEqual(made.count, 1)
        XCTAssertEqual(made[0].detached, 1)
        XCTAssertFalse(reg.detach(token: "rp1"))           // nothing was ever published
        XCTAssertFalse(reg.record(token: "rp1", type: "play", t: 1.757e12, data: nil))
    }

    func testRecordAndStatsRouteAndRefuseUnknown() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        let i = registered[0].0 as! RemotePlayerIntegration; let ctx = Ctx(); _ = i.attach(ctx)
        XCTAssertTrue(registry.record(token: "rp1", type: "play", t: 1.757e12, data: nil)); XCTAssertEqual(ctx.types, ["play"])
        XCTAssertFalse(registry.record(token: "zz", type: "play", t: 1.757e12, data: nil))
        XCTAssertTrue(registry.updateStats(token: "rp1", stats: ["bufferAheadMs": 5.0])); XCTAssertFalse(registry.updateStats(token: "zz", stats: [:]))
    }
    func testRecordDropsBadTimestamp() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        XCTAssertFalse(registry.record(token: "rp1", type: "play", t: .nan, data: nil))
        XCTAssertFalse(registry.record(token: "rp1", type: "play", t: -1, data: nil))
        XCTAssertFalse(registry.record(token: "rp1", type: "play", t: 1e300, data: nil))
    }
    func testTrackVitalsRouting() {
        _ = registry.track(token: "rp1", library: "a", name: nil, libraryVersion: nil)
        registry.trackVitals(name: "ad", dataJson: #"{"id":7}"#, token: "rp1"); XCTAssertEqual(handles[0].tracked[0].0, "ad")
        registry.trackVitals(name: "cdn", dataJson: "[1,2]", token: nil); XCTAssertEqual(sessionLines[0].0, "cdn")
        registry.trackVitals(name: "x", dataJson: "not json", token: "rp1"); XCTAssertNil(handles[0].tracked[1].1)
        registry.trackVitals(name: "y", dataJson: "1", token: "gone"); XCTAssertEqual(sessionLines[1].0, "y")
    }
    /// Codex round-3, E3 — `JSONSerialization` parses `10000000000000000000` into an NSNumber
    /// whose `objCType` is `"Q"` (unsigned long long), and `JsonCoerce` CLAMPS those to
    /// `Int64.max`. The host wrote 1e19 and the wire said 9223372036854775807 — a different,
    /// plausible-looking number. On the JS side of this bridge the literal was a `Number` (a
    /// double) all along, and the Android twin parses it into one too.
    func testTrackVitalsWidensUnsignedOverflowToADouble() {
        registry.trackVitals(name: "m", dataJson: #"{"value":10000000000000000000}"#, token: nil)
        let data = try? XCTUnwrap(sessionLines[0].1 as? [String: Any])
        XCTAssertEqual(data?["value"] as? Double, 1e19)
        // …and that is what the next stop, JsonCoerce, now renders — a double, not the clamp.
        XCTAssertEqual(JsonCoerce.toJSON(sessionLines[0].1), .object(["value": .double(1e19)]))
    }

    /// Only the OVERFLOWING half of `"Q"` moves: an unsigned integer that still fits an Int64
    /// stays an integer, so nothing that was exact stops being exact. Nested containers are
    /// walked, and a bool — which also bridges to NSNumber — is left alone.
    func testTrackVitalsLeavesRepresentableAndNonNumericValuesAlone() {
        registry.trackVitals(name: "m", dataJson: #"{"fits":9223372036854775807,"deep":[{"big":18446744073709551615}],"flag":true,"s":"x"}"#, token: nil)
        XCTAssertEqual(JsonCoerce.toJSON(sessionLines[0].1), .object([
            "fits": .int(9_223_372_036_854_775_807),
            "deep": .array([.object(["big": .double(1.8446744073709552e19)])]),
            "flag": .bool(true),
            "s": .string("x"),
        ]))
    }

    func testMaxTokens() {
        for n in 0..<RemotePlayerRegistry.maxTokens { XCTAssertTrue(registry.track(token: "t\(n)", library: "a", name: nil, libraryVersion: nil)) }
        XCTAssertFalse(registry.track(token: "overflow", library: "a", name: nil, libraryVersion: nil))
    }
    func testSafeEpochMs() {
        XCTAssertEqual(RemotePlayerRegistry.safeEpochMs(1.757e12), 1_757_000_000_000)
        XCTAssertNil(RemotePlayerRegistry.safeEpochMs(.nan)); XCTAssertNil(RemotePlayerRegistry.safeEpochMs(-1)); XCTAssertNil(RemotePlayerRegistry.safeEpochMs(9.3e18))
    }
}
