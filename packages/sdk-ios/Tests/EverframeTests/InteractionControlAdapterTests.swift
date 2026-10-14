// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionControlAdapterTests {
    #if !os(tvOS)
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
