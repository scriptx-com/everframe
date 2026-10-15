// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import XCTest
import UIKit
@testable import EverframeKit
@testable import EverframeRN

/// Exercises public native-child resolution and the native action observation boundary.
@MainActor final class InteractionObserverTests: XCTestCase {
    func testAllLegacyDeclarationsPreserveNativeControlObservationAndChildMetadata() async throws {
        Everframe.captureGate = true; BreadcrumbRingBuffer.shared.applyConfig(nil); BreadcrumbRingBuffer.shared.clear()
        let bridge = RnInteractionEventRegistration()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let wrapper = UIView(), control = UISegmentedControl(items: ["First", "Second"])
        window.rootViewController = UIViewController(); window.makeKeyAndVisible()
        window.rootViewController!.view.addSubview(wrapper); wrapper.addSubview(control); wrapper.tag = 2
        control.selectedSegmentIndex = 0
        defer {
            bridge.close(); window.isHidden = true
            BreadcrumbRingBuffer.shared.clear(); Everframe.captureGate = false
        }
        let options = #"{"target":{"name":"Native choice"},"helperTypes":["text_edit","control_change","scroll"]}"#
        XCTAssertTrue(bridge.setObserver(2, id: "A", generation: 1, lease: bridge.lease(), optionsJson: options, resolve: { _ in wrapper }, host: { _ in control }))
        try? await Task.sleep(nanoseconds: 30_000_000)
        for type in ["text_edit", "control_change", "scroll"] {
            XCTAssertFalse(InteractionEvents.suppresses(view: control, type: type))
        }
        XCTAssertEqual(InteractionEventRecorder.shared.owner(view: control)?.target?["name"] as? String, "Native choice")
        XCTAssertNotEqual(InteractionEventRecorder.shared.owner(view: wrapper)?.target?["name"] as? String, "Native choice")
        let adapter = InteractionControlAdapter(recorder: .shared)
        // begin/complete model the existing recognized UIKit action hook boundary.
        let change = try XCTUnwrap(adapter.begin(control, eventTimestamp: 1))
        control.selectedSegmentIndex = 1
        XCTAssertTrue(adapter.complete(change))
        let native = try XCTUnwrap(BreadcrumbRingBuffer.shared.snapshot().first)
        let event = try XCTUnwrap(native.data?["interaction"]?.value as? [String: Any])
        XCTAssertEqual(event["source"] as? String, "native")
        XCTAssertEqual(event["type"] as? String, "control_change")
        XCTAssertEqual(event["optionId"] as? String, "segment:1")
        XCTAssertEqual((native.data?["target"]?.value as? [String: Any])?["name"] as? String, "Native choice")
        SensitiveRectRegistry.mark(control)
        XCTAssertNil(adapter.begin(control, eventTimestamp: 2))
        control.everframe_isSensitive = false
        RnInteractionEventRegistration.invalidateView(wrapper)
        XCTAssertNotEqual(InteractionEventRecorder.shared.owner(view: control)?.target?["name"] as? String, "Native choice")
    }
}
#endif
