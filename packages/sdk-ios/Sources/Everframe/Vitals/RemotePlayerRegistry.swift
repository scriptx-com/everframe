// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Token → registration map for host-fed players (RN spec 2026-09-06 §2),
// twin of RemotePlayerRegistry.kt. Tokens are minted by the host;
// `PlayerHandle.id` (the wire playerId) is minted by PlayerRegistry as for
// any integration. Every method is a silent no-op for an unknown token — a
// bridge must never throw into a host.
//
// TEARDOWN FENCE (codex round-1, C5). `register()` runs OUTSIDE the lock —
// it may run `attach()`, which calls into the controller and the host — so a
// `detachAll()` on another thread (the RN module instance being torn down by
// a Metro/OTA reload) could land in the middle of a `track()` and leave the
// registration it was building in the map, alive and accumulating against a
// bundle that no longer exists. Two things fence it: a GENERATION counter
// read before `register()` and re-checked after it under the lock, and a
// terminal `closed` flag. The generation catches the in-flight registration;
// the flag makes the state final, because this registry is owned by ONE
// module instance (since C4 the iOS one is per-instance too, exactly like
// Android's) and a torn-down instance never revives.
import Foundation

public final class RemotePlayerRegistry: @unchecked Sendable {
    public static let maxTokens = 32
    private struct Entry { let handle: PlayerHandle; let integration: RemotePlayerIntegration }
    private let register: (PlayerIntegration, String?) -> PlayerHandle
    private let sessionTrack: (String, Any?) -> Void
    private let captureSourceQuery: () -> Bool
    private let lock = NSLock()
    private var live: [String: Entry] = [:]
    /// Bumped by `detachAll()`. A `track()` whose `register()` straddled a bump is refused.
    private var generation: Int64 = 0
    /// Terminal: set by `detachAll()` and never cleared. See the file header.
    private var closed = false

    public init(register: @escaping (PlayerIntegration, String?) -> PlayerHandle,
                sessionTrack: @escaping (String, Any?) -> Void,
                captureSourceQuery: @escaping () -> Bool) {
        self.register = register; self.sessionTrack = sessionTrack; self.captureSourceQuery = captureSourceQuery
    }

    @discardableResult
    public func track(token: String, library: String, name: String?, libraryVersion: String?) -> Bool {
        lock.lock()
        let refuse = closed || live[token] != nil || live.count >= Self.maxTokens
        let gen = generation
        lock.unlock()
        if refuse { return false }
        let integration = RemotePlayerIntegration(library: library, version: libraryVersion, captureSourceQuery: captureSourceQuery)
        let handle = register(integration, name)        // outside the lock: may run attach()
        lock.lock()
        // The generation check is what catches a `detachAll()` that ran DURING `register()`:
        // the map is empty again by then, so the duplicate/cap checks alone would happily
        // publish the loser and leave it live past the teardown that was meant to end it.
        let raced = closed || generation != gen || live[token] != nil || live.count >= Self.maxTokens
        if !raced { live[token] = Entry(handle: handle, integration: integration) }
        lock.unlock()
        if raced { handle.detach() }                    // outside the lock: detach() runs host code
        return !raced
    }

    @discardableResult
    public func detach(token: String) -> Bool {
        lock.lock(); let e = live.removeValue(forKey: token); lock.unlock()
        guard let e else { return false }
        e.handle.detach()
        return true
    }

    /// TERMINAL teardown: drop every registration, detaching each handle (which
    /// emits `player_detach` and, since codex round-1 C1, closes any open
    /// play/buffer span), and CLOSE the registry for good. Idempotent.
    ///
    /// Exists for the RN bridge's instance teardown: a Metro/OTA reload builds
    /// a fresh JS bundle whose token counter restarts at `rp1`, so without this
    /// the previous bundle's registrations would both keep accumulating time
    /// natively and SHADOW the re-minted tokens (`track` refuses a token that is
    /// still live). Not called by a `Everframe.shared` restart — hooks own detach
    /// in the normal lifecycle.
    ///
    /// Codex round-1, C5 — the tokens do NOT become re-trackable, and every
    /// other entry point no-ops afterwards (round-8 J1: `trackVitals` too). This registry belongs to one RN
    /// module instance; the reload that runs this teardown constructs a NEW
    /// instance with a NEW registry for the new bundle, so a revivable registry
    /// could only ever be revived by a caller from the dead bundle — an
    /// in-flight `track()` whose `register()` was still running, or a late
    /// `record` from a listener the old bundle never unsubscribed. Both are
    /// exactly what the fence exists to refuse.
    public func detachAll() {
        lock.lock()
        closed = true
        generation &+= 1
        let entries = Array(live.values); live.removeAll()
        lock.unlock()
        for e in entries { e.handle.detach() }   // outside the lock: detach() runs host code
    }

    @discardableResult
    public func record(token: String, type: String, t: Double, data: [String: Any]?) -> Bool {
        guard let at = Self.safeEpochMs(t) else { return false }
        lock.lock(); let e = closed ? nil : live[token]; lock.unlock()
        guard let e else { return false }
        e.integration.record(type, t: at, data: data)
        return true
    }

    @discardableResult
    public func updateStats(token: String, stats: [String: Any]) -> Bool {
        lock.lock(); let e = closed ? nil : live[token]; lock.unlock()
        guard let e else { return false }
        e.integration.updateStats(stats)
        return true
    }

    /// Unparseable JSON → recorded WITHOUT data, never dropped.
    ///
    /// Codex round-8, J1 — a CLOSED registry drops the line entirely, token or not. It used
    /// to fall through to `sessionTrack` (the reasoning being that a custom vitals line is
    /// session-scoped by nature, so a closed registry simply had no player to attribute it
    /// to), but `sessionTrack` is process-global: after a Metro/OTA reload the live session
    /// belongs to the NEW module instance, so a late line from the dead bundle — a listener
    /// the old bundle never unsubscribed, a queued callback — landed in a session it has
    /// nothing to do with, silently attributed to whatever the new bundle is doing. Closing
    /// is terminal for every entry point, this one included. The unknown-token fallback to
    /// `sessionTrack` stays exactly as it was while the registry is OPEN.
    public func trackVitals(name: String, dataJson: String?, token: String?) {
        lock.lock()
        let isClosed = closed
        let entry = isClosed ? nil : token.flatMap { live[$0] }
        lock.unlock()
        if isClosed { return }
        var data: Any?
        if let dataJson, let bytes = dataJson.data(using: .utf8) {
            data = (try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]))
                .map { Self.widenUnsignedOverflow($0, depth: 0) }
        }
        if let entry { entry.handle.track(name, data: data) } else { sessionTrack(name, data) }
    }

    /// Codex round-3, E3 — an unsigned JSON integer too big for an `Int64` becomes a DOUBLE,
    /// not `Int64.max`.
    ///
    /// `JSONSerialization` hands back `10000000000000000000` as an `NSNumber` whose `objCType`
    /// is `"Q"` (unsigned long long), because that is the narrowest C type that holds it.
    /// `JsonCoerce` sees the `"Q"` and CLAMPS (`Int64(clamping:)`) — deliberately, since
    /// `int64Value` on such a number wraps to a negative — so the host's `1e19` reached the wire
    /// as 9223372036854775807, a plausible-looking number that is not the one anybody wrote. On
    /// the JS side of this bridge the same literal was never an integer at all: it arrived as a
    /// `Number`, i.e. a double, and the Android twin parses it into one too. Re-boxing it as a
    /// `Double` here is what makes the three agree, and it is lossless in the only sense that
    /// applies — the value never fitted an `Int64` to begin with.
    ///
    /// Only the overflowing half of `"Q"` is touched: an unsigned number that DOES fit stays an
    /// integer, so nothing that was exact stops being exact.
    ///
    /// Bounded by the same `maxDepth` `JsonCoerce` uses. Over-depth branches are returned
    /// untouched — `JsonCoerce` replaces them with its depth marker moments later — so this walk
    /// cannot become a second unbounded recursion over host JSON.
    static func widenUnsignedOverflow(_ v: Any, depth: Int) -> Any {
        guard depth < maxJsonDepth else { return v }
        switch v {
        case let dict as [String: Any]: return dict.mapValues { widenUnsignedOverflow($0, depth: depth + 1) }
        case let arr as [Any]: return arr.map { widenUnsignedOverflow($0, depth: depth + 1) }
        case let n as NSNumber:
            guard CFGetTypeID(n) != CFBooleanGetTypeID(),
                  String(cString: n.objCType) == "Q",
                  n.uint64Value > UInt64(Int64.max) else { return v }
            return NSNumber(value: Double(n.uint64Value))
        default: return v
        }
    }
    /// Mirrors `JsonCoerce.maxDepth`; kept here because that one is private to its own walk.
    private static let maxJsonDepth = 24

    /// A finite, non-negative epoch-ms double that fits an Int64, else nil.
    public static func safeEpochMs(_ d: Double) -> Int64? {
        guard d.isFinite, d >= 0, d <= 9.0e15 else { return nil }
        return Int64(d)
    }
}
