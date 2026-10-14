// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

final class InteractionControlChange {
    let owner: InteractionOwner, timestamp: TimeInterval
    var completed = false
    init(_ owner: InteractionOwner, _ timestamp: TimeInterval) { self.owner = owner; self.timestamp = timestamp }
}
@MainActor final class InteractionControlAdapter {
    static let shared = InteractionControlAdapter(recorder: .shared)
    private let recorder: InteractionEventRecorder
    private final class Marker { let timestamp: TimeInterval; let state: String; init(_ timestamp: TimeInterval, _ state: String) { self.timestamp = timestamp; self.state = state } }
    private let last = NSMapTable<UIView, Marker>.weakToStrongObjects()
    init(recorder: InteractionEventRecorder) { self.recorder = recorder }
    func begin(_ view: UIView, eventTimestamp: TimeInterval) -> InteractionControlChange? {
        guard state(view) != nil, !recorder.suppresses(view: view, type: "control_change"), let owner = recorder.owner(view: view),
              WindowTapBreadcrumbAdapter.interactionDispatchRevision.map({ $0 == owner.revision }) ?? true else { return nil }
        return InteractionControlChange(owner, eventTimestamp)
    }
    @discardableResult func complete(_ change: InteractionControlChange) -> Bool {
        guard !change.completed else { return false }; change.completed = true
        guard let view = change.owner.host, !recorder.suppresses(view: view, type: "control_change"), let fields = state(view) else { return false }
        let signature = String(describing: fields.sorted { $0.key < $1.key })
        if let previous = last.object(forKey: view), previous.timestamp == change.timestamp, previous.state == signature { return false }
        let accepted = recorder.observe(.init(owner: change.owner, event: nativeInteractionEvent("control_change", fields)))
        if accepted { last.setObject(Marker(change.timestamp, signature), forKey: view) }
        return accepted
    }
    private func state(_ view: UIView) -> [String: Any]? {
        #if !os(tvOS)
        if let control = view as? UISwitch { return ["control": "switch", "checked": control.isOn] }
        if let control = view as? UISlider, control.value.isFinite { return ["control": "slider", "position": Double(control.value)] }
        #endif
        if let control = view as? UISegmentedControl, control.selectedSegmentIndex >= 0 {
            return ["control": "picker", "optionId": "segment:\(control.selectedSegmentIndex)"]
        }
        return nil
    }
}
#endif
