// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import UIKit
import EverframeKit

/// Ref cleanup cancels ownership immediately; UIKit work is always queued on main.
@objc public final class RnInteractionTargetRegistration: NSObject {
    private final class Request {
        let tag: NSNumber, generation: UInt64, annotation: [String: Any]
        let resolve: (NSNumber) -> UIView?
        weak var view: UIView?
        var resolved = false
        init(_ tag: NSNumber, _ generation: UInt64, _ annotation: [String: Any], _ resolve: @escaping (NSNumber) -> UIView?) {
            self.tag=tag; self.generation=generation; self.annotation=annotation; self.resolve=resolve
        }
    }
    private let lock=NSRecursiveLock()
    private let namespace=UUID().uuidString + ":"
    private var requests: [String: Request]=[:]
    private var destroyed=false
    private var removeAdapter: (() -> Void)?
    private var removeOriginAdapter: (() -> Void)?

    @objc public func installOriginAdapter(_ read: @escaping (UIView) -> Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.destroyed else { return }
            self.removeOriginAdapter = InteractionOriginViewAdapters.register(read)
        }
    }

    @objc public func installAdapter(_ read: @escaping (UIView) -> NSDictionary?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.destroyed else { return }
            self.removeAdapter=InteractionTargetViewAdapters.register { view in
                guard let fields=read(view) else { return nil }
                let raw=fields["role"] as? String
                let role: String?
                switch raw {
                case "imagebutton": role="button"
                case "adjustable": role="slider"
                case "search", "searchbox", "textbox": role="textfield"
                case "heading": role="header"
                case "img": role="image"
                case "none", "": role=nil
                default: role=raw
                }
                return InteractionTargetViewHints(testId: fields["testId"] as? String, role:role, name:fields["name"] as? String ?? "",
                    actionable: (fields["actionable"] as? Bool ?? false) || (role.map { ["button","tab","link","switch","checkbox","radio","slider","menuitem","textfield"].contains($0) } ?? false))
            }
        }
    }
    private func integer(_ n: Double, _ maximum: Double) -> Bool { n.isFinite && n >= 0 && n <= maximum && n.rounded() == n }
    @objc public func setTarget(_ tag: Double, registrationId id: String, generation: Double, annotation: [String: Any], resolve: @escaping (NSNumber) -> UIView?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !destroyed, tag > 0, integer(tag,Double(Int32.max)), integer(generation,9_007_199_254_740_990),
              InteractionTargetRegistry.beginSet(registrationId:namespace+id,generation:UInt64(generation)) else { return false }
        let request=Request(NSNumber(value:tag),UInt64(generation),annotation,resolve)
        requests[id]=request; enqueue(id,request)
        return true
    }
    private func enqueue(_ id: String, _ request: Request, attempt: Int = 0) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.destroyed, self.requests[id] === request else { return }
            guard let view=request.resolve(request.tag), view.window != nil else {
                // Fabric refs precede mounting. Bound retries, and re-check ownership
                // before every lookup so cleanup cannot register a recycled host.
                if !request.resolved, attempt < 8 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.016 * pow(2, Double(attempt))) { [weak self] in
                        self?.enqueue(id, request, attempt: attempt + 1)
                    }
                }
                return
            }
            guard !request.resolved || request.view === view else { return }
            request.view=view; request.resolved=true
            InteractionTargetRegistry.completeSet(view:view,registrationId:self.namespace+id,generation:request.generation,annotation:request.annotation)
        }
    }
    @objc public func clearTarget(_ id: String, generation: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !destroyed, integer(generation,9_007_199_254_740_991) else { return false }
        if requests[id].map({ UInt64(generation) > $0.generation }) ?? true { requests.removeValue(forKey:id) }
        InteractionTargetRegistry.clear(registrationId:namespace+id,generation:UInt64(generation))
        return true
    }
    @objc public func onStarted() {
        lock.lock(); defer { lock.unlock() }
        guard !destroyed else { return }
        for (id, request) in requests {
            if InteractionTargetRegistry.beginSet(registrationId:namespace+id,generation:request.generation) { enqueue(id,request) }
        }
    }
    @objc public func close() {
        lock.lock(); defer { lock.unlock() }
        destroyed=true
        for (id, request) in requests { InteractionTargetRegistry.clear(registrationId:namespace+id,generation:request.generation+1) }
        requests.removeAll()
        DispatchQueue.main.async { [self] in removeAdapter?(); removeAdapter=nil; removeOriginAdapter?(); removeOriginAdapter=nil }
    }
    @MainActor @objc public static func invalidateView(_ view: UIView) { InteractionTargetRegistry.invalidate(view:view) }
}
