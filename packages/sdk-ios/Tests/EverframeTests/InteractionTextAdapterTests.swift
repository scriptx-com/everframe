// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor final class InteractionAdapterFixture {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
    let buffer = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
    var now = 0.0
    lazy var recorder = InteractionEventRecorder(buffer: buffer, clock: { [unowned self] in now }, schedule: { _, _ in })
    init() { window.rootViewController = UIViewController(); window.makeKeyAndVisible() }
    func attach<T: UIView>(_ view: T) -> T { window.rootViewController!.view.addSubview(view); return view }
    var events: [[String: Any]] { buffer.snapshot().compactMap { $0.data?["interaction"]?.value as? [String: Any] } }
}

@MainActor @Suite(.serialized) struct InteractionTextAdapterTests {
    @Test func notificationsCaptureUserEditsWithoutCapturingProgrammaticValues() throws {
        let f = InteractionAdapterFixture(), adapter = InteractionTextAdapter(recorder: f.recorder)
        adapter.install(); defer { adapter.close() }
        let field = f.attach(UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40)))
        field.becomeFirstResponder(); field.text = "programmatic"
        f.now = 1000; f.recorder.flushDue(); #expect(f.buffer.size == 0)
        field.text = "pasted text"
        NotificationCenter.default.post(name: UITextField.textDidChangeNotification, object: field)
        f.now = 1749; f.recorder.flushDue(); #expect(f.buffer.size == 0)
        f.now = 1750; f.recorder.flushDue(); #expect(interactionNumber(f.events.first?["length"]) == 11)
        #expect(!String(describing: f.events).contains("pasted"))
        f.now = 3000; field.text = "ended"
        NotificationCenter.default.post(name: UITextField.textDidChangeNotification, object: field)
        NotificationCenter.default.post(name: UITextField.textDidEndEditingNotification, object: field)
        #expect(f.events.last?["reason"] as? String == "end")
    }
    @Test func multilineCompositionSecureAndMaskedFields() {
        let f = InteractionAdapterFixture(), adapter = InteractionTextAdapter(recorder: f.recorder)
        let view = f.attach(UITextView(frame: CGRect(x: 0, y: 0, width: 200, height: 100)))
        view.becomeFirstResponder(); view.setMarkedText("SECRET", selectedRange: NSRange(location: 6, length: 0))
        adapter.changed(view); f.now = 1000; f.recorder.flushReadyForFreeze(); #expect(f.buffer.size == 0)
        view.unmarkText(); view.text = "line\nline"; adapter.changed(view); adapter.ended(view, submit: true)
        #expect(f.events.last?["reason"] as? String == "submit")
        f.buffer.clear(); view.isSecureTextEntry = true; adapter.changed(view); adapter.ended(view); #expect(f.buffer.size == 0)
        view.isSecureTextEntry = false; SensitiveRectRegistry.mark(view); adapter.changed(view); adapter.ended(view); #expect(f.buffer.size == 0)
    }
}
#endif
