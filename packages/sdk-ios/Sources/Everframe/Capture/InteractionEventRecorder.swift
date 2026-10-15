// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import EverframeProtocol

final class InteractionOwner {
    let lease: String
    let revision: UInt64
    weak var host: UIView?
    let hasHost: Bool
    let target: [String: Any]?
    let liveTestId: String?
    let hostTag: Int?
    let registrationId: String?
    let generation: UInt64?
    init(lease: String, revision: UInt64, host: UIView?, target: [String: Any]?, liveTestId: String?, hostTag: Int?, registrationId: String? = nil, generation: UInt64? = nil) {
        self.lease = lease; self.revision = revision; self.host = host; self.hasHost = host != nil
        self.target = target; self.liveTestId = liveTestId; self.hostTag = hostTag; self.registrationId = registrationId; self.generation = generation
    }
}
struct InteractionObservation {
    let owner: InteractionOwner
    let event: [String: Any]
    var phase: String = "change"
    var composing: Bool = false
    var deferLaunch: Bool = false
    // Set only by the native user-edit adapter, never by helper JSON.
    var nativeTextEdit: Bool = false
}

/// All mutable state uses the ring's non-recursive lock. Methods suffixed Locked never acquire it.
final class InteractionEventRecorder: @unchecked Sendable {
    static let shared = InteractionEventRecorder(buffer: .shared)
    private final class Pending {
        let owner: InteractionOwner, event: [String: Any], deadline: Double, composing: Bool
        let nativeTextEdit: Bool
        var dormant = false
        init(_ owner: InteractionOwner, _ event: [String: Any], _ deadline: Double, _ composing: Bool, nativeTextEdit: Bool = false) {
            self.owner = owner; self.event = event; self.deadline = deadline; self.composing = composing
            self.nativeTextEdit = nativeTextEdit
        }
    }
    private struct Registration { let owner: InteractionOwner, types: Set<String>, annotation: [String: Any]? }
    private struct HostTime { weak var view: UIView?; let time: Double }
    private let buffer: BreadcrumbRingBuffer
    private let clock: () -> Double
    private let schedule: (Double, @escaping () -> Void) -> Void
    private var token = UUID().uuidString
    private var runtime: String?
    private var prepared: [PreparedInteraction] = []
    func openRuntime() -> String { buffer.withInteractionLock { eraseLocked(); let id = UUID().uuidString; runtime = id; return id } }
    func ownsRuntime(_ id: String) -> Bool { buffer.withInteractionLock { runtime == id } }
    func closeRuntime(_ id: String) { buffer.withInteractionLock { if runtime == id { eraseLocked(); runtime = nil } } }
    func prepare(lease: String, id: String, generation: UInt64, json: String) -> PreparedInteraction? {
        guard json.utf8.count <= 8192, let data = json.data(using: .utf8),
              let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let type = input["type"] as? String else { return nil }
        let sourceScreen = InteractionTargetScreenState.current()
        // UI inspection stays outside the buffer lock; values never wait in a queue for privacy proof.
        let candidate = buffer.withInteractionLock { registrations[id]?.owner }
        let capturedHostSafe: Bool? = Thread.isMainThread ? MainActor.assumeIsolated {
            candidate.map { live($0) }
        } : nil
        // Text metadata requires privacy proof at capture time, including length.
        // Admission after an off-main observation cannot establish its earlier safety.
        guard type != "text_edit" || capturedHostSafe == true else { return nil }
        let privacyVerified = capturedHostSafe == true && MainActor.assumeIsolated {
            candidate.map { !nativeComposing($0) } ?? false
        }
        return buffer.withInteractionLock {
            guard enabledLocked(), lease == token else { return nil }
            if type == "launch_context" {
                guard id.isEmpty, generation == 0, prepared.count < 64,
                      let previous = pending.first(where: { $0.event["type"] as? String == "launch" && currentLocked($0.owner) && $0.deadline > clock() }),
                      let index = pending.firstIndex(where: { $0 === previous }) else { return nil }
                var fields = previous.event
                if let trigger = input["trigger"] { fields["trigger"] = trigger }
                if let arguments = input["arguments"] { fields["arguments"] = arguments }
                guard let event = InteractionEventSanitizer.sanitize(fields, policy: policy) else { return nil }
                pending[index] = Pending(previous.owner, event, previous.deadline, false)
                let item = PreparedInteraction(.init(owner: previous.owner, event: event, phase: "context"))
                prepared.append(item); return item
            }
            var owner: InteractionOwner
            if id.isEmpty, generation == 0, ["deep_link", "permission"].contains(type) {
                owner = InteractionOwner(lease: lease, revision: buffer.interactionRevisionLocked, host: nil, target: nil, liveTestId: nil, hostTag: nil)
            } else {
                guard let entry = registrations[id], entry.owner.generation == generation, entry.types.contains(type), currentLocked(entry.owner) else { return nil }
                owner = entry.owner
            }
            if owner.hasHost {
                var fields = owner.target ?? [:]; fields["screen"] = sourceScreen
                let target = (InteractionEventSanitizer.redact(fields) as? [String: Any]).flatMap(InteractionEventSanitizer.target)
                owner = InteractionOwner(lease: owner.lease, revision: owner.revision, host: owner.host, target: target, liveTestId: owner.liveTestId, hostTag: owner.hostTag, registrationId: owner.registrationId, generation: owner.generation)
            }
            let phase = type == "text_edit" ? (input["phase"] as? String ?? "change") : type == "scroll" ? "end" : "change"
            guard ["change", "end", "submit"].contains(phase), input["composing"] == nil || interactionBool(input["composing"]) != nil else { return nil }
            let composing = interactionBool(input["composing"]) == true
            var fields = input
            if type == "text_edit" { fields["reason"] = phase == "change" ? "idle" : phase; if composing { fields.removeValue(forKey: "value") } }
            let valueId = privacyVerified && candidate === registrations[id]?.owner && (type != "text_edit" || owner.host is UITextField || owner.host is UITextView) ? owner.liveTestId : nil
            guard let event = InteractionEventSanitizer.sanitize(fields, policy: policy, liveTestId: valueId) else { return nil }
            if type == "text_edit", phase == "change" {
                let superseded = prepared.filter { $0.observation?.phase == "change" && $0.observation?.event["type"] as? String == type && $0.observation?.owner.registrationId == owner.registrationId && $0.observation?.owner.generation == owner.generation }
                prepared.removeAll { cell in superseded.contains { $0 === cell } }; superseded.forEach { $0.observation = nil }
            }
            if ["text_edit", "scroll"].contains(type) { boundSummaryHostsLocked(owner) }
            guard prepared.count < 64 else { return nil }
            let item = PreparedInteraction(.init(owner: owner, event: event, phase: phase, composing: composing))
            prepared.append(item); return item
        }
    }
    func discardPrepared(_ item: PreparedInteraction) { buffer.withInteractionLock { prepared.removeAll { $0 === item }; item.observation = nil } }
    func cancelRegistration(id: String, generation: UInt64) { buffer.withInteractionLock {
        if generations[id] == generation { cancelRegistrationLocked(id) }
    } }
    private func cancelRegistrationLocked(_ id: String) {
        registrations.removeValue(forKey: id); pendingRegistrations.removeValue(forKey: id)
        pending.removeAll { $0.owner.registrationId == id }
        let removed = prepared.filter { $0.observation?.owner.registrationId == id }
        prepared.removeAll { $0.observation?.owner.registrationId == id }
        removed.forEach { $0.observation = nil }
    }
    @MainActor func recordPrepared(_ item: PreparedInteraction) -> Bool {
        let observation = buffer.withInteractionLock { () -> InteractionObservation? in
            guard let index = prepared.firstIndex(where: { $0 === item }) else { return nil }
            prepared.remove(at: index); defer { item.observation = nil }; return item.observation
        }
        if let observation, observation.phase == "context" { return buffer.withInteractionLock { currentLocked(observation.owner) } }
        return observation.map(observe) ?? false
    }
    private var policy: InteractionEventPolicy = .parse(nil)
    private var pending: [Pending] = []
    private var semanticTimes: [Double] = [], lifecycleTimes: [Double] = []
    private var hostTimes: [ObjectIdentifier: HostTime] = [:]
    private var registrations: [String: Registration] = [:], generations: [String: UInt64] = [:]
    private var pendingRegistrations: [String: (generation: UInt64, annotation: [String: Any]?)] = [:]
    private var registrationOverflow = false
    private var armedDeadline: Double?
    private var timerGeneration: UInt64 = 0
    private var revocationListeners: [() -> Void] = []
    func onRevoked(_ listener: @escaping () -> Void) { buffer.withInteractionLock { revocationListeners.append(listener) } }
    // Adapter stores share the revoke boundary: a stale snapshot cannot repopulate
    // an already-cleared queue. The body must not call back into the recorder/UI.
    func retainIfCurrent(_ owner: InteractionOwner, _ retain: () -> Void) -> Bool {
        buffer.withInteractionLock {
            guard currentLocked(owner) else { return false }
            retain(); return true
        }
    }

    init(buffer: BreadcrumbRingBuffer, clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 },
         schedule: @escaping (Double, @escaping () -> Void) -> Void = { delay, action in DispatchQueue.main.asyncAfter(deadline: .now() + delay / 1000, execute: action) }) {
        self.buffer = buffer; self.clock = clock; self.schedule = schedule
        buffer.withInteractionLock {
            buffer.interactionRevocation = { [weak self] in self?.eraseLocked() }
            buffer.interactionFreeze = { [weak self] in
                guard Thread.isMainThread else { return }
                MainActor.assumeIsolated { self?.flushReadyForFreeze() }
            }
        }
    }
    func configure(_ value: InteractionEventPolicy) { buffer.withInteractionLock { eraseLocked(); policy = value } }
    func lease() -> String? { buffer.withInteractionLock { enabledLocked() ? token : nil } }
    func revoke() { buffer.withInteractionLock { eraseLocked() } }
    var pendingCount: Int { buffer.withInteractionLock { pending.count } }
    func pendingDebugSnapshot() -> [[String: Any]] { buffer.withInteractionLock { pending.map(\.event) } }
    private func enabledLocked() -> Bool {
        !policy.disabled && [EverframeBreadcrumbKind.custom, .lifecycle, .navigation].contains { buffer.interactionKindEnabledLocked($0) }
    }
    private func eraseLocked() {
        token = UUID().uuidString
        prepared.forEach { $0.observation = nil }; prepared.removeAll()
        pending.removeAll(); semanticTimes.removeAll(); lifecycleTimes.removeAll(); hostTimes.removeAll()
        registrations.removeAll(); generations.removeAll(); pendingRegistrations.removeAll(); registrationOverflow = false; armedDeadline = nil
        revocationListeners.forEach { $0() }
    }
    @MainActor func owner(view: UIView? = nil, lease requested: String? = nil) -> InteractionOwner? {
        let lease = requested ?? self.lease()
        guard let lease, let revision = buffer.withInteractionLock({ enabledLocked() && lease == token ? buffer.interactionRevisionLocked : nil }) else { return nil }
        guard let view else { return InteractionOwner(lease: lease, revision: revision, host: nil, target: nil, liveTestId: nil, hostTag: nil) }
        guard safeHost(view) else { return nil }
        let snapshot = InteractionTargetResolver.resolve(view)
        let target = snapshot.data["target"]?.value as? [String: Any]
        guard interactionBool(target?["masked"]) != true else { return nil }
        let safeTarget = (target.map(InteractionEventSanitizer.redact) as? [String: Any]).flatMap(InteractionEventSanitizer.target)
        let owner = InteractionOwner(lease: lease, revision: revision, host: view, target: safeTarget, liveTestId: testId(view), hostTag: view.tag)
        return buffer.withInteractionLock {
            guard currentLocked(owner) else { return nil }
            guard let annotation = registrations.values.first(where: { $0.owner.host === view && currentLocked($0.owner) })?.annotation else { return owner }
            return InteractionOwner(lease: owner.lease, revision: owner.revision, host: view,
                target: (owner.target ?? [:]).merging(annotation) { _, value in value }, liveTestId: owner.liveTestId, hostTag: owner.hostTag)
        }
    }
    @MainActor func observe(_ observation: InteractionObservation) -> Bool {
        let owner = observation.owner
        guard let type = observation.event["type"] as? String,
              ["text_edit", "control_change", "scroll"].contains(type) == owner.hasHost,
              live(owner), ["change", "end", "submit"].contains(observation.phase),
              let policy = buffer.withInteractionLock({ currentLocked(owner) ? self.policy : nil }) else { return false }
        let composing = observation.composing || (type == "text_edit" && nativeComposing(owner))
        var input = observation.event
        if type == "text_edit" {
            input["reason"] = observation.phase == "change" ? "idle" : observation.phase
            if composing { input.removeValue(forKey: "value") }
        }
        let valueId = type != "text_edit" || owner.host is UITextField || owner.host is UITextView ? owner.liveTestId : nil
        guard let event = InteractionEventSanitizer.sanitize(input, policy: policy, liveTestId: valueId) else { return false }
        let delay = type == "text_edit" ? 750.0 : type == "scroll" ? 200.0 : type == "launch" && observation.deferLaunch ? 250.0 : 0
        let shouldPend = delay != 0 && (observation.phase == "change" || composing)
        let now = clock()
        let result: Bool? = buffer.withInteractionLock {
            guard currentLocked(owner), buffer.interactionKindEnabledLocked(InteractionEventSanitizer.kind(type)) else { return false }
            pending.removeAll { $0.owner.host === owner.host && $0.event["type"] as? String == type }
            guard shouldPend else { return nil }
            boundSummaryHostsLocked(owner)
            pending.append(Pending(owner, event, now + delay, composing, nativeTextEdit: observation.nativeTextEdit)); return true
        }
        if result == true { armTimer() }
        return result ?? admit(owner, event: event, now: now)
    }
    /// UI-queued and delayed text/scroll share one host bound; eviction never emits.
    private func boundSummaryHostsLocked(_ owner: InteractionOwner) {
        guard let host = owner.host else { return }
        let summaries = prepared.filter { ["text_edit", "scroll"].contains($0.observation?.event["type"] as? String ?? "") }
        let hosts = pending.compactMap { $0.owner.host } + summaries.compactMap { $0.observation?.owner.host }
        guard !hosts.contains(where: { $0 === host }), Set(hosts.map(ObjectIdentifier.init)).count >= 32, let oldest = hosts.first else { return }
        pending.removeAll { $0.owner.host === oldest }
        let removed = summaries.filter { $0.observation?.owner.host === oldest }
        prepared.removeAll { cell in removed.contains { $0 === cell } }; removed.forEach { $0.observation = nil }
    }
    private func armTimer() {
        let timer: (token: String, generation: UInt64, delay: Double)? = buffer.withInteractionLock {
            guard let deadline = pending.filter({ !$0.dormant }).map(\.deadline).min(),
                  armedDeadline.map({ deadline < $0 }) ?? true else { return nil }
            armedDeadline = deadline; timerGeneration &+= 1
            return (token, timerGeneration, max(1, deadline - clock()))
        }
        guard let timer else { return }
        schedule(timer.delay) { [weak self] in
            guard let self else { return }
            let active = self.buffer.withInteractionLock {
                guard self.token == timer.token, self.timerGeneration == timer.generation else { return false }
                self.armedDeadline = nil; return true
            }
            guard active, Thread.isMainThread else { return }
            MainActor.assumeIsolated { self.flushDue(); self.armTimer() }
        }
    }
    @MainActor func complete(host: UIView, type: String, reason: String) {
        guard let item = buffer.withInteractionLock({ pending.first { $0.owner.host === host && $0.event["type"] as? String == type } }) else { return }
        flush(item, reason: reason)
    }
    func cancel(host: UIView, type: String) { buffer.withInteractionLock { pending.removeAll { $0.owner.host === host && $0.event["type"] as? String == type } } }
    @MainActor func finishLaunch() {
        guard let item = buffer.withInteractionLock({ pending.first { $0.event["type"] as? String == "launch" } }) else { return }
        flush(item, reason: "end")
    }
    @MainActor func flushDue() {
        let now = clock(), ready = buffer.withInteractionLock { pending.filter { !$0.dormant && $0.deadline <= clock() } }
        for item in ready { flush(item, reason: "idle", now: now) }
    }
    @MainActor func flushReadyForFreeze() {
        let ready = buffer.withInteractionLock { pending }
        for item in ready { flush(item, reason: "freeze") }
    }
    @MainActor private func flush(_ item: Pending, reason: String, now: Double? = nil) {
        let live = live(item.owner)
        let composing = live && item.event["type"] as? String == "text_edit" && nativeComposing(item.owner)
        let nativeComposition = item.composing && item.nativeTextEdit
        let removed = buffer.withInteractionLock {
            guard let index = pending.firstIndex(where: { $0 === item }) else { return false }
            if live && nativeComposition && composing && currentLocked(item.owner) {
                // A span-only IME commit may have no text callback. Keep the original
                // edit's metadata within the shared host bound until end/freeze,
                // without polling or renewing its capture revision.
                item.dormant = true; return false
            }
            pending.remove(at: index)
            return live && !composing && (!item.composing || nativeComposition) && currentLocked(item.owner)
        }
        guard removed else { return }
        var event = item.event
        if event["type"] as? String == "text_edit" { event["reason"] = reason }
        _ = admit(item.owner, event: event, now: now ?? clock())
    }
    private func admit(_ owner: InteractionOwner, event: [String: Any], now: Double) -> Bool {
        guard let type = event["type"] as? String else { return false }
        var data: [String: Any] = ["interaction": event]; data["target"] = owner.target
        return buffer.addObservedInteraction(kind: InteractionEventSanitizer.kind(type), message: InteractionEventSanitizer.message(type), data: BreadcrumbRingBuffer.coerceHostData(data), captureRevision: owner.revision) {
            guard self.currentLocked(owner) else { return false }
            let semantic = ["text_edit", "control_change", "scroll"].contains(type)
            self.semanticTimes.removeAll { now - $0 >= 10000 }; self.lifecycleTimes.removeAll { now - $0 >= 10000 }
            guard semantic ? self.semanticTimes.count < 20 : self.lifecycleTimes.count < 10 else { return false }
            let limited = type == "text_edit" || type == "scroll"
            self.hostTimes = self.hostTimes.filter { $0.value.view != nil }
            if limited, let host = owner.host, let last = self.hostTimes[ObjectIdentifier(host)], now - last.time < 1000 { return false }
            if semantic { self.semanticTimes.append(now) } else { self.lifecycleTimes.append(now) }
            if limited, let host = owner.host { self.hostTimes[ObjectIdentifier(host)] = HostTime(view: host, time: now) }
            return true
        }
    }
    @MainActor func allowsValue(_ owner: InteractionOwner, type: String) -> Bool {
        guard live(owner), type != "text_edit" || owner.host is UITextField || owner.host is UITextView else { return false }
        return buffer.withInteractionLock { currentLocked(owner) && owner.liveTestId.map { policy.valueTestIds.contains($0) } == true }
    }
    func beginRegistration(id: String, generation: UInt64, lease: String, optionsJson: String? = nil) -> Bool {
        var input: [String: Any] = [:]
        if let optionsJson {
            guard optionsJson.utf8.count <= 8192, let data = optionsJson.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
            input = object
        }
        let raw = (input["target"] as? [String: Any])?.filter { ["name", "testId", "role", "container"].contains($0.key) }
        var annotation = (raw.map(InteractionEventSanitizer.redact) as? [String: Any]).flatMap(InteractionEventSanitizer.target)
        if annotation?["name"] != nil { annotation?["nameFrom"] = "annotation" }
        return buffer.withInteractionLock {
            guard enabledLocked(), lease == token, advanceLocked(id, generation) else { return false }
            pendingRegistrations[id] = (generation, annotation); return true
        }
    }
    @MainActor func completeRegistration(view: UIView, id: String, generation: UInt64, lease: String, types: Set<String>) -> Bool {
        guard types.isSubset(of: ["text_edit", "control_change", "scroll"]), let owner = owner(view: view, lease: lease) else { return false }
        return buffer.withInteractionLock {
            guard currentLocked(owner), let request = pendingRegistrations[id], request.generation == generation else { return false }
            let annotation = request.annotation
            let target = annotation.map { (owner.target ?? [:]).merging($0) { _, value in value } } ?? owner.target
            pendingRegistrations.removeValue(forKey: id)
            let displaced = registrations.filter { $0.value.owner.host === view }.map(\.key)
            for key in displaced { cancelRegistrationLocked(key) }
            pending.removeAll { $0.owner.host === view && ($0.event["type"] as? String).map(types.contains) == true }
            let bound = InteractionOwner(lease: owner.lease, revision: owner.revision, host: view, target: target, liveTestId: owner.liveTestId, hostTag: owner.hostTag, registrationId: id, generation: generation)
            registrations[id] = Registration(owner: bound, types: types, annotation: annotation); return true
        }
    }
    @MainActor func register(view: UIView, id: String, generation: UInt64, lease: String, types: Set<String>) -> Bool {
        beginRegistration(id: id, generation: generation, lease: lease) && completeRegistration(view: view, id: id, generation: generation, lease: lease, types: types)
    }
    func clearRegistration(id: String, generation: UInt64) -> Bool { buffer.withInteractionLock { advanceLocked(id, generation) } }
    private func advanceLocked(_ id: String, _ generation: UInt64) -> Bool {
        guard !registrationOverflow, InteractionEventPolicy.identifier(id, max: 256), generation <= 9_007_199_254_740_991,
              generations[id].map({ generation > $0 }) ?? true else { return false }
        if generations[id] == nil, generations.count >= 4096 {
            registrationOverflow = true; registrations.removeAll(); pendingRegistrations.removeAll(); pending.removeAll { $0.owner.registrationId != nil }; return false
        }
        cancelRegistrationLocked(id); generations[id] = generation; return true
    }
    @MainActor func registeredOwner(id: String, generation: UInt64, lease: String) -> InteractionOwner? {
        guard let entry = buffer.withInteractionLock({ registrations[id].flatMap { $0.owner.generation == generation && $0.owner.lease == lease && currentLocked($0.owner) ? $0 : nil } }),
              live(entry.owner), let host = entry.owner.host, let fresh = owner(view: host, lease: lease) else { return nil }
        return InteractionOwner(lease: fresh.lease, revision: fresh.revision, host: host, target: fresh.target, liveTestId: fresh.liveTestId, hostTag: fresh.hostTag, registrationId: id, generation: generation)
    }
    @MainActor func suppresses(view: UIView, type: String) -> Bool {
        let owners = buffer.withInteractionLock { registrations.values.filter { $0.types.contains(type) && $0.owner.host === view && currentLocked($0.owner) }.map(\.owner) }
        return owners.contains(where: live)
    }
    func helperOwns(_ owner: InteractionOwner, type: String) -> Bool { buffer.withInteractionLock { currentLocked(owner) && owner.registrationId.flatMap { registrations[$0]?.types.contains(type) } == true } }
    private func currentLocked(_ owner: InteractionOwner) -> Bool {
        guard enabledLocked(), owner.lease == token, owner.revision == buffer.interactionRevisionLocked else { return false }
        guard let id = owner.registrationId else { return true }
        return registrations[id].map { $0.owner.generation == owner.generation && $0.owner.host === owner.host } == true
    }
    @MainActor private func live(_ owner: InteractionOwner) -> Bool {
        guard owner.hasHost else { return true }
        guard let view = owner.host else { return false }
        return safeHost(view) && view.tag == owner.hostTag && testId(view) == owner.liveTestId
    }
    @MainActor private func nativeComposing(_ owner: InteractionOwner) -> Bool {
        if let field = owner.host as? UITextField { return field.markedTextRange != nil }
        if let field = owner.host as? UITextView { return field.markedTextRange != nil }
        return false
    }
    @MainActor private func safeHost(_ view: UIView) -> Bool {
        view.window != nil && !InteractionTargetResolver.sensitiveAncestry(view) &&
            (view as? UITextView)?.isSecureTextEntry != true
    }
    @MainActor private func testId(_ view: UIView) -> String? {
        let raw = InteractionTargetViewAdapters.describe(view)?.testId ?? view.accessibilityIdentifier
        return raw.flatMap { InteractionEventPolicy.identifier($0, max: 256) ? $0 : nil }
    }
}

/// Already-redacted queue cell; recorder revocation synchronously discards its contents.
public final class PreparedInteraction {
    var observation: InteractionObservation?
    init(_ observation: InteractionObservation) { self.observation = observation }
}
public final class InteractionCapture {
    let owner: InteractionOwner
    init(_ owner: InteractionOwner) { self.owner = owner }
}
public enum InteractionEvents {
    public static func openRuntime() -> String { InteractionEventRecorder.shared.openRuntime() }
    public static func ownsRuntime(_ id: String) -> Bool { InteractionEventRecorder.shared.ownsRuntime(id) }
    public static func closeRuntime(_ id: String) { InteractionEventRecorder.shared.closeRuntime(id) }
    public static func prepare(lease: String, id: String, generation: UInt64, json: String) -> PreparedInteraction? { InteractionEventRecorder.shared.prepare(lease: lease, id: id, generation: generation, json: json) }
    @MainActor public static func recordPrepared(_ item: PreparedInteraction) -> Bool { InteractionEventRecorder.shared.recordPrepared(item) }
    public static func discardPrepared(_ item: PreparedInteraction) { InteractionEventRecorder.shared.discardPrepared(item) }
    public static func cancelRegistration(id: String, generation: UInt64) { InteractionEventRecorder.shared.cancelRegistration(id: id, generation: generation) }
    public static func lease() -> String? { InteractionEventRecorder.shared.lease() }
    @MainActor public static func capture(view: UIView? = nil, lease: String? = nil) -> InteractionCapture? { InteractionEventRecorder.shared.owner(view: view, lease: lease).map(InteractionCapture.init) }
    @MainActor public static func allowsValue(_ capture: InteractionCapture, type: String) -> Bool { InteractionEventRecorder.shared.allowsValue(capture.owner, type: type) }
    @MainActor public static func suppresses(view: UIView, type: String) -> Bool { InteractionEventRecorder.shared.suppresses(view: view, type: type) }
    public static func beginRegistration(id: String, generation: UInt64, lease: String, optionsJson: String? = nil) -> Bool { InteractionEventRecorder.shared.beginRegistration(id: id, generation: generation, lease: lease, optionsJson: optionsJson) }
    @MainActor public static func completeRegistration(view: UIView, id: String, generation: UInt64, lease: String, types: Set<String>) -> Bool { InteractionEventRecorder.shared.completeRegistration(view: view, id: id, generation: generation, lease: lease, types: types) }
    public static func clearRegistration(id: String, generation: UInt64) -> Bool { InteractionEventRecorder.shared.clearRegistration(id: id, generation: generation) }
    @MainActor public static func registeredCapture(id: String, generation: UInt64, lease: String) -> InteractionCapture? { InteractionEventRecorder.shared.registeredOwner(id: id, generation: generation, lease: lease).map(InteractionCapture.init) }
    public static func helperOwns(_ capture: InteractionCapture, type: String) -> Bool { InteractionEventRecorder.shared.helperOwns(capture.owner, type: type) }
    @MainActor public static func record(_ capture: InteractionCapture, json: String, phase: String = "change", composing: Bool = false) -> Bool {
        guard json.utf8.count <= 8192, let data = json.data(using: .utf8), let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return InteractionEventRecorder.shared.observe(.init(owner: capture.owner, event: event, phase: phase, composing: composing))
    }
    @MainActor public static func complete(view: UIView, type: String, reason: String) { InteractionEventRecorder.shared.complete(host: view, type: type, reason: reason) }
}
#endif
