// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionPreparedPrivacyTests {
    private let events: [[String: Any]] = [
        interactionEvent("text_edit", ["length": 17, "phase": "end"]),
        interactionEvent("control_change", ["control": "checkbox", "checked": true]),
        interactionEvent("control_change", ["control": "slider", "position": 0.75]),
        interactionEvent("control_change", ["control": "picker", "optionId": "PRIVATE-SELECTION"]),
        interactionEvent("scroll", ["axis": "y", "direction": "forward"]),
    ]
    @MainActor private final class Fixture {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let field = UITextField()
        let buffer = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
        lazy var recorder = InteractionEventRecorder(buffer: buffer, clock: { 0 }, schedule: { _, _ in })
        init() {
            window.rootViewController = UIViewController(); window.isHidden = false
            window.rootViewController!.view.addSubview(field)
        }
    }
    @Test func everyHostTypeRequiresPositiveMainThreadPrivacyProofBeforeRetention() async throws {
        for event in events {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: event), as: UTF8.self)
            for mode in ["safe", "secure", "masked"] {
                let f = Fixture(), lease = try #require(f.recorder.lease())
                #expect(f.recorder.register(view: f.field, id: "host", generation: 1, lease: lease,
                    types: [try #require(event["type"] as? String)]))
                if mode == "secure" { f.field.isSecureTextEntry = true }
                if mode == "masked" { SensitiveRectRegistry.mark(f.field) }
                let recorder = f.recorder
                let cell = await Task.detached {
                    recorder.prepare(lease: lease, id: "host", generation: 1, json: json)
                }.value
                #expect(cell == nil, "off-main \(mode): \(json)")
                f.field.isSecureTextEntry = false; f.field.everframe_isSensitive = false
                if let cell { _ = recorder.recordPrepared(cell) }
                #expect(f.buffer.size == 0)
            }
        }
    }
    @Test func mainThreadRejectsUnsafeCaptureAndPreservesSafeNativeHelpers() throws {
        for event in events {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: event), as: UTF8.self)
            for mode in ["secure", "masked", "safe"] {
                let f = Fixture(), lease = try #require(f.recorder.lease())
                #expect(f.recorder.register(view: f.field, id: "host", generation: 1, lease: lease,
                    types: [try #require(event["type"] as? String)]))
                if mode == "secure" { f.field.isSecureTextEntry = true }
                if mode == "masked" { SensitiveRectRegistry.mark(f.field) }
                let cell = f.recorder.prepare(lease: lease, id: "host", generation: 1, json: json)
                if mode == "safe" {
                    #expect(f.recorder.recordPrepared(try #require(cell)))
                    #expect(f.buffer.size == 1)
                    let stored = try #require(f.buffer.snapshot().first?.data?["interaction"]?.value as? [String: Any])
                    #expect(stored["type"] as? String == event["type"] as? String)
                } else {
                    #expect(cell == nil, "main-thread \(mode): \(json)")
                    f.field.isSecureTextEntry = false; f.field.everframe_isSensitive = false
                    if let cell { _ = f.recorder.recordPrepared(cell) }
                    #expect(f.buffer.size == 0)
                }
            }
        }
    }
    @Test func encodedAuthorityNeverEntersPreparedCellsOrStorage() throws {
        for host in ambiguousInteractionHosts {
            let f = Fixture(), lease = try #require(f.recorder.lease())
            let json = String(decoding: try JSONSerialization.data(withJSONObject:
                interactionEvent("deep_link", ["url": "nocturne://" + host, "delivery": "initial"])), as: UTF8.self)
            let cell = f.recorder.prepare(lease: lease, id: "", generation: 0, json: json)
            #expect(cell == nil, "retained authority: \(host)")
            if let cell { _ = f.recorder.recordPrepared(cell) }
            #expect(f.buffer.size == 0, "stored authority: \(host)")
            let stored = f.buffer.snapshot().first?.data?["interaction"]?.value as? [String: Any]
            #expect(stored?["url"] as? String == nil, "stored URL for authority: \(host)")
        }
    }
}
#endif
