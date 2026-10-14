// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import XCTest
import UIKit
@testable import EverframeKit
@testable import EverframeRN

@MainActor final class InteractionEventBridgeTests: XCTestCase {
    private var window: UIWindow!, view: UITextField!, bridge: RnInteractionEventRegistration!
    private let options = #"{"helperTypes":["text_edit"]}"#
    private let text = #"{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"#
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
    func testClearAndLeaseRevocationBeforeMainResolution() async {
        let lease = bridge.lease(); XCTAssertTrue(register(lease: lease)); XCTAssertTrue(bridge.clearObserver("A", generation: 2))
        await drain(); XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "text_edit"))
        XCTAssertFalse(register(1, lease: lease))
        XCTAssertTrue(register(3, lease: lease)); BreadcrumbRingBuffer.shared.clear(); await drain()
        XCTAssertFalse(InteractionEvents.suppresses(view: view, type: "text_edit"))
        XCTAssertFalse(register(4, lease: lease)); XCTAssertFalse(bridge.record(lease, id: "", generation: 0, eventJson: permission))
        XCTAssertTrue(bridge.record(bridge.lease(), id: "", generation: 0, eventJson: permission)); await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,1)
    }
    func testLiveHostOnlySuppressesItsTypesAndSecureOrDetachedEventsDrop() async {
        let lease = bridge.lease(); XCTAssertTrue(register()); await drain()
        XCTAssertTrue(InteractionEvents.suppresses(view: view,type: "text_edit")); XCTAssertFalse(InteractionEvents.suppresses(view: view,type: "scroll"))
        XCTAssertTrue(bridge.record(lease,id: "A",generation: 1,eventJson: text)); view.isSecureTextEntry = true; await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,0)
        view.isSecureTextEntry = false
        XCTAssertTrue(bridge.record(lease,id: "A",generation: 1,eventJson: text)); view.removeFromSuperview(); await drain()
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,0)
    }
    func testRecycleInvalidatesSameObjectAndTagWithoutConsumingNextJsGeneration() async {
        let lease = bridge.lease(); XCTAssertTrue(register()); await drain()
        RnInteractionEventRegistration.invalidateView(view)
        XCTAssertFalse(bridge.record(lease,id: "A",generation: 1,eventJson: text))
        XCTAssertFalse(InteractionEvents.suppresses(view: view,type: "text_edit"))
        XCTAssertTrue(register(2)); await drain()
        XCTAssertTrue(InteractionEvents.suppresses(view: view,type: "text_edit"))
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
