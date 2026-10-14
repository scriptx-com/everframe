// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import UIKit
import EverframeKit

/// Only committed refs acquire ownership; neither a configure nor a delayed callback renews it.
@objc public final class RnInteractionEventRegistration: NSObject {
    private final class Request {
        let tag: NSNumber, generation: UInt64, lease: String, types: Set<String>
        let resolve: (NSNumber) -> UIView?
        weak var root: UIView?
        weak var host: UIView?
        var resolved = false
        init(_ tag: NSNumber, _ generation: UInt64, _ lease: String, _ types: Set<String>, _ resolve: @escaping (NSNumber) -> UIView?) {
            self.tag = tag; self.generation = generation; self.lease = lease; self.types = types; self.resolve = resolve
        }
    }
    private static let instancesLock = NSLock()
    private static let instances = NSHashTable<RnInteractionEventRegistration>.weakObjects()
    public override init() {
        super.init()
        Self.instancesLock.lock(); Self.instances.add(self); Self.instancesLock.unlock()
    }
    @MainActor @objc public static func invalidateView(_ view: UIView) {
        instancesLock.lock(); let owners = instances.allObjects; instancesLock.unlock()
        for owner in owners {
            owner.lock.lock(); defer { owner.lock.unlock() }
            let matches = owner.requests.filter { $0.value.root === view || (!$0.value.resolved && $0.value.tag.intValue == view.tag) }
            for (id, request) in matches {
                InteractionEvents.cancelRegistration(id: owner.key(id), generation: request.generation)
                owner.requests.removeValue(forKey: id)
            }
        }
    }
    private let lock = NSRecursiveLock()
    private let runtime = InteractionEvents.openRuntime()
    private var requests: [String: Request] = [:]
    private var closed = false
    @objc public var active: Bool { lock.lock(); defer { lock.unlock() }; return !closed && InteractionEvents.ownsRuntime(runtime) }
    @objc public func lease() -> String { active ? InteractionEvents.lease() ?? "" : "" }
    private func key(_ id: String) -> String { runtime + ":" + id }
    private func integer(_ n: Double, _ max: Double) -> Bool { n.isFinite && n >= 0 && n <= max && n.rounded() == n }
    private func validId(_ id: String) -> Bool { !id.isEmpty && id.utf16.count <= 128 && !id.unicodeScalars.contains { $0.value < 32 || $0.value == 127 } }
    @objc public func setObserver(_ tag: Double, id: String, generation: Double, lease token: String, optionsJson: String,
                                 resolve: @escaping (NSNumber) -> UIView?, host: @escaping (UIView) -> UIView?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active, validId(id), tag > 0, integer(tag, Double(Int32.max)), integer(generation, 9_007_199_254_740_990),
              !token.isEmpty, token == lease(), optionsJson.utf8.count <= 8192,
              let data = optionsJson.data(using: .utf8), let options = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = options["helperTypes"] as? [String], list.count <= 3, Set(list).isSubset(of: ["text_edit", "control_change", "scroll"]) else { return false }
        requests = requests.filter { $0.value.lease == token }
        guard requests.count < 4096 || requests[id] != nil,
              InteractionEvents.beginRegistration(id: key(id), generation: UInt64(generation), lease: token, optionsJson: optionsJson) else { return false }
        let request = Request(NSNumber(value: tag), UInt64(generation), token, Set(list), resolve)
        requests[id] = request; enqueue(id, request, host: host)
        return true
    }
    private func enqueue(_ id: String, _ request: Request, host: @escaping (UIView) -> UIView?, attempt: Int = 0) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard self.active, request.lease == self.lease(), self.requests[id] === request, !request.resolved else { return }
            guard let root = request.resolve(request.tag), root.window != nil, root.tag == request.tag.intValue else {
                if attempt < 8 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.016 * pow(2, Double(attempt))) { [weak self] in
                        self?.enqueue(id, request, host: host, attempt: attempt + 1)
                    }
                }
                return
            }
            guard let view = host(root), view === root || view.isDescendant(of: root) else { return }
            request.root = root; request.host = view; request.resolved = true
            _ = InteractionEvents.completeRegistration(view: view, id: self.key(id), generation: request.generation, lease: request.lease, types: request.types)
        }
    }
    @objc public func clearObserver(_ id: String, generation: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active, validId(id), integer(generation, 9_007_199_254_740_991),
              InteractionEvents.clearRegistration(id: key(id), generation: UInt64(generation)) else { return false }
        requests.removeValue(forKey: id); return true
    }
    @objc public func record(_ token: String, id: String, generation: Double, eventJson: String) -> Bool {
        guard active, integer(generation, 9_007_199_254_740_991), id.isEmpty || validId(id),
              let item = InteractionEvents.prepare(lease: token, id: id.isEmpty ? "" : key(id), generation: UInt64(generation), json: eventJson) else { return false }
        DispatchQueue.main.async { [weak self] in
            defer { InteractionEvents.discardPrepared(item) }
            guard let self, self.active else { return }
            if !id.isEmpty {
                self.lock.lock(); defer { self.lock.unlock() }
                guard let request = self.requests[id], request.generation == UInt64(generation),
                      let root = request.root, request.resolve(request.tag) === root, root.window != nil,
                      let host = request.host, host === root || host.isDescendant(of: root) else { return }
            }
            _ = InteractionEvents.recordPrepared(item)
        }
        return true
    }
    @objc public func close() {
        lock.lock(); defer { lock.unlock() }
        closed = true; requests.removeAll(); InteractionEvents.closeRuntime(runtime)
    }
}
