// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import XCTest
import UIKit
@testable import EverframeKit
@testable import EverframeRN

/// Exercises the public native-child resolution contract used by Fabric's accessibilityElement.
/// Installed Fabric user/controlled-edit coverage also runs in the example host.
@MainActor final class InteractionObserverTests: XCTestCase {
    func testNativeChildOwnsSuppressionAndItsSecureStateRemainsAuthoritative() async {
        Everframe.captureGate = true; BreadcrumbRingBuffer.shared.clear()
        InteractionEventRecorder.shared.configure(.parse(#"{"valueTestIds":["input"]}"#))
        let bridge = RnInteractionEventRegistration()
        let window = UIWindow(frame: CGRect(x:0,y:0,width:400,height:800)), wrapper = UIView(), field = UITextField()
        window.addSubview(wrapper); wrapper.addSubview(field); wrapper.tag = 2
        wrapper.accessibilityIdentifier = "input"; field.accessibilityIdentifier = "input"
        defer {
            bridge.close(); window.isHidden = true; InteractionEventRecorder.shared.configure(.parse(nil))
            BreadcrumbRingBuffer.shared.clear(); Everframe.captureGate = false
        }
        let options = #"{"target":{"name":"Search"},"helperTypes":["text_edit"]}"#
        XCTAssertTrue(bridge.setObserver(2,id:"A",generation:1,lease:bridge.lease(),optionsJson:options,resolve:{ _ in wrapper },host:{ _ in field }))
        try? await Task.sleep(nanoseconds:30_000_000)
        XCTAssertTrue(InteractionEvents.suppresses(view:field,type:"text_edit"))
        XCTAssertFalse(InteractionEvents.suppresses(view:wrapper,type:"text_edit"))
        let lease = bridge.lease()
        XCTAssertTrue(bridge.record(lease,id:"A",generation:1,eventJson:#"{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"#))
        field.isSecureTextEntry = true
        try? await Task.sleep(nanoseconds:30_000_000)
        XCTAssertEqual(BreadcrumbRingBuffer.shared.size,0)
        XCTAssertFalse(InteractionEvents.suppresses(view:field,type:"text_edit"))
    }
}
#endif
