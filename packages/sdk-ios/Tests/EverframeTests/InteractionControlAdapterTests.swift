// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionControlAdapterTests {
    #if !os(tvOS)
    @Test func deferredSwitchActionUsesTheEndedTouchOwnerOnce() throws {
        let f = InteractionAdapterFixture(), adapter = InteractionControlAdapter(recorder: f.recorder)
        let view = f.attach(UISwitch()), touch = NSObject()
        view.accessibilityIdentifier = "original-toggle"
        adapter.touch(view, id: ObjectIdentifier(touch), phase: .began, timestamp: 1)
        adapter.touch(view, id: ObjectIdentifier(touch), phase: .ended, timestamp: 2)
        view.isOn = true
        // UIKit's switch dispatch is deferred until after CA commit and has no UIEvent.
        let change = try #require(adapter.beginAction(view, event: nil))
        #expect(adapter.complete(change))
        #expect(f.events.last?["checked"] as? Bool == true)
        #expect(adapter.beginAction(view, event: nil) == nil)
    }
    @Test func switchWithoutLiveEndedTouchCannotRecordProgrammaticAction() throws {
        var now = 0.0
        let f = InteractionAdapterFixture(), adapter = InteractionControlAdapter(recorder: f.recorder, clock: { now })
        let view = f.attach(UISwitch()), touch = NSObject(), id = ObjectIdentifier(touch)
        view.isOn = true
        #expect(adapter.beginAction(view, event: nil) == nil)
        for phase in [UITouch.Phase.cancelled, .ended] {
            view.isOn = false
            adapter.touch(view, id: id, phase: .began, timestamp: 1)
            adapter.touch(view, id: id, phase: phase, timestamp: 2)
            view.isOn = true
            if phase == .ended { now += 251 }
            #expect(adapter.beginAction(view, event: nil) == nil)
        }
        view.isOn = false
        adapter.touch(view, id: id, phase: .began, timestamp: 3)
        adapter.touch(view, id: id, phase: .ended, timestamp: 4)
        #expect(adapter.beginAction(view, event: nil) == nil) // unchanged state
        f.buffer.clear(); view.isOn = true
        #expect(adapter.retainedTouches == 0)
        #expect(adapter.beginAction(view, event: nil) == nil)
        #expect(f.buffer.size == 0)
    }
    @Test func deferredSwitchOwnersAreBoundedAndRevokedSynchronously() {
        let f = InteractionAdapterFixture(), adapter = InteractionControlAdapter(recorder: f.recorder)
        let views = (0..<40).map { _ in f.attach(UISwitch()) }
        for view in views { adapter.touch(view, id: ObjectIdentifier(view), phase: .began, timestamp: 1) }
        #expect(adapter.retainedTouches == 32)
        f.recorder.revoke()
        #expect(adapter.retainedTouches == 0)
        for view in views {
            adapter.touch(view, id: ObjectIdentifier(view), phase: .ended, timestamp: 2)
            view.isOn = true
            #expect(adapter.beginAction(view, event: nil) == nil)
        }
    }
    @Test func revocationBetweenTouchCaptureAndRetentionDoesNotRepopulateStore() {
        let f = InteractionAdapterFixture()
        var reads = 0
        let adapter = InteractionControlAdapter(recorder: f.recorder, clock: {
            reads += 1
            if reads == 2 { f.recorder.revoke() }
            return 0
        })
        let view = f.attach(UISwitch())
        adapter.touch(view, id: ObjectIdentifier(view), phase: .began, timestamp: 1)
        #expect(adapter.retainedTouches == 0)
    }
    @Test func finalControlStateAndSourceTargetSurviveAppFocusChange() throws {
        let f = InteractionAdapterFixture(), adapter = InteractionControlAdapter(recorder: f.recorder)
        let view = f.attach(UISwitch()); view.accessibilityIdentifier = "toggle"
        let observation = try #require(adapter.begin(view, eventTimestamp: 1))
        view.isOn = true; f.attach(UITextField()).becomeFirstResponder()
        #expect(adapter.complete(observation)); #expect(f.events.last?["checked"] as? Bool == true)
        #expect(!adapter.complete(observation))
        let stale = try #require(adapter.begin(view, eventTimestamp: 2))
        f.buffer.clear(); view.isOn = false
        #expect(!adapter.complete(stale)); #expect(f.buffer.size == 0)
    }
    @Test func detachAndSensitiveControlsDropPendingState() throws {
        let f = InteractionAdapterFixture(), adapter = InteractionControlAdapter(recorder: f.recorder)
        let view = f.attach(UISwitch())
        let detached = try #require(adapter.begin(view, eventTimestamp: 1)); view.removeFromSuperview()
        #expect(!adapter.complete(detached))
        f.attach(view); let masked = try #require(adapter.begin(view, eventTimestamp: 2)); SensitiveRectRegistry.mark(view)
        #expect(!adapter.complete(masked)); #expect(f.buffer.size == 0)
    }
    #endif
    @Test func opaqueControlsRequireHelpers() {
        let f = InteractionAdapterFixture(), adapter = InteractionControlAdapter(recorder: f.recorder)
        #expect(adapter.begin(f.attach(UIButton()), eventTimestamp: 1) == nil)
    }
}
#endif
