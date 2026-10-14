// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionLaunchAdapterTests {
    @Test func scenesAndProviderRemountNeverManufactureAnotherColdLaunch() {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        adapter.seed(alreadyForeground: false); adapter.launched()
        adapter.foreground(); adapter.foreground(); adapter.seed(alreadyForeground: true)
        #expect(f.buffer.size == 1); #expect(f.events.first?["start"] as? String == "cold")
        #expect(f.events.first?["trigger"] == nil)
        adapter.background(); adapter.foreground(); adapter.foreground()
        #expect(f.buffer.size == 2); #expect(f.events.last?["start"] as? String == "warm")
    }
    @Test func installationAfterLaunchWhileBackgroundedDoesNotInventColdHistory() {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        adapter.seed(alreadyForeground: false); adapter.foreground()
        #expect(f.events.last?["start"] as? String == "warm")
    }
    @Test func installationWhileForegroundedDoesNotInventHistory() {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        adapter.seed(alreadyForeground: true); adapter.foreground(); #expect(f.buffer.size == 0)
        adapter.background(); adapter.foreground(); #expect(f.events.last?["start"] as? String == "warm")
    }
}
#endif
