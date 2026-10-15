// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionLaunchAdapterTests {
    @Test func contextOnlyEnrichesPendingNativeLaunch() throws {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        f.recorder.configure(.parse(#"{"launchArgumentKeys":["campaign","url"]}"#))
        adapter.seed(alreadyForeground: false); adapter.launched(); adapter.foreground()
        let lease = try #require(f.recorder.lease())
        let json = #"{"type":"launch_context","source":"app","observedAt":1,"trigger":"notification","arguments":{"campaign":"safe","url":"https://secret/token","secret":"SECRET"}}"#
        #expect(f.buffer.size == 0)
        #expect(f.recorder.prepare(lease: lease, id: "", generation: 0, json: json) != nil)
        f.recorder.flushReadyForFreeze()
        let event = try #require(f.events.first)
        #expect(event["start"] as? String == "cold"); #expect(event["source"] as? String == "native"); #expect(event["trigger"] as? String == "notification")
        #expect((event["arguments"] as? [String: Any])?["campaign"] as? String == "safe")
        #expect(!String(describing: event).contains("SECRET")); #expect(!String(describing: event).contains("secret/token"))
        #expect(f.recorder.prepare(lease: lease, id: "", generation: 0, json: json) == nil); #expect(f.buffer.size == 1)
        adapter.background(); adapter.foreground(); f.buffer.clear()
        #expect(f.recorder.prepare(lease: lease, id: "", generation: 0, json: json) == nil)
        f.recorder.flushReadyForFreeze(); #expect(f.buffer.size == 0)
    }
    @Test func scenesAndProviderRemountNeverManufactureAnotherColdLaunch() {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        adapter.seed(alreadyForeground: false); adapter.launched()
        adapter.foreground(); adapter.foreground(); adapter.seed(alreadyForeground: true)
        f.recorder.flushReadyForFreeze(); #expect(f.buffer.size == 1); #expect(f.events.first?["start"] as? String == "cold")
        #expect(f.events.first?["trigger"] == nil)
        adapter.background(); adapter.foreground(); adapter.foreground()
        f.recorder.flushReadyForFreeze(); #expect(f.buffer.size == 2); #expect(f.events.last?["start"] as? String == "warm")
    }
    @Test func installationAfterLaunchWhileBackgroundedDoesNotInventColdHistory() {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        adapter.seed(alreadyForeground: false); adapter.foreground(); f.recorder.flushReadyForFreeze()
        #expect(f.events.last?["start"] as? String == "warm")
    }
    @Test func installationWhileForegroundedDoesNotInventHistory() {
        let f = InteractionAdapterFixture(), adapter = InteractionLaunchAdapter(recorder: f.recorder)
        adapter.seed(alreadyForeground: true); adapter.foreground(); #expect(f.buffer.size == 0)
        adapter.background(); adapter.foreground(); f.recorder.flushReadyForFreeze(); #expect(f.events.last?["start"] as? String == "warm")
    }
}
#endif
