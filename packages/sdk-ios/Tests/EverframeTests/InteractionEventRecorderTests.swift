// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionEventRecorderTests {
    @MainActor private final class Fixture {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let buffer = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
        var now = 0.0
        lazy var recorder = InteractionEventRecorder(buffer: buffer, clock: { [unowned self] in now }, schedule: { _, _ in })
        init() { window.rootViewController = UIViewController(); window.isHidden = false }
        func field() -> UITextField { let view = UITextField(); window.rootViewController!.view.addSubview(view); return view }
        func text(_ view: UIView, phase: String = "change", composing: Bool = false) throws {
            let owner = try #require(recorder.owner(view: view))
            _ = recorder.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6, "value": "SECRET"]), phase: phase, composing: composing))
        }
    }
    @Test func helperTextCapturedWhileSensitiveDoesNotEmitAfterUnmask() throws {
        let f = Fixture(), view = f.field(), lease = try #require(f.recorder.lease())
        #expect(f.recorder.register(view: view, id: "secure", generation: 1, lease: lease, types: ["text_edit"]))
        for secure in [true, false] {
            if secure { view.isSecureTextEntry = true } else { SensitiveRectRegistry.mark(view) }
            let item = f.recorder.prepare(lease: lease, id: "secure", generation: 1, json: #"{"type":"text_edit","source":"app","observedAt":1,"length":17,"phase":"end"}"#)
            view.isSecureTextEntry = false; view.everframe_isSensitive = false
            if let item { _ = f.recorder.recordPrepared(item) }
            #expect(f.buffer.size == 0)
        }
    }
    @Test func offMainTextPreparationRejectsUnknownPrivacyBeforeUnmasking() async throws {
        for mode in ["safe", "secure", "masked"] {
            let f = Fixture(), view = f.field(), lease = try #require(f.recorder.lease())
            #expect(f.recorder.register(view: view, id: "off-main", generation: 1, lease: lease, types: ["text_edit"]))
            if mode == "secure" { view.isSecureTextEntry = true }
            if mode == "masked" { SensitiveRectRegistry.mark(view) }
            let recorder = f.recorder
            let item = await Task.detached {
                recorder.prepare(lease: lease, id: "off-main", generation: 1,
                    json: #"{"type":"text_edit","source":"app","observedAt":1,"length":17,"value":"PRIVATE-CAPTURE","phase":"end"}"#)
            }.value
            #expect(item == nil)
            view.isSecureTextEntry = false; view.everframe_isSensitive = false
            if let item { _ = recorder.recordPrepared(item) }
            #expect(f.buffer.size == 0)
        }
    }
    @Test func earlierScrollAndLaunchDeadlinesSupersedeTextTimer() throws {
        let f = Fixture(); var timers: [(Double, () -> Void)] = []
        let recorder = InteractionEventRecorder(buffer: f.buffer, clock: { f.now }, schedule: { delay, action in timers.append((f.now + delay, action)) })
        let text = f.field(), scroll = f.field()
        _ = recorder.observe(.init(owner: try #require(recorder.owner(view: text)), event: interactionEvent("text_edit", ["length": 1])))
        f.now = 50
        _ = recorder.observe(.init(owner: try #require(recorder.owner(view: scroll)), event: interactionEvent("scroll", ["axis": "y", "direction": "forward"])))
        #expect(timers.map(\.0).min() == 250)
        f.now = 250
        for timer in timers.filter({ $0.0 <= f.now }) { timer.1() }
        #expect(f.buffer.size == 1)
        _ = recorder.observe(.init(owner: try #require(recorder.owner()), event: interactionEvent("launch", ["start": "cold"]), deferLaunch: true))
        f.now = 500
        for timer in timers.filter({ $0.0 == 500 }) { timer.1() }
        #expect(f.buffer.size == 2)
        f.now = 750
        for timer in timers.filter({ $0.0 == 750 }) { timer.1() }
        #expect(f.buffer.size == 3)
    }
    @Test func preparedAndDelayedSummariesShareThe32HostBound() throws {
        let f = Fixture(), lease = try #require(f.recorder.lease())
        for _ in 0..<17 { try f.text(f.field()) }
        var cells: [PreparedInteraction] = []
        for index in 0..<16 {
            let view = f.field(), id = "queued-\(index)"
            #expect(f.recorder.register(view: view, id: id, generation: 1, lease: lease, types: ["text_edit"]))
            cells.append(try #require(f.recorder.prepare(lease: lease, id: id, generation: 1, json: #"{"type":"text_edit","source":"app","observedAt":1,"length":6}"#)))
        }
        #expect(f.recorder.pendingCount + cells.filter { $0.observation != nil }.count == 32)
    }
    @Test func queuedValuesRequireCurrentMainThreadPrivacyProof() async throws {
        let f = Fixture(), view = f.field(); view.accessibilityIdentifier = "search"
        f.recorder.configure(.parse(#"{"valueTestIds":["search"]}"#)); let lease = try #require(f.recorder.lease())
        #expect(f.recorder.register(view: view, id: "A", generation: 1, lease: lease, types: ["text_edit"]))
        let recorder = f.recorder
        let json = #"{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"#
        let retained = await Task.detached { String(describing: recorder.prepare(lease: lease, id: "A", generation: 1, json: json)?.observation?.event) }.value
        #expect(!retained.contains("SECRET"))
        view.isSecureTextEntry = true
        let secure = f.recorder.prepare(lease: lease, id: "A", generation: 1, json: json)
        let secureRetained = String(describing: secure?.observation?.event)
        #expect(!secureRetained.contains("SECRET"))
        if let secure { #expect(!f.recorder.recordPrepared(secure)) }
    }
    @Test func nativeCompositionAndQueuedBurstCannotProduceIntermediateOrStaleText() throws {
        let f = Fixture(), view = f.field(), lease = try #require(f.recorder.lease())
        view.becomeFirstResponder(); view.setMarkedText("composing", selectedRange: NSRange(location: 9, length: 0))
        #expect(view.markedTextRange != nil)
        #expect(f.recorder.register(view: view, id: "A", generation: 1, lease: lease, types: ["text_edit"]))
        let json = #"{"type":"text_edit","source":"app","observedAt":1,"length":9,"phase":"end"}"#
        let item = try #require(f.recorder.prepare(lease: lease, id: "A", generation: 1, json: json))
        #expect(f.recorder.recordPrepared(item)); f.recorder.flushReadyForFreeze(); #expect(f.buffer.size == 0)
        view.unmarkText()
        for index in 0..<1000 { _ = f.recorder.prepare(lease: lease, id: "A", generation: 1, json: "{\"type\":\"text_edit\",\"source\":\"app\",\"observedAt\":1,\"length\":\(index)}") }
        let last = try #require(f.recorder.prepare(lease: lease, id: "A", generation: 1, json: #"{"type":"text_edit","source":"app","observedAt":1,"length":1000}"#))
        #expect(f.recorder.recordPrepared(last)); f.now = 750; f.recorder.flushDue()
        let event = f.buffer.snapshot().last?.data?["interaction"]?.value as? [String: Any]
        #expect(interactionNumber(event?["length"]) == 1000)
    }
    @Test func queuedBridgeObservationsEraseOnRevocationAndOldRuntimeCannotCloseNew() throws {
        let f = Fixture(), first = f.recorder.openRuntime()
        let lease = try #require(f.recorder.lease())
        let json = #"{"type":"permission","source":"app","observedAt":1,"permission":"camera","phase":"result","result":"granted"}"#
        let item = try #require(f.recorder.prepare(lease: lease, id: "", generation: 0, json: json))
        f.buffer.clear()
        #expect(item.observation == nil); #expect(!f.recorder.recordPrepared(item))
        #expect(f.recorder.prepare(lease: lease, id: "", generation: 0, json: json) == nil)
        let second = f.recorder.openRuntime(), next = try #require(f.recorder.lease())
        f.recorder.closeRuntime(first); #expect(f.recorder.ownsRuntime(second)); #expect(f.recorder.lease() == next)
        let fresh = try #require(f.recorder.prepare(lease: next, id: "", generation: 0, json: json))
        #expect(f.recorder.recordPrepared(fresh)); #expect(f.buffer.size == 1)
    }
    @Test func bridgeQueueRequiresHelperOwnershipAndDoesNotRetainUnallowedValues() throws {
        let f = Fixture(), view = f.field(), lease = try #require(f.recorder.lease())
        #expect(f.recorder.register(view: view, id: "A", generation: 1, lease: lease, types: ["text_edit"]))
        let json = #"{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"#
        let item = try #require(f.recorder.prepare(lease: lease, id: "A", generation: 1, json: json))
        let retained = String(describing: item.observation?.event)
        #expect(!retained.contains("SECRET"))
        #expect(f.recorder.prepare(lease: lease, id: "", generation: 0, json: json) == nil)
        #expect(f.recorder.prepare(lease: lease, id: "A", generation: 1, json: String(repeating: "x", count: 8193)) == nil)
        view.isSecureTextEntry = true
        #expect(!f.recorder.recordPrepared(item)); #expect(f.buffer.size == 0)
    }
    @Test func bridgeCapturesSourceScreenWhenCalledAndClearErasesQueuedValue() throws {
        let f = Fixture(), view = f.field(), lease = try #require(f.recorder.lease())
        InteractionTargetScreenState.recordExplicit("Mounted")
        #expect(f.recorder.register(view: view, id: "A", generation: 1, lease: lease, types: ["text_edit"]))
        InteractionTargetScreenState.recordExplicit("Source")
        let json = #"{"type":"text_edit","source":"app","observedAt":1,"length":6,"phase":"end"}"#
        let item = try #require(f.recorder.prepare(lease: lease, id: "A", generation: 1, json: json))
        InteractionTargetScreenState.recordExplicit("Destination")
        #expect(f.recorder.recordPrepared(item))
        let target = f.buffer.snapshot().last?.data?["target"]?.value as? [String: Any]
        #expect(target?["screen"] as? String == "Source")
        let queued = try #require(f.recorder.prepare(lease: lease, id: "A", generation: 1, json: json))
        #expect(f.recorder.clearRegistration(id: "A", generation: 2)); #expect(queued.observation == nil)
        InteractionTargetScreenState.reset()
    }
    @Test func observerMetadataBelongsToItsRegistrationAndNeverGrantsValuePermission() throws {
        let f = Fixture(), view = f.field()
        f.recorder.configure(.parse(#"{"valueTestIds":["allowed"]}"#)); let lease = try #require(f.recorder.lease())
        let options = #"{"target":{"name":"Search control","testId":"allowed","screen":"forged"},"helperTypes":[]}"#
        #expect(f.recorder.beginRegistration(id: "A", generation: 1, lease: lease, optionsJson: options))
        #expect(f.recorder.completeRegistration(view: view, id: "A", generation: 1, lease: lease, types: []))
        let owner = try #require(f.recorder.owner(view: view))
        #expect(owner.target?["name"] as? String == "Search control")
        #expect(owner.target?["screen"] as? String != "forged")
        #expect(!f.recorder.allowsValue(owner, type: "text_edit"))
        #expect(f.recorder.clearRegistration(id: "A", generation: 2))
        #expect(f.recorder.owner(view: view)?.target?["name"] as? String != "Search control")
    }
    @Test func pendingPressureEvictsWithoutEmission() throws {
        let f = Fixture()
        for _ in 0..<33 { try f.text(f.field()) }
        #expect(f.recorder.pendingCount == 32); #expect(f.buffer.size == 0)
        f.now = 750; f.recorder.flushDue()
        #expect(f.buffer.size == 20); #expect(f.recorder.pendingCount == 0)
    }
    @Test func separateBudgetsPreserveTapsAndErrors() throws {
        let f = Fixture()
        for _ in 0..<21 { try f.text(f.field(), phase: "end") }
        for _ in 0..<11 {
            let owner = try #require(f.recorder.owner())
            _ = f.recorder.observe(.init(owner: owner, event: interactionEvent("permission", ["permission": "camera", "phase": "requested"])))
        }
        #expect(f.buffer.size == 30)
        f.buffer.add(kind: .tap, message: "tap"); f.buffer.add(kind: .error, message: "error")
        #expect(f.buffer.size == 32)
        f.now = 10000; try f.text(f.field(), phase: "end"); #expect(f.buffer.size == 33)
    }
    @Test func sharedHostBudgetForTextAndScroll() throws {
        let f = Fixture(), view = f.field()
        try f.text(view, phase: "end")
        let event = interactionEvent("scroll", ["axis": "y", "direction": "forward"])
        _ = f.recorder.observe(.init(owner: try #require(f.recorder.owner(view: view)), event: event, phase: "end"))
        #expect(f.buffer.size == 1)
        f.now = 1000
        _ = f.recorder.observe(.init(owner: try #require(f.recorder.owner(view: view)), event: event, phase: "end"))
        #expect(f.buffer.size == 2)
    }
    @Test func secureMaskedDetachedAndComposingTextDoesNotFlush() throws {
        let f = Fixture(), secure = f.field()
        secure.isSecureTextEntry = true; #expect(f.recorder.owner(view: secure) == nil)
        let masked = f.field(); try f.text(masked); SensitiveRectRegistry.mark(masked)
        let detached = f.field(); try f.text(detached); detached.removeFromSuperview()
        try f.text(f.field(), composing: true)
        f.now = 1000; f.recorder.flushReadyForFreeze()
        #expect(f.buffer.size == 0); #expect(!String(describing: f.recorder.pendingDebugSnapshot()).contains("SECRET"))
    }
    @Test func mainThreadFreezeSamplesOnlySafeSummary() throws {
        let f = Fixture(); try f.text(f.field()); f.buffer.freeze()
        let event = try #require(f.buffer.takeFrozen()?.first?.data?["interaction"]?.value as? [String: Any])
        #expect(event["reason"] as? String == "freeze"); #expect(event["value"] == nil)
    }
    @Test func backgroundFreezeDoesNotWaitForMainThread() throws {
        let f = Fixture(); try f.text(f.field())
        let semaphore = DispatchSemaphore(value: 0), buffer = f.buffer
        DispatchQueue.global().async { buffer.freeze(); semaphore.signal() }
        // Blocking main deliberately proves freeze never sync-dispatches to it.
        #expect(semaphore.wait(timeout: .now() + 2) == .success)
        #expect(f.buffer.takeFrozen()?.isEmpty == true)
    }
    @Test func clearDisableAndRuntimeChangeRevokeOldObservation() throws {
        let f = Fixture()
        let actions: [() -> Void] = [{ f.buffer.clear() }, { f.buffer.applyConfig(.init(enabled: false, kinds: ["custom"], maxCount: 100, byteBudget: 65536, consoleEntryCap: 1024)) }, { f.recorder.revoke() }, { f.recorder.configure(.parse(nil)) }]
        for action in actions {
            f.buffer.applyConfig(nil)
            let owner = try #require(f.recorder.owner(view: f.field()))
            _ = f.recorder.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6, "value": "SECRET"])))
            action(); #expect(f.recorder.pendingCount == 0)
            f.buffer.applyConfig(nil)
            #expect(owner.lease != f.recorder.lease())
            #expect(!f.recorder.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6]), phase: "end")))
            #expect(f.buffer.size == 0)
        }
    }
    @Test func kindDisableCannotReplayOnReenable() throws {
        let f = Fixture(); try f.text(f.field())
        f.buffer.applyConfig(.init(enabled: true, kinds: ["tap"], maxCount: 100, byteBudget: 65536, consoleEntryCap: 1024))
        f.buffer.applyConfig(nil); f.now = 1000; f.recorder.flushDue(); #expect(f.buffer.size == 0)
    }
    @Test func helperGenerationsRevokePendingAndSuppression() throws {
        let f = Fixture(), view = f.field(), lease = try #require(f.recorder.lease())
        #expect(f.recorder.register(view: view, id: "ref", generation: 1, lease: lease, types: ["text_edit"]))
        let owner = try #require(f.recorder.registeredOwner(id: "ref", generation: 1, lease: lease))
        #expect(f.recorder.suppresses(view: view, type: "text_edit"))
        _ = f.recorder.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6])))
        #expect(f.recorder.clearRegistration(id: "ref", generation: 2))
        #expect(f.recorder.pendingCount == 0); #expect(!f.recorder.suppresses(view: view, type: "text_edit"))
        #expect(!f.recorder.register(view: view, id: "ref", generation: 1, lease: lease, types: ["text_edit"]))
        #expect(!f.recorder.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6]), phase: "end")))
        #expect(f.recorder.register(view: view, id: "ref", generation: 3, lease: lease, types: ["text_edit"]))
        f.buffer.clear()
        #expect(!f.recorder.suppresses(view: view, type: "text_edit")); #expect(f.recorder.registeredOwner(id: "ref", generation: 3, lease: lease) == nil)
    }
    @Test func helperOwnershipCancelsPendingAutomaticAndAnnotationsNeverGrantValues() throws {
        let f = Fixture(), view = f.field(); try f.text(view)
        #expect(f.recorder.register(view: view, id: "ref", generation: 1, lease: try #require(f.recorder.lease()), types: ["text_edit"]))
        f.now = 1000; f.recorder.flushDue(); #expect(f.buffer.size == 0)
        f.recorder.configure(.parse(#"{"valueTestIds":["search"]}"#))
        InteractionTargetRegistry.set(view: view, registrationId: "metadata", generation: 1, annotation: ["testId": "search\0"])
        defer { InteractionTargetRegistry.reset() }
        #expect(!f.recorder.allowsValue(try #require(f.recorder.owner(view: view)), type: "text_edit"))
        view.accessibilityIdentifier = "search"
        #expect(f.recorder.allowsValue(try #require(f.recorder.owner(view: view)), type: "text_edit"))
    }
    @Test func oneTimerUnderSustainedTypingAndOldTimerCannotFlushNewWork() throws {
        let f = Fixture(); var timers: [() -> Void] = []
        let recorder = InteractionEventRecorder(buffer: f.buffer, clock: { f.now }, schedule: { _, action in timers.append(action) })
        let view = f.field()
        for _ in 0..<1000 {
            _ = recorder.observe(.init(owner: try #require(recorder.owner(view: view)), event: interactionEvent("text_edit", ["length": 1])))
            f.now += 1
        }
        #expect(timers.count == 1); f.buffer.clear()
        _ = recorder.observe(.init(owner: try #require(recorder.owner(view: view)), event: interactionEvent("text_edit", ["length": 2])))
        f.now += 1000; timers.first?(); #expect(f.buffer.size == 0)
        timers.last?(); #expect(f.buffer.size == 1)
    }
    @Test func signoutRevokesSharedRecorderAndUnknownHostsCannotCarryValues() throws {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        let savedGate = Everframe.captureGate
        Everframe.captureGate = true
        defer { Everframe.captureGate = savedGate; BreadcrumbRingBuffer.shared.clear() }
        BreadcrumbRingBuffer.shared.applyConfig(nil); BreadcrumbRingBuffer.shared.clear()
        let f = Fixture(), owner = try #require(InteractionEventRecorder.shared.owner(view: f.field()))
        _ = InteractionEventRecorder.shared.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6])))
        Everframe.shared.setIdentityToken(nil)
        #expect(InteractionEventRecorder.shared.pendingCount == 0)
        #expect(owner.lease != InteractionEventRecorder.shared.lease())
        #expect(!InteractionEventRecorder.shared.observe(.init(owner: owner, event: interactionEvent("text_edit", ["length": 6]), phase: "end")))
        #expect(BreadcrumbRingBuffer.shared.size == 0)
        let custom = UIView(); custom.accessibilityIdentifier = "search"; f.window.rootViewController!.view.addSubview(custom)
        f.recorder.configure(.parse(#"{"valueTestIds":["search"]}"#))
        let customOwner = try #require(f.recorder.owner(view: custom))
        #expect(!f.recorder.allowsValue(customOwner, type: "text_edit"))
        _ = f.recorder.observe(.init(owner: customOwner, event: interactionEvent("text_edit", ["length": 6, "value": "SECRET"]), phase: "end"))
        #expect(!String(describing: f.buffer.snapshot()).contains("SECRET"))
    }
}
#endif
