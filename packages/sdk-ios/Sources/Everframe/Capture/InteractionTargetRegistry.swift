// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import CoreFoundation

/// SDK-support API. Only ownership operations are thread-safe; view operations run on main.
public enum InteractionTargetRegistry {
    private final class Entry {
        weak var view: UIView?
        let annotation: [String: Any]
        let identity: [AnyHashable]
        @MainActor init(_ view: UIView, _ annotation: [String: Any]) {
            self.view=view; self.annotation=annotation; self.identity=InteractionTargetRegistry.identity(view)
        }
    }
    private static let lock = NSRecursiveLock()
    private static var entries: [String: Entry] = [:]
    private static var generations: [String: UInt64] = [:]
    private static var pending: [String: UInt64] = [:]
    private static var overflowed = false

    @MainActor public static func set(view: UIView, registrationId: String, generation: UInt64, annotation: [String: Any]) {
        if beginSet(registrationId: registrationId, generation: generation) {
            completeSet(view: view, registrationId: registrationId, generation: generation, annotation: annotation)
        }
    }
    public static func beginSet(registrationId: String, generation: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard advance(registrationId, generation) else { return false }
        entries.removeValue(forKey: registrationId); pending[registrationId]=generation
        return true
    }
    @MainActor public static func completeSet(view: UIView, registrationId: String, generation: UInt64, annotation: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard pending[registrationId] == generation else { return }
        pending.removeValue(forKey: registrationId)
        entries.removeValue(forKey: registrationId)
        let value=normalize(annotation)
        guard !value.isEmpty else { return }
        entries=entries.filter { $0.value.view != nil && $0.value.view !== view }
        entries[registrationId]=Entry(view,value)
    }
    public static func clear(registrationId: String, generation: UInt64) {
        lock.lock(); defer { lock.unlock() }
        if advance(registrationId,generation) { entries.removeValue(forKey: registrationId); pending.removeValue(forKey: registrationId) }
    }
    public static func reset() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll(); generations.removeAll(); pending.removeAll(); overflowed=false
    }
    @MainActor public static func invalidate(view: UIView) {
        lock.lock(); defer { lock.unlock() }
        entries=entries.filter { $0.value.view != nil && $0.value.view !== view }
    }
    @MainActor static func lookup(_ view: UIView) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let (key,entry)=entries.first(where: { $0.value.view === view }) else { return nil }
        guard entry.identity == identity(view) else { entries.removeValue(forKey:key); return nil }
        return entry.annotation
    }
    private static func advance(_ id: String, _ generation: UInt64) -> Bool {
        guard !overflowed, !id.isEmpty, id.utf16.count <= 256, generation <= 9_007_199_254_740_991,
              generations[id].map({ generation > $0 }) ?? true else { return false }
        if generations[id] == nil && generations.count >= 4096 {
            overflowed=true; entries.removeAll(); generations.removeAll(); pending.removeAll(); return false
        }
        generations[id]=generation; return true
    }
    @MainActor private static func identity(_ view: UIView) -> [AnyHashable] {
        let hints=InteractionTargetViewAdapters.describe(view)
        // Ref ownership and explicit recycle invalidation survive native clipping.
        // Sibling positions/counts are layout, not the identity of this host.
        return [view.tag,hints?.testId ?? "",hints?.role ?? "",view.accessibilityIdentifier ?? "",hints?.name ?? view.accessibilityLabel ?? ""]
    }
    private static func normalize(_ input: [String: Any]) -> [String: Any] {
        func fields(_ map: [String: Any]) -> [String: Any] {
            var result: [String: Any]=[:]
            for key in ["name","testId","role"] {
                if let value=interactionTargetText(map[key] as? String,max:key == "role" ? 64 : 256) { result[key]=value }
            }
            return result
        }
        func position(_ value: Any?) -> Double? {
            guard let number=value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            let n=number.doubleValue
            return n.isFinite && n >= 0 && n <= 9_007_199_254_740_991 && n.rounded() == n ? n : nil
        }
        var result=fields(input)
        if let container=input["container"] as? [String: Any] {
            var nested=fields(container)
            let index=position(container["index"]), count=position(container["count"])
            if index == nil || count == nil || index! < count! {
                if let index { nested["index"]=index }; if let count { nested["count"]=count }
            }
            if !nested.isEmpty { result["container"]=nested }
        }
        return result
    }
}
#endif
