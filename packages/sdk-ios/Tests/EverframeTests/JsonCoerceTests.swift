// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class JsonCoerceTests: XCTestCase {
    func testPrimitivesMapsArraysAndVitalsJSONPassThrough() {
        XCTAssertEqual(JsonCoerce.toJSON("s"), .string("s"))
        XCTAssertEqual(JsonCoerce.toJSON(true), .bool(true))
        XCTAssertEqual(JsonCoerce.toJSON(3), .int(3))
        XCTAssertEqual(JsonCoerce.toJSON(Int64(9)), .int(9))
        XCTAssertEqual(JsonCoerce.toJSON(1.5), .double(1.5))
        XCTAssertEqual(JsonCoerce.toJSON(Float(2.5)), .double(2.5))
        XCTAssertEqual(JsonCoerce.toJSON(["a": 1, "b": ["c"]] as [String: Any]), .object(["a": .int(1), "b": .array([.string("c")])]))
        XCTAssertEqual(JsonCoerce.toJSON([1, "x"] as [Any]), .array([.int(1), .string("x")]))
        XCTAssertEqual(JsonCoerce.toJSON(VitalsJSON.null), .null)
        XCTAssertEqual(JsonCoerce.toJSON(nil), .null)
        XCTAssertEqual(JsonCoerce.toJSON(NSNull()), .null)
    }
    func testNonStringMapKeysAreStringified() {
        XCTAssertEqual(JsonCoerce.toJSON([1: "a"] as [Int: Any]), .object(["1": .string("a")]))
    }
    func testUnknownTypesBecomeAnUnserializableMarkerWithBoundedPreview() {
        struct Opaque: CustomStringConvertible { var description: String { String(repeating: "z", count: 400) } }
        guard case let .object(o) = JsonCoerce.toJSON(Opaque()) else { return XCTFail() }
        XCTAssertEqual(o["unserializable"], .bool(true))
        guard case let .string(v)? = o["value"] else { return XCTFail() }
        XCTAssertEqual(v.count, 256)
    }
    func testNaNAndInfinitiesBecomeNull() {
        XCTAssertEqual(JsonCoerce.toJSON(Double.nan), .null)
        XCTAssertEqual(JsonCoerce.toJSON(Double.infinity), .null)
        XCTAssertEqual(JsonCoerce.toJSON(-Float.infinity), .null)
    }
    func testToObjectHandlesNilAndMixedValueMaps() {
        XCTAssertNil(JsonCoerce.toObject(nil))
        XCTAssertEqual(JsonCoerce.toObject(["a": 1, "b": nil as Any?, "c": "s"] as [String: Any?]), ["a": .int(1), "b": .null, "c": .string("s")])
    }
    func testNSNumberBoolIsABoolNotAnInt() {
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: true)), .bool(true))
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: false)), .bool(false))
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: 7)), .int(7))
    }
    /// Codex round-2, #7 — the two values the suite skipped, and they are the ones that broke:
    /// `case let b as Bool` came first and an NSNumber of 0 or 1 bridges CONDITIONALLY to Bool,
    /// so `JSONSerialization`'s `{"index": 1}` shipped as `true` and an NSNumber-backed
    /// `ttffMs: 0` shipped as `false` — which the summary accumulator reads as no startup at all.
    func testNSNumberZeroAndOneStayNumbers() {
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: 0)), .int(0))
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: 1)), .int(1))
        // …including the shapes JSONSerialization actually hands back.
        let parsed = try? JSONSerialization.jsonObject(with: Data(#"{"index":1,"ttffMs":0}"#.utf8)) as? [String: Any]
        XCTAssertEqual(JsonCoerce.toObject(parsed ?? [:]), ["index": .int(1), "ttffMs": .int(0)])
    }
    /// "c" is the encoding for `signed char`, not a boolean identity — `Int8` reports it too.
    func testASignedCharNSNumberIsANumberNotABool() {
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: Int8(1))), .int(1))
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: Int8(0))), .int(0))
    }
    /// Codex round-3, Critical 1 — a container that contains ITSELF used to recurse until the
    /// stack was gone. `dispatch` catches thrown errors, not a stack-overflow crash, and the
    /// 2048-byte entry bound is applied to a value this walk never returns. Two lines of host
    /// code reach it: `trackVitals("metadata", data: dictionaryThatHoldsItself)`.
    func testASelfReferencingDictionaryBecomesACycleMarkerInsteadOfCrashing() {
        let d = NSMutableDictionary()
        d["name"] = "self"
        d["self"] = d
        guard case let .object(o) = JsonCoerce.toJSON(d) else { return XCTFail("expected an object") }
        XCTAssertEqual(o["name"], .string("self"))
        XCTAssertEqual(o["self"], .object(["unserializable": .bool(true), "value": .string("<cycle>")]))
    }
    func testASelfReferencingArrayBecomesACycleMarker() {
        let a = NSMutableArray()
        a.add(1)
        a.add(a)
        XCTAssertEqual(JsonCoerce.toJSON(a),
                       .array([.int(1), .object(["unserializable": .bool(true), "value": .string("<cycle>")])]))
    }
    /// The cycle need not be direct: two containers that hold each other are the same hazard.
    func testAMutualCycleAcrossTwoContainersIsCaught() {
        let outer = NSMutableDictionary(), inner = NSMutableArray()
        outer["inner"] = inner
        inner.add(outer)
        guard case let .object(o) = JsonCoerce.toJSON(outer), case let .array(items)? = o["inner"] else {
            return XCTFail("expected an object holding an array")
        }
        XCTAssertEqual(items, [.object(["unserializable": .bool(true), "value": .string("<cycle>")])])
    }
    /// …and the SAME container repeated in sibling positions is not a cycle: only the active
    /// recursion path is tracked, so both copies are still expanded in full.
    func testARepeatedContainerInSiblingPositionsIsStillExpanded() {
        let shared = NSMutableDictionary()
        shared["k"] = 1
        let outer = NSMutableDictionary()
        outer["a"] = shared
        outer["b"] = shared
        XCTAssertEqual(JsonCoerce.toJSON(outer), .object(["a": .object(["k": .int(1)]), "b": .object(["k": .int(1)])]))
    }
    /// A structure that is deep but finite is bounded too — the limit is what makes the walk
    /// safe for a graph with no cycle in it at all.
    func testADeepButFiniteStructureIsExpandedToTheLimitAndThenMarked() {
        func nest(_ depth: Int) -> [String: Any] {
            var v: [String: Any] = ["leaf": 1]
            for _ in 0..<depth { v = ["n": v] }
            return v
        }
        func deepest(_ j: VitalsJSON) -> VitalsJSON {
            var cur = j
            while case let .object(o) = cur, let next = o["n"] { cur = next }
            return cur
        }
        // 23 wrappers plus the leaf object sit at depths 0…23: all inside the limit.
        XCTAssertEqual(deepest(JsonCoerce.toJSON(nest(23))), .object(["leaf": .int(1)]))
        // One deeper and the tail is replaced rather than walked.
        guard case let .object(o) = deepest(JsonCoerce.toJSON(nest(24))) else { return XCTFail("expected an object") }
        XCTAssertEqual(o["unserializable"], .bool(true))
        guard case let .string(why)? = o["value"] else { return XCTFail("expected a marker") }
        XCTAssertTrue(why.hasPrefix("<max depth"), why)
    }
    /// Codex round-4, M10 — round 3 guarded `NSDictionary`/`NSArray`; a SET that holds itself
    /// fell through to `String(describing:)`, whose Objective-C `description` recurses on the
    /// cycle exactly as those two would have. Sets are walked now, so the identity guard reaches
    /// them.
    func testASelfReferencingSetBecomesACycleMarkerInsteadOfCrashing() {
        let set = NSMutableSet()
        set.add("name")
        set.add(set)
        guard case let .array(items) = JsonCoerce.toJSON(set) else { return XCTFail("expected an array") }
        XCTAssertEqual(items.count, 2)
        XCTAssertTrue(items.contains(.string("name")))
        XCTAssertTrue(items.contains(.object(["unserializable": .bool(true), "value": .string("<cycle>")])))
    }
    func testASelfReferencingOrderedSetBecomesACycleMarker() {
        let set = NSMutableOrderedSet()
        set.add(1)
        set.add(set)
        XCTAssertEqual(JsonCoerce.toJSON(set),
                       .array([.int(1), .object(["unserializable": .bool(true), "value": .string("<cycle>")])]))
    }
    func testAnOrdinarySetIsRenderedAsAnArrayRatherThanAnOpaqueMarker() {
        XCTAssertEqual(JsonCoerce.toJSON(NSOrderedSet(array: ["a", "b"])), .array([.string("a"), .string("b")]))
        guard case let .array(items) = JsonCoerce.toJSON(NSSet(array: [1, 2])) else { return XCTFail("expected an array") }
        XCTAssertEqual(items.count, 2)                                        // NSSet order is unspecified
        XCTAssertTrue(items.contains(.int(1)) && items.contains(.int(2)))
    }
    /// The other half of M10: a KEY is anything `NSCopying`, containers included. Two hazards
    /// sit on that path — Objective-C's recursive `description`, and (found while fixing it) the
    /// `[AnyHashable: Any]` bridge itself, which HASHES every key, and `NSArray`'s hash recurses
    /// through its elements. An `NSDictionary` is therefore enumerated directly and its keys are
    /// never wrapped in an `AnyHashable`.
    func testAContainerKeyIsRenderedThroughTheBoundedWalkNotItsObjCDescription() {
        let d = NSMutableDictionary()
        d.setObject("v", forKey: NSArray(array: ["a", "b"]))
        XCTAssertEqual(JsonCoerce.toJSON(d), .object([#"["a","b"]"#: .string("v")]))
    }
    func testACyclicContainerKeyTerminatesInsteadOfRecursingThroughItsDescription() {
        let cyclic = NSMutableArray()
        cyclic.add("x")
        cyclic.add(cyclic)
        let d = NSMutableDictionary()
        // NSDictionary copies its key, and that copy still holds the cyclic original.
        d.setObject("v", forKey: cyclic.copy() as! NSCopying)
        guard case let .object(o) = JsonCoerce.toJSON(d), let key = o.keys.first else {
            return XCTFail("expected a single-key object")
        }
        XCTAssertEqual(o[key], .string("v"))
        XCTAssertTrue(key.contains("<cycle>"), key)
        XCTAssertLessThanOrEqual(key.count, 256)
    }
    /// Codex round-5, Critical 1 — the third member of the unbounded-walk family. A prebuilt
    /// `VitalsJSON` was returned from `coerce` untouched, so `boundJson`'s recursive
    /// `jsonStringifyByteLength` was the first thing to walk it — before the byte budget, and
    /// with no depth limit anywhere on the path. Two lines of host code build one arbitrarily
    /// deep. Removing the `normalised` call leaves `depth(coerced) == 200` here and hands that
    /// same 200-deep value (or a 200_000-deep one) to every recursive walk downstream.
    func testAPrebuiltVitalsJSONIsBoundedByTheSameDepthLimitAsAnyOtherValue() {
        var deep = VitalsJSON.int(1)
        for _ in 0..<200 { deep = .array([deep]) }
        let coerced = JsonCoerce.toJSON(deep)
        XCTAssertEqual(Self.depth(coerced), 25, "24 array levels, then the marker object that replaced the tail")
        XCTAssertEqual(Self.deepestLeaf(coerced),
                       .object(["unserializable": .bool(true), "value": .string("<max depth 24 exceeded>")]))
        // The point of the bound: what leaves here is safe for the recursive walks downstream.
        XCTAssertLessThan(jsonStringifyByteLength(coerced), 1024)
        XCTAssertFalse(boundJson(coerced, maxBytes: VitalsLimits.maxCustomDataBytes).truncated)
    }
    /// It is bounded by the TOTAL depth, not its own: a prebuilt value reached through Foundation
    /// containers cannot buy itself a fresh 24 levels.
    func testAPrebuiltVitalsJSONNestedInsideContainersSharesTheOneDepthBudget() {
        var deep = VitalsJSON.int(1)
        for _ in 0..<30 { deep = .array([deep]) }
        var wrapped: Any = deep
        for _ in 0..<10 { wrapped = [wrapped] as [Any] }
        XCTAssertEqual(Self.depth(JsonCoerce.toJSON(wrapped)), 25)
    }
    /// The player-event door takes the same route: `emit`'s `[String: Any?]` goes through
    /// `toObject`, so a prebuilt value in a field is bounded exactly as a custom entry's is.
    func testAPrebuiltVitalsJSONInAPlayerEventFieldIsBoundedToo() {
        var deep = VitalsJSON.int(1)
        for _ in 0..<200 { deep = .array([deep]) }
        guard let out = JsonCoerce.toObject(["d": deep]), let field = out["d"] else {
            return XCTFail("expected the field to survive")
        }
        XCTAssertEqual(Self.depth(field), 25, "`toObject` starts each field at depth 0, so it gets the same budget")
        XCTAssertFalse(boundStructuredJson(out, maxBytes: VitalsLimits.maxPlayerEventDataBytes).truncated)
    }

    /// Nesting levels below `j`, counting `j` itself as 0.
    private static func depth(_ j: VitalsJSON) -> Int {
        switch j {
        case let .array(a): return 1 + (a.map(depth).max() ?? -1)
        case let .object(o): return 1 + (o.values.map(depth).max() ?? -1)
        default: return 0
        }
    }
    private static func deepestLeaf(_ j: VitalsJSON) -> VitalsJSON {
        var cur = j
        while case let .array(a) = cur, let first = a.first { cur = first }
        return cur
    }

    /// NSNumber matches before the `UInt` case now, so the clamp has to live in that branch.
    func testAnUnsignedNumberBeyondInt64StillClamps() {
        XCTAssertEqual(JsonCoerce.toJSON(UInt.max), .int(Int64.max))
        XCTAssertEqual(JsonCoerce.toJSON(NSNumber(value: UInt64.max)), .int(Int64.max))
    }
}
