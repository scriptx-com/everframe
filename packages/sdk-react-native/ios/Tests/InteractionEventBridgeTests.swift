// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import XCTest
import UIKit
@testable import EverframeKit
@testable import EverframeRN

@MainActor final class InteractionEventBridgeTests: XCTestCase {
    private var window: UIWindow!, view: UITextField!, bridge: RnInteractionEventRegistration!
    private let options = #"{"helperTypes":["control_change"]}"#
    private let text = #"{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"#
    private let control = #"{"type":"control_change","source":"app","observedAt":1,"control":"checkbox","checked":true}"#
    private let permission = #"{"type":"permission","source":"app","observedAt":1,"permission":"camera","phase":"result","result":"granted"}"#
    override func setUp() {
        Everframe.captureGate = true; BreadcrumbRingBuffer.shared.applyConfig(nil); BreadcrumbRingBuffer.shared.clear()
        window = UIWindow(frame: CGRect(x: 0,y: 0,width: 400,height: 800)); window.rootViewController = UIViewController(); window.isHidden = false
        view = UITextField(); view.tag = 2; window.rootViewController!.view.addSubview(view)
        bridge = RnInteractionEventRegistration()
    }
    override func tearDown() { bridge.close(); window.isHidden = true; BreadcrumbRingBuffer.shared.clear(); Everframe.captureGate = false }
    private func drain() async { await Task.yield(); try? await Task.sleep(nanoseconds: 30_000_000) }
    private func register(_ generation: Double = 1, lease: String? = nil) -> Bool {
        bridge.setObserver(2, id: "A", generation: generation, lease: lease ?? bridge.lease(), optionsJson: options, resolve: { [weak self] _ in self?.view }, host: { $0 })
    }
    private final class ScrollComponentView: UIView {
        @objc let scrollView = UIScrollView()
        override init(frame: CGRect) { super.init(frame: frame); addSubview(scrollView) }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    }
    func testScrollHelperResolvesPublicNativeHostAndRecycleRevokesIt() async {
        let wrapper = ScrollComponentView(frame: .zero); wrapper.tag = 3
        window.rootViewController!.view.addSubview(wrapper)
        let lease = bridge.lease()
        XCTAssertTrue(bridge.setObserver(3, id: "scroll", generation: 1, lease: lease,
            optionsJson: #"{"helperTypes":["scroll"]}"#, resolve: { _ in wrapper }, host: { $0 }))
        await drain()
        XCTAssertTrue(InteractionEvents.suppresses(view: wrapper.scrollView, type: "scroll"))
        XCTAssertFalse(InteractionEvents.suppresses(view: wrapper, type: "scroll"))
        let adapter = InteractionScrollAdapter(recorder: .shared)
        defer { adapter.close() }
        wrapper.scrollView.frame = CGRect(x: 0, y: 0, width: 100, height: 100)
        wrapper.scrollView.contentSize = CGSize(width: 100, height: 1000)
        adapter.remoteBegan(wrapper.scrollView, axis: "y")
        wrapper.scrollView.contentOffset.y = 100; adapter.finished(wrapper.scrollView)
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size, 0)
        XCTAssertTrue(bridge.record(lease, id: "scroll", generation: 1, eventJson: #"{"type":"scroll","source":"app","observedAt":1,"axis":"y","direction":"forward"}"#))
        await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size, 1)
        RnInteractionEventRegistration.invalidateView(wrapper)
        XCTAssertFalse(InteractionEvents.suppresses(view: wrapper.scrollView, type: "scroll"))
    }
    func testThousandSupportedControlsKeepOneDrainAndBoundMailbox() async {
        bridge.close()
        var queue: [@MainActor () -> Void] = []
        bridge = RnInteractionEventRegistration(dispatchRecord: { queue.append($0) })
        let lease = bridge.lease(); XCTAssertTrue(register()); await drain()
        for position in 1...1000 {
            let change = "{\"type\":\"control_change\",\"source\":\"app\",\"observedAt\":1,\"control\":\"slider\",\"position\":\(position)}"
            XCTAssertEqual(bridge.record(lease, id: "A", generation: 1, eventJson: change), position <= 64)
        }
        XCTAssertEqual(queue.count, 1)
        while !queue.isEmpty { queue.removeFirst()() }
        let events = BreadcrumbRingBuffer.shared.snapshot().compactMap { $0.data?["interaction"]?.value as? [String: Any] }
        XCTAssertEqual(events.count, 20)
        // The 64-cell prepare bound rejects overflow before queueing; admission
        // then applies its independent semantic event budget to the retained batch.
        XCTAssertEqual(interactionNumber(events.first?["position"]), 1)
        XCTAssertEqual(interactionNumber(events.last?["position"]), 20)
    }
    func testRepeatedRevocationCannotAccumulateRecordCallbacks() {
        bridge.close()
        var queue: [@MainActor () -> Void] = []
        bridge = RnInteractionEventRegistration(dispatchRecord: { queue.append($0) })
        for _ in 0..<1000 {
            XCTAssertTrue(bridge.record(bridge.lease(), id: "", generation: 0, eventJson: permission))
            BreadcrumbRingBuffer.shared.clear()
        }
        XCTAssertEqual(queue.count, 1)
        while !queue.isEmpty { queue.removeFirst()() }
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size, 0)
    }
    func testClearAndLeaseRevocationBeforeMainResolution() async {
        let lease = bridge.lease(); XCTAssertTrue(register(lease: lease)); XCTAssertTrue(bridge.clearObserver("A", generation: 2))
        await drain(); XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "control_change"))
        XCTAssertFalse(register(1, lease: lease))
        XCTAssertTrue(register(3, lease: lease)); BreadcrumbRingBuffer.shared.clear(); await drain()
        XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "control_change"))
        XCTAssertFalse(register(4, lease: lease)); XCTAssertFalse(bridge.record(lease, id: "", generation: 0, eventJson: permission))
        XCTAssertTrue(bridge.record(bridge.lease(), id: "", generation: 0, eventJson: permission)); await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,1)
    }
    func testLiveHostOnlySuppressesItsTypesAndSecureOrDetachedEventsDrop() async {
        let lease = bridge.lease(); XCTAssertTrue(register()); await drain()
        XCTAssertTrue(InteractionEvents.suppresses(view: view,type: "control_change")); XCTAssertFalse(InteractionEvents.suppresses(view: view,type: "scroll"))
        XCTAssertTrue(bridge.record(lease,id: "A",generation: 1,eventJson: control)); view.isSecureTextEntry = true; await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,0)
        view.isSecureTextEntry = false
        XCTAssertTrue(bridge.record(lease,id: "A",generation: 1,eventJson: control)); view.removeFromSuperview(); await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,0)
    }
    func testRecycleInvalidatesSameObjectAndTagWithoutConsumingNextJsGeneration() async {
        let lease = bridge.lease(); XCTAssertTrue(register()); await drain()
        RnInteractionEventRegistration.invalidateView(view)
        XCTAssertFalse(bridge.record(lease,id: "A",generation: 1,eventJson: control))
        XCTAssertFalse(InteractionEvents.suppresses(view: view,type: "control_change"))
        XCTAssertTrue(register(2)); await drain()
        XCTAssertTrue(InteractionEvents.suppresses(view: view,type: "control_change"))
    }
    func testMixedRegistrationKeepsAutomaticNativeTextAndSupportedHelpers() async throws {
        let lease = bridge.lease()
        let mixed = #"{"target":{"name":"Native input"},"helperTypes":["text_edit","control_change","scroll"]}"#
        XCTAssertTrue(bridge.setObserver(2, id: "mixed", generation: 1, lease: lease, optionsJson: mixed, resolve: { _ in self.view }, host: { $0 }))
        await drain()
        XCTAssertEqual(bridge.lease(), lease)
        XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "text_edit"))
        XCTAssertTrue(InteractionEvents.suppresses(view: view, type: "control_change"))
        XCTAssertTrue(InteractionEvents.suppresses(view: view, type: "scroll"))
        XCTAssertFalse(bridge.record(lease, id: "mixed", generation: 1, eventJson: text))
        let adapter = InteractionTextAdapter(recorder: .shared)
        adapter.install(); defer { adapter.close() }
        view.becomeFirstResponder(); XCTAssertTrue(view.isFirstResponder)
        view.text = "Native"
        NotificationCenter.default.post(name: UITextField.textDidChangeNotification, object: view)
        NotificationCenter.default.post(name: UITextField.textDidEndEditingNotification, object: view)
        let native = try XCTUnwrap(BreadcrumbRingBuffer.shared.snapshot().first)
        let event = try XCTUnwrap(native.data?["interaction"]?.value as? [String: Any])
        XCTAssertEqual(event["source"] as? String, "native")
        XCTAssertEqual(event["type"] as? String, "text_edit")
        XCTAssertEqual(interactionNumber(event["length"]), 6)
        XCTAssertEqual((native.data?["target"]?.value as? [String: Any])?["name"] as? String, "Native input")
        XCTAssertTrue(bridge.record(lease, id: "mixed", generation: 1, eventJson: control))
        await drain(); XCTAssertEqual(BreadcrumbRingBuffer.shared.size, 2)
    }
    func testTextOnlyAndDuplicateKnownRegistrationsPreserveValidation() async {
        let lease = bridge.lease()
        let textOnly = #"{"target":{"name":"Observed field"},"helperTypes":["text_edit"]}"#
        XCTAssertTrue(bridge.setObserver(2, id: "A", generation: 1, lease: lease, optionsJson: textOnly, resolve: { _ in self.view }, host: { $0 }))
        await drain()
        XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "text_edit"))
        XCTAssertFalse(bridge.record(lease, id: "A", generation: 1, eventJson: text))
        XCTAssertEqual(InteractionEventRecorder.shared.owner(view: view)?.target?["name"] as? String, "Observed field")
        let duplicate = #"{"helperTypes":["text_edit","scroll","scroll"]}"#
        XCTAssertTrue(bridge.setObserver(2, id: "A", generation: 2, lease: lease, optionsJson: duplicate, resolve: { _ in self.view }, host: { $0 }))
        await drain()
        XCTAssertTrue(InteractionEvents.suppresses(view: view, type: "scroll"))
        XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "text_edit"))
        for invalid in [#"{"helperTypes":["text_edit","unknown"]}"#, #"{"helperTypes":["text_edit",1]}"#, #"{"helperTypes":["text_edit","scroll","scroll","scroll"]}"#] {
            XCTAssertFalse(bridge.setObserver(2, id: "A", generation: 3, lease: lease, optionsJson: invalid, resolve: { _ in self.view }, host: { $0 }))
        }
        XCTAssertTrue(InteractionEvents.suppresses(view: view, type: "scroll"))
        XCTAssertEqual(bridge.lease(), lease)
    }
    func testMalformedInputsAndOldModuleCannotOverrideNew() async {
        let old = bridge.lease()
        for tag in [0.0,-1.0,Double.nan,1.5] { XCTAssertFalse(bridge.setObserver(tag,id: "A",generation: 1,lease: old,optionsJson: options,resolve: { _ in self.view },host: { $0 })) }
        for json in ["{","[]",String(repeating:"x",count:8193),text] { XCTAssertFalse(bridge.record(old,id: "",generation: 0,eventJson: json)) }
        let newer = RnInteractionEventRegistration(); defer { newer.close() }
        let next = newer.lease(); bridge.close(); XCTAssertEqual(next,newer.lease()); XCTAssertNotEqual(old,next)
        XCTAssertFalse(bridge.record(old,id: "",generation: 0,eventJson: permission))
        XCTAssertTrue(newer.record(next,id: "",generation: 0,eventJson: permission)); await drain(); XCTAssertEqual(BreadcrumbRingBuffer.shared.size,1)
    }
}
#endif
