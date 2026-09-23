// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Host `Any?` → VitalsJSON. Never throws; anything it cannot represent
/// becomes a marker object.
///
/// Codex round-2, #7 — `NSNumber` is matched BEFORE `Bool`, and a real boolean is identified by
/// `CFBooleanGetTypeID()`. Two things were wrong the other way round. `case let b as Bool` came
/// first, and an `NSNumber` whose value is 0 or 1 bridges CONDITIONALLY to `Bool`, so a
/// `JSONSerialization`-derived `{"index": 1}` became `{"index": true}` and an NSNumber-backed
/// `ttffMs: 0` became `false` — which `numberValue` then reads as nothing, so the accumulator
/// dropped the startup entirely. And `objCType == "c"` is the encoding for `signed char`, which
/// `NSNumber(value: Int8(1))` also reports: a real `CFBoolean` is the only reliable signal, and
/// a signed char stays a number. Swift's own `Bool` still bridges to a `CFBoolean`-backed
/// `NSNumber`, so it is answered correctly by the first branch.
enum JsonCoerce {
    private static let maxPreviewChars = 256
    /// How deep a customer structure may nest before the rest of that branch is replaced by a
    /// marker (codex round-3, Critical 1). Far below the stack this recursion can actually use,
    /// and far above anything the 2048-byte entry bound could carry: the whole point is that the
    /// bound is applied to an ALREADY-BUILT value, so it cannot protect the walk that builds it.
    private static let maxDepth = 24

    private static func marker(_ why: String) -> VitalsJSON {
        .object(["unserializable": .bool(true), "value": .string(why)])
    }

    /// Codex round-3, Critical 1 — a customer container that (directly or through another
    /// container) CONTAINS ITSELF used to recurse until the stack was exhausted. An
    /// `NSMutableDictionary` that stores itself under a key is two lines of host code, and
    /// `trackVitals` passes whatever it is given straight in here. That is not a throw `dispatch`
    /// can catch: it is a stack-overflow crash of the host app, and the 2048-byte bound runs long
    /// afterwards, on a value this walk never returns.
    ///
    /// Two guards, both on the ACTIVE RECURSION PATH rather than on the whole graph, so a value
    /// legitimately repeated in sibling positions (the same dictionary under two keys, say) is
    /// still expanded in full:
    ///  - container IDENTITY, checked before the container is bridged and traversed. Only
    ///    Foundation's reference containers can cycle at all — a Swift `Dictionary`/`Array` is a
    ///    value and cannot contain itself — and the check has to happen BEFORE the `as?` bridge,
    ///    which loses the object identity.
    ///  - a DEPTH limit, which also catches a structure that is deep but finite.
    ///
    /// Codex round-4, M10 — SET-LIKE containers and dictionary KEYS reach the same hazard.
    /// Round 3 covered `NSDictionary`/`NSArray`; an `NSMutableSet`/`NSMutableOrderedSet` that
    /// holds itself fell through to `String(describing:)`, whose Objective-C `description`
    /// recurses on the cycle just as the other two would have, and so did a cyclic container used
    /// as a KEY. Both now go through this same walk.
    ///
    /// Codex round-5, M10 — one consequence of enumerating `NSDictionary` directly: a BOOLEAN
    /// key renders as `"1"`/`"0"` rather than `"true"`/`"false"`, because the key arrives as a
    /// `__NSCFBoolean` and `String(describing:)` prints its numeric value. Diagnostic data only,
    /// and the alternative — the `[AnyHashable: Any]` bridge — is the crash this branch exists
    /// to avoid, so the rendering stays as it is.
    static func toJSON(_ v: Any?) -> VitalsJSON {
        var path: [ObjectIdentifier] = []
        return coerce(v, depth: 0, path: &path)
    }

    private static func coerce(_ v: Any?, depth: Int, path: inout [ObjectIdentifier]) -> VitalsJSON {
        guard let v else { return .null }
        switch v {
        case let j as VitalsJSON: return normalised(j, depth: depth)
        case is NSNull: return .null
        case let s as String: return .string(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            if n.doubleValue.isNaN || n.doubleValue.isInfinite { return .null }
            let encoding = String(cString: n.objCType)
            if encoding == "d" || encoding == "f" { return .double(n.doubleValue) }
            // "Q" is unsigned long long: `int64Value` wraps UInt.max to -1, and the `UInt` case
            // below is unreachable now that NSNumber matches first, so clamp here instead.
            if encoding == "Q" { return .int(Int64(clamping: n.uint64Value)) }
            return .int(n.int64Value)
        case let b as Bool: return .bool(b)
        case let i as Int: return .int(Int64(i))
        case let i as Int64: return .int(i)
        case let i as Int32: return .int(Int64(i))
        case let u as UInt: return .int(Int64(clamping: u))
        case let d as Double: return d.isNaN || d.isInfinite ? .null : .double(d)
        case let f as Float: return f.isNaN || f.isInfinite ? .null : .double(Double(f))
        default: return container(v, depth: depth, path: &path)
        }
    }

    /// Codex round-5, Critical 1 — an ALREADY-BUILT `VitalsJSON` is bounded here too.
    ///
    /// A prebuilt value used to be returned untouched, which made it the one way into the vitals
    /// pipeline that skipped the depth limit entirely. Two lines of host code build one to any
    /// depth — `for _ in 0..<200_000 { v = .array([v]) }` — and `trackVitals` hands it straight
    /// to `boundJson`, whose `jsonStringifyByteLength` then walks the whole value RECURSIVELY
    /// before any byte budget can apply. That is a stack overflow of the host app, not a thrown
    /// error `dispatch` can catch, and it is the same family as round-3's Critical 1 (Foundation
    /// containers) and round-4's M10 (sets and dictionary keys): a customer-supplied shape
    /// reaching a recursive walk before anything bounds it.
    ///
    /// The branch is entered with the depth already reached, so a prebuilt value nested inside
    /// Foundation containers is bounded by the TOTAL depth, not by its own. Over-depth branches
    /// become the same marker every other over-depth branch does. No cycle guard is needed or
    /// possible: `VitalsJSON` is an enum of value types, so it cannot contain itself — the depth
    /// limit is the whole guard.
    ///
    /// With this closed, every customer value reaches the pipeline through exactly one of
    /// `trackVitals(_:data:player:)` or `PlayerIntegrationContext.emit(_:data:t:)`, and both go
    /// through `toJSON`/`toObject` — so there is no fourth entry point left for this family.
    private static func normalised(_ j: VitalsJSON, depth: Int) -> VitalsJSON {
        switch j {
        case .null, .bool, .int, .double, .string: return j
        case let .array(a):
            guard depth < maxDepth else { return marker("<max depth \(maxDepth) exceeded>") }
            return .array(a.map { normalised($0, depth: depth + 1) })
        case let .object(o):
            guard depth < maxDepth else { return marker("<max depth \(maxDepth) exceeded>") }
            return .object(o.mapValues { normalised($0, depth: depth + 1) })
        }
    }

    /// Everything that is not a scalar. `v` is non-nil.
    private static func container(_ v: Any, depth: Int, path: inout [ObjectIdentifier]) -> VitalsJSON {
        // The identity of a Foundation container, taken BEFORE the bridge below throws it away.
        // `type(of:) is AnyClass` first, so a Swift `Dictionary`/`Array` — a VALUE, which cannot
        // contain itself — is never bridged to an object just to be given an identity it does not
        // need. `NSDictionary`/`NSArray` cover their mutable subclasses.
        var identity: ObjectIdentifier?
        if type(of: v) is AnyClass, v is NSDictionary || v is NSArray || v is NSSet || v is NSOrderedSet {
            let id = ObjectIdentifier(v as AnyObject)
            if path.contains(id) { return marker("<cycle>") }
            identity = id
        }
        guard depth < maxDepth else { return marker("<max depth \(maxDepth) exceeded>") }
        if let identity { path.append(identity) }
        defer { if identity != nil { path.removeLast() } }
        let next = depth + 1
        switch v {
        case let dict as [String: Any?]: return .object(dict.mapValues { coerce($0, depth: next, path: &path) })
        case let dict as [String: Any]: return .object(dict.mapValues { coerce($0, depth: next, path: &path) })
        // An `NSDictionary` whose keys are not all strings is enumerated DIRECTLY, ahead of the
        // `[AnyHashable: Any]` bridge below (codex round-4, M10). The bridge builds an
        // `AnyHashable` per key, which HASHES it — and `NSArray`'s hash recurses through its
        // elements, so a cyclic container used as a key crashed the host app inside the bridge,
        // upstream of anything this file could guard. Enumerating hashes nothing, and the keys
        // arrive with their class identity intact, so `keyString` can bound them the same way the
        // value path bounds a value.
        case let ns as NSDictionary:
            var out: [String: VitalsJSON] = [:]
            var walked = path
            ns.enumerateKeysAndObjects { k, value, _ in
                out[Self.keyString(k, depth: next, path: &walked)] = Self.coerce(value, depth: next, path: &walked)
            }
            path = walked                     // balanced by construction; restored for the caller
            return .object(out)
        case let dict as [AnyHashable: Any]:
            var out: [String: VitalsJSON] = [:]
            for (k, value) in dict { out[keyString(k.base, depth: next, path: &path)] = coerce(value, depth: next, path: &path) }
            return .object(out)
        case let arr as [Any?]: return .array(arr.map { coerce($0, depth: next, path: &path) })
        case let arr as [Any]: return .array(arr.map { coerce($0, depth: next, path: &path) })
        // Round-4, M10 — JSON has no set, so a set is rendered as an array (its order is
        // whatever the container reports, which for `NSSet` is unspecified — this is diagnostic
        // data, not a key). Walking it is what makes the identity guard above reach it at all:
        // left in `default`, a self-referencing set went straight to the recursive `description`
        // the guard exists to keep it away from.
        case let set as NSOrderedSet: return .array(set.array.map { coerce($0, depth: next, path: &path) })
        case let set as NSSet: return .array(set.allObjects.map { coerce($0, depth: next, path: &path) })
        default:
            // `String(describing:)` on an arbitrary object runs the host's own `description`,
            // which is its problem and not something a coercion can bound; every Foundation
            // container whose description WOULD recurse on a cycle is answered above.
            return .object(["unserializable": .bool(true), "value": .string(String(String(describing: v).prefix(maxPreviewChars)))])
        }
    }

    /// A dictionary KEY, stringified (codex round-4, M10). A key is not always a string: it is
    /// anything `NSCopying`, containers included, and `String(describing:)` on a cyclic one
    /// recurses in Objective-C exactly as a value would. A reference container is therefore
    /// rendered through the same bounded, cycle-guarded walk and then flattened to its JSON text;
    /// everything else keeps the plain description it always had (a Swift `Dictionary`/`Array`
    /// key is a value and cannot cycle).
    /// `base` is the RAW key — never an `AnyHashable` wrapper. Constructing one hashes the key,
    /// and that is the crash this whole branch exists to avoid.
    private static func keyString(_ base: Any, depth: Int, path: inout [ObjectIdentifier]) -> String {
        if let s = base as? String { return s }
        // Anything the walk recognises as a CONTAINER goes through it, so Objective-C's recursive
        // `description` is never what walks a key. Reached from the `NSDictionary` branch the key
        // still has its class identity, so the cycle guard applies; reached from the
        // `[AnyHashable: Any]` branch (a Swift dictionary, whose keys are VALUES and cannot
        // cycle) the depth limit is enough on its own.
        if base is [Any] || base is [AnyHashable: Any] || base is NSSet || base is NSOrderedSet {
            return String(encodedJSONText(coerce(base, depth: depth, path: &path)).prefix(maxPreviewChars))
        }
        return String(String(describing: base).prefix(maxPreviewChars))
    }

    static func toObject(_ m: [String: Any?]?) -> [String: VitalsJSON]? {
        guard let m else { return nil }
        var path: [ObjectIdentifier] = []
        return m.mapValues { coerce($0, depth: 0, path: &path) }
    }
}
