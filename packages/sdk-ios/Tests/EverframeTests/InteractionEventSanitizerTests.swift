// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Testing
import EverframeProtocol
@testable import EverframeKit

func interactionEvent(_ type: String, _ fields: [String: Any]) -> [String: Any] {
    fields.merging(["type": type, "source": "app", "observedAt": 1.0]) { _, value in value }
}

struct InteractionEventSanitizerTests {
    @Test func ambiguousPathsAndMalformedEncodingFailClosed() {
        let policy = InteractionEventPolicy.parse(#"{"urlRules":[{"origin":"https://example.com","routes":["/watch/:id"],"queryKeys":["q"]}]}"#)
        for path in ["/watch/a%2Fb", "/watch/a%5cb", "/watch/%2e%2e", "/watch/../help", "/watch/%252f", "/watch/%ZZ", "/watch/%C0%AF", "/help?q=%ZZ"] {
            #expect(InteractionEventSanitizer.sanitize(interactionEvent("deep_link", ["url": "https://example.com" + path, "delivery": "initial"]), policy: policy) == nil)
        }
    }
    @Test func exactValuePermissionAndRedaction() throws {
        let policy = InteractionEventPolicy.parse(#"{"valueTestIds":["search"]}"#)
        let event = interactionEvent("text_edit", ["length": 11, "value": "123-45-6789", "reason": "idle"])
        let hidden = try #require(InteractionEventSanitizer.sanitize(event, policy: policy, liveTestId: "other"))
        #expect(hidden["value"] == nil)
        let allowed = try #require(InteractionEventSanitizer.sanitize(event, policy: policy, liveTestId: "search"))
        #expect(!String(describing: allowed).contains("123-45")); #expect(allowed["value"] != nil)
    }
    @Test func linkDefaultsAndScopedRoutes() throws {
        let defaults = InteractionEventPolicy.parse(nil)
        let raw = interactionEvent("deep_link", ["url": "https://user:password@example.com/private-token?q=secret#secret", "delivery": "initial"])
        #expect(InteractionEventSanitizer.sanitize(raw, policy: defaults)?["url"] as? String == "https://example.com")
        #expect(InteractionEventSanitizer.sanitize(interactionEvent("deep_link", ["url": "not a url", "delivery": "initial"]), policy: defaults) == nil)
        let policy = InteractionEventPolicy.parse(#"{"urlRules":[{"origin":"https://example.com","routes":["/watch/:id"],"queryKeys":["q"]}]}"#)
        let clean = try #require(InteractionEventSanitizer.sanitize(interactionEvent("deep_link", ["url": "https://example.com/watch/private?q=hello&token=secret", "delivery": "subsequent"]), policy: policy))
        #expect(clean["url"] as? String == "https://example.com/watch/:id?q=hello")
        #expect(InteractionEventSanitizer.sanitize(interactionEvent("deep_link", ["url": "https://evil.example/watch/private?q=hello", "delivery": "subsequent"]), policy: policy)?["url"] as? String == "https://evil.example")
    }
    @Test func unicodeAndOptionalEnrichmentBounds() throws {
        let text = try #require(InteractionEventSanitizer.bound(interactionEvent("text_edit", ["length": 600, "value": String(repeating: "😀", count: 300), "reason": "idle"])))
        #expect((text["value"] as? String)?.utf16.count == 256)
        let args = Dictionary(uniqueKeysWithValues: (0...15).map { ("key\($0)", String(repeating: "😀", count: 64)) })
        let launch = try #require(InteractionEventSanitizer.bound(interactionEvent("launch", ["start": "cold", "arguments": args])))
        #expect(launch["arguments"] == nil)
        let link = try #require(InteractionEventSanitizer.bound(interactionEvent("deep_link", ["url": "https://example.com/?q=" + String(repeating: "😀", count: 300), "delivery": "initial"])))
        #expect((link["url"] as? String)?.utf16.count ?? 9999 <= 1024)
        #expect(try JSONSerialization.data(withJSONObject: link).count <= 4096)
    }
    @Test func missingCoreFactsAreRejected() {
        for input in [
            interactionEvent("control_change", ["control": "switch", "position": 1]),
            interactionEvent("permission", ["permission": "camera", "phase": "result"]),
            interactionEvent("scroll", ["axis": "x"]),
            interactionEvent("text_edit", ["length": -1, "reason": "idle"]),
            interactionEvent("text_edit", ["length": true, "reason": "idle"]),
        ] { #expect(InteractionEventSanitizer.sanitize(input, policy: .parse(nil)) == nil) }
    }
    @Test func producerBoundsAfterFinalBufferRedactionLeaveCustomObjectsAlone() throws {
        let buffer = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
        let data = BreadcrumbRingBuffer.coerceHostData(["interaction": interactionEvent("text_edit", ["length": 257, "value": String(repeating: "a", count: 245) + " 123-45-6789", "reason": "idle"])])
        #expect(buffer.addObservedInteraction(kind: .custom, message: "Text edited", data: data, captureRevision: buffer.captureRevision()))
        let stored = try #require(buffer.snapshot().first?.data?["interaction"]?.value as? [String: Any])
        #expect((stored["value"] as? String)?.utf16.count ?? 9999 <= 256)
        buffer.add(kind: .custom, message: "Host custom", data: data)
        let custom = try #require(buffer.snapshot().last?.data?["interaction"]?.value as? [String: Any])
        #expect((custom["value"] as? String)?.utf16.count ?? 0 > 256)
    }
    @Test func allowedKeysAreStillRedacted() throws {
        let policy = InteractionEventPolicy.parse(#"{"launchArgumentKeys":["123-45-6789"],"urlRules":[{"origin":"https://example.com","queryKeys":["123-45-6789"]}]}"#)
        for input in [interactionEvent("launch", ["start": "cold", "arguments": ["123-45-6789": "safe"]]), interactionEvent("deep_link", ["url": "https://example.com?123-45-6789=safe", "delivery": "initial"])] {
            let safe = try #require(InteractionEventSanitizer.sanitize(input, policy: policy))
            #expect(!String(describing: safe).contains("123-45-6789"))
        }
    }
    @Test func reentrantClearDuringRedactionRejectsCapturedRevision() {
        let buffer = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
        let revision = buffer.captureRevision()
        buffer.preLockHook = { buffer.clear() }
        #expect(!buffer.addObservedInteraction(kind: .lifecycle, message: "Launch", data: BreadcrumbRingBuffer.coerceHostData(["interaction": interactionEvent("launch", ["start": "cold"])]), captureRevision: revision))
        #expect(buffer.size == 0)
    }
    @Test func sharedProtocolCorpusSurvivesActualStorage() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("protocol/__tests__/fixtures/interaction-events.v1.json")
        let fixtures = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
        let buffer = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
        for fixture in fixtures {
            let event = try #require(InteractionEventSanitizer.sanitize(fixture, policy: .parse(#"{"launchArgumentKeys":["mode"]}"#)))
            #expect(buffer.addObservedInteraction(kind: InteractionEventSanitizer.kind(try #require(event["type"] as? String)), message: "Observed", data: BreadcrumbRingBuffer.coerceHostData(["interaction": event]), captureRevision: buffer.captureRevision()))
        }
        let stored = try buffer.snapshot().map { try #require($0.data?["interaction"]?.value as? [String: Any]) }
        #expect(stored.count == fixtures.count)
        print("INTERACTION_CORPUS:" + String(decoding: try JSONSerialization.data(withJSONObject: stored, options: [.sortedKeys]), as: UTF8.self))
    }
}
