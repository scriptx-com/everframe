// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Importance-weighted breadcrumb trim (spec §4). Pure + platform-agnostic:
// mirrors packages/sdk-core/src/breadcrumbs/trim.ts EXACTLY — same constants,
// same eviction order, same cost model — locked by the shared parity fixture
// packages/protocol/__tests__/fixtures/breadcrumb-trim.v1.json.
//
// COST MODEL (deterministic + mirrorable; NOT JSONEncoder, whose key
// ordering is platform-dependent): all lengths are UTF-16 code units
// (JS .length == Swift utf16.count == Kotlin String.length).
//   cost(crumb)   = entryOverhead + message.utf16.count + dataCost(data)
//   dataCost      : string → utf16 count · number|bool → 8 · null → 4
//                   array  → 2 + Σ(item + 2) · object → 2 + Σ(key.utf16Count + value + 2)
//                   absent data → 0
//
// INPUT INVARIANT (relied on for determinism): no two crumbs share the same
// (t, seq) pair. Swift's `sort` is not stable, so ties broken only by the
// (t, seq) comparator would be nondeterministic if the invariant were
// violated. EverframeBreadcrumb identity (mustKeep/kept tracking) is therefore done
// by array INDEX into the sorted `entries` array, not by value/reference
// identity as the TS `Set<EverframeBreadcrumb>` does — index identity is equivalent
// here because entries is a fixed array for the duration of the algorithm.
import Foundation
import EverframeProtocol

public enum BreadcrumbTrim {
    /// Total serialized-cost budget for the shipped chain (spec §4, default 16 KB).
    public static let byteBudget = 16384
    /// Per-entry console message cap: first cap/2 + last cap/2 around a splice marker.
    public static let consoleEntryCap = 1024
    /// Fixed per-entry cost covering the t/seq/kind/level envelope of a crumb.
    public static let entryOverhead = 64
    /// Hard entry ceiling for trimmed output: 128 (protocol payload.breadcrumbs
    /// maxItems) minus 7 (worst case one trim marker per kind).
    public static let maxTrimmedEntries = 121
    /// Error crumbs' data.stackDigest is capped to its first N newline-separated lines.
    public static let stackDigestMaxLines = 10

    // Set<String> (not Set<EverframeBreadcrumbKind>) sidesteps a Sendable/concurrency-
    // safety warning on a static Set of a non-Sendable generated enum; rawValue
    // comparison is equivalent since EverframeBreadcrumbKind's raw values are unique.
    private static let structuralKinds: Set<String> = [
        EverframeBreadcrumbKind.navigation.rawValue, EverframeBreadcrumbKind.tap.rawValue,
        EverframeBreadcrumbKind.lifecycle.rawValue, EverframeBreadcrumbKind.error.rawValue,
        EverframeBreadcrumbKind.custom.rawValue,
    ]

    /// Structural kinds are cheap and always-keep-first; console/network are trimmable.
    static func isStructural(_ kind: EverframeBreadcrumbKind) -> Bool {
        structuralKinds.contains(kind.rawValue)
    }

    /// A synthetic per-kind trim marker ("+N <kind> hidden")? Spec §1 discriminator.
    public static func isTrimMarker(_ crumb: EverframeBreadcrumb) -> Bool {
        guard let value = crumb.data?["droppedCount"]?.value else { return false }
        // EverframeJSONAny.decode(...) only ever produces Int64 or Double for a JSON
        // number (never plain Swift Int) — mirrors JS's `typeof x === 'number'`.
        return (value is Int64) || (value is Double)
    }

    /**
     * Importance-weighted trim (spec §4):
     *   1. per-entry truncation (console middle-splice; error stackDigest line cap),
     *   2. must-keep = the newest entry of every kind present,
     *   3. while over budget evict the oldest BULKY (console/network) crumb,
     *      then — only when no bulky remain — the oldest structural,
     *   4. after byte eviction, if more than maxTrimmedEntries entries remain,
     *      keep evicting in the SAME order (oldest bulky first, then oldest
     *      structural, skipping must-keep) until maxTrimmedEntries remain,
     *   5. one count marker per kind that lost entries, stamped with the newest
     *      dropped entry's (t, seq) so it sorts just before the kept window.
     * Markers are bounded (≤ one per kind) and excluded from the budget.
     */
    public static func trim(
        _ crumbs: [EverframeBreadcrumb],
        byteBudget: Int = byteBudget,
        consoleEntryCap: Int = consoleEntryCap
    ) -> [EverframeBreadcrumb] {
        if crumbs.isEmpty { return [] }

        // 1. Per-entry truncation, then defensive (t, seq) sort for determinism.
        let entries = crumbs
            .map { truncate($0, consoleCap: consoleEntryCap) }
            .sorted(by: tSeqLess)

        // 2. Must-keep: the newest entry of every kind present.
        var mustKeepIndices = Set<Int>()
        var seenKinds = Set<EverframeBreadcrumbKind>()
        for i in stride(from: entries.count - 1, through: 0, by: -1) {
            let kind = entries[i].kind
            if !seenKinds.contains(kind) {
                seenKinds.insert(kind)
                mustKeepIndices.insert(i)
            }
        }

        // 3. Evict until under budget: oldest bulky first, structural last resort.
        //    `entries` is oldest→newest, so each filter pass is already in
        //    eviction order.
        var keptIndices = Set<Int>(entries.indices)
        var total = entries.reduce(0) { $0 + crumbCost($1) }
        let evictionOrder: [Int] =
            entries.indices.filter { !isStructural(entries[$0].kind) }
            + entries.indices.filter { isStructural(entries[$0].kind) }

        for victim in evictionOrder {
            if total <= byteBudget { break }
            if mustKeepIndices.contains(victim) { continue }
            keptIndices.remove(victim)
            total -= crumbCost(entries[victim])
        }

        // 3b. Count enforcement: walk the SAME eviction order; must-keep is at
        //     most 7 entries (one per kind), so the target is always reachable.
        for victim in evictionOrder {
            if keptIndices.count <= maxTrimmedEntries { break }
            if mustKeepIndices.contains(victim) { continue }
            keptIndices.remove(victim)
        }

        // 4. One count marker per kind that lost entries.
        var droppedByKind: [EverframeBreadcrumbKind: [Int]] = [:]
        for i in entries.indices where !keptIndices.contains(i) {
            droppedByKind[entries[i].kind, default: []].append(i)
        }
        var markers: [EverframeBreadcrumb] = []
        for (kind, droppedIndices) in droppedByKind {
            let newestDropped = entries[droppedIndices[droppedIndices.count - 1]]
            markers.append(
                EverframeBreadcrumb(
                    data: droppedCountData(droppedIndices.count),
                    kind: kind,
                    level: .info,
                    message: "+\(droppedIndices.count) \(kind.rawValue) hidden",
                    seq: newestDropped.seq,
                    t: newestDropped.t,
                    truncated: nil
                )
            )
        }

        let kept = entries.indices.filter { keptIndices.contains($0) }.map { entries[$0] }
        return (kept + markers).sorted(by: tSeqLess)
    }

    // MARK: - (t, seq) ordering

    private static func tSeqLess(_ a: EverframeBreadcrumb, _ b: EverframeBreadcrumb) -> Bool {
        if a.t != b.t { return a.t < b.t }
        return a.seq < b.seq
    }

    // MARK: - Step 1: per-entry truncation

    private static func truncate(_ c: EverframeBreadcrumb, consoleCap: Int) -> EverframeBreadcrumb {
        if c.kind == .console {
            let r = truncateMiddle(c.message, cap: consoleCap)
            guard r.truncated else { return c }
            return EverframeBreadcrumb(
                data: c.data, kind: c.kind, level: c.level, message: r.message,
                seq: c.seq, t: c.t, truncated: true
            )
        }
        if c.kind == .error,
            let stackDigest = c.data?["stackDigest"]?.value as? String
        {
            let lines = stackDigest.components(separatedBy: "\n")
            if lines.count > stackDigestMaxLines {
                var newData = c.data ?? [:]
                newData["stackDigest"] = jsonAny(lines.prefix(stackDigestMaxLines).joined(separator: "\n"))
                return EverframeBreadcrumb(
                    data: newData, kind: c.kind, level: c.level, message: c.message,
                    seq: c.seq, t: c.t, truncated: true
                )
            }
        }
        return c
    }

    /// Head+tail middle-splice: over-cap messages keep the first and last cap/2
    /// UTF-16 units around a `…[+N chars]…` marker (spec §4.2).
    ///
    /// SURROGATE EDGE (documented platform divergence — spec 2026-07-08 ruling):
    /// when the UTF-16 cut lands inside a surrogate pair, JS .slice() and Kotlin
    /// substring keep the lone surrogate; Swift's String(decoding:as:UTF16.self)
    /// substitutes U+FFFD (Swift String cannot hold a lone surrogate). Accepted:
    /// each Everframe SDK trims only its own crumbs, so the divergence cannot surface in a
    /// shipped report — it exists only under a shared-oracle comparison. Pinned
    /// by the characterization tests beside each mirror.
    static func truncateMiddle(_ message: String, cap: Int) -> (message: String, truncated: Bool) {
        let units = Array(message.utf16)
        guard units.count > cap else { return (message, false) }
        let half = cap / 2
        let dropped = units.count - half * 2
        let head = String(decoding: units[..<half], as: UTF16.self)
        let tail = String(decoding: units[(units.count - half)...], as: UTF16.self)
        return ("\(head)…[+\(dropped) chars]…\(tail)", true)
    }

    // MARK: - Cost model

    static func crumbCost(_ crumb: EverframeBreadcrumb) -> Int {
        entryOverhead + crumb.message.utf16.count + dataCost(crumb.data)
    }

    private static func dataCost(_ data: [String: EverframeJSONAny]?) -> Int {
        guard let data = data else { return 0 }
        var sum = 2
        for (k, v) in data {
            sum += k.utf16.count + valueCost(v.value) + 2
        }
        return sum
    }

    private static func valueCost(_ value: Any) -> Int {
        if let v = value as? String { return v.utf16.count }
        if value is Bool { return 8 }
        if value is Int64 { return 8 }
        if value is Double { return 8 }
        if value is EverframeJSONNull { return 4 }
        if let arr = value as? [Any] {
            var sum = 2
            for item in arr { sum += valueCost(item) + 2 }
            return sum
        }
        if let dict = value as? [String: Any] {
            var sum = 2
            for (k, v) in dict { sum += k.utf16.count + valueCost(v) + 2 }
            return sum
        }
        return 4
    }

    // MARK: - EverframeJSONAny construction
    //
    // EverframeJSONAny (Generated.swift) exposes no public initializer besides
    // `init(from decoder:)`, so the only way to mint one from a plain Swift
    // value (from within a different module) is a JSON round-trip: encode the
    // value, then decode it back through EverframeJSONAny's own Decodable conformance.
    // Neither encoder/decoder needs any special date strategy here — the only
    // values ever passed through are String and Int.

    private static func jsonAny<T: Encodable>(_ value: T) -> EverframeJSONAny? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(EverframeJSONAny.self, from: data)
    }

    private static func droppedCountData(_ n: Int) -> [String: EverframeJSONAny] {
        let json = "{\"droppedCount\":\(n)}"
        let data = json.data(using: .utf8)!
        return (try? JSONDecoder().decode([String: EverframeJSONAny].self, from: data)) ?? [:]
    }
}
