// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

@MainActor final class InteractionTextAdapter {
    static let shared = InteractionTextAdapter(recorder: .shared)
    private let recorder: InteractionEventRecorder
    private var observers: [NSObjectProtocol] = []
    init(recorder: InteractionEventRecorder) { self.recorder = recorder }
    func install() {
        guard observers.isEmpty else { return }
        for name in [UITextField.textDidChangeNotification, UITextView.textDidChangeNotification, UITextField.textDidEndEditingNotification, UITextView.textDidEndEditingNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                guard Thread.isMainThread, let view = note.object as? UIView else { return }
                MainActor.assumeIsolated {
                    if name == UITextField.textDidChangeNotification || name == UITextView.textDidChangeNotification { self?.changed(view) }
                    else { self?.ended(view) }
                }
            })
        }
    }
    func close() { observers.forEach(NotificationCenter.default.removeObserver); observers.removeAll() }
    func changed(_ view: UIView) {
        guard view.isFirstResponder, !recorder.suppresses(view: view, type: "text_edit"), let owner = recorder.owner(view: view),
              WindowTapBreadcrumbAdapter.interactionDispatchRevision.map({ $0 == owner.revision }) ?? true else { return }
        let text: String, composing: Bool
        if let field = view as? UITextField { text = field.text ?? ""; composing = field.markedTextRange != nil }
        else if let field = view as? UITextView { text = field.text ?? ""; composing = field.markedTextRange != nil }
        else { return }
        var fields: [String: Any] = ["length": text.utf16.count]
        if !composing, recorder.allowsValue(owner, type: "text_edit") { fields["value"] = text }
        _ = recorder.observe(.init(owner: owner, event: nativeInteractionEvent("text_edit", fields), composing: composing, nativeTextEdit: true))
    }
    func ended(_ view: UIView, submit: Bool = false) {
        guard !recorder.suppresses(view: view, type: "text_edit") else { return }
        recorder.complete(host: view, type: "text_edit", reason: submit ? "submit" : "end")
    }
}

func nativeInteractionEvent(_ type: String, _ fields: [String: Any]) -> [String: Any] {
    fields.merging(["type": type, "source": "native", "observedAt": Date().timeIntervalSince1970 * 1000]) { _, value in value }
}
#endif
