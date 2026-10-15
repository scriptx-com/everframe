// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import EverframeProtocol

public struct InteractionTargetViewHints {
    public let testId: String?
    public let role: String?
    /// Explicit framework label. Empty means known absent; nil permits UIKit fallback.
    /// Frameworks with synthesized aggregate labels must supply an empty string.
    public let name: String?
    public let actionable: Bool
    public init(testId: String? = nil, role: String? = nil, name: String? = nil, actionable: Bool = false) {
        self.testId = testId; self.role = role; self.name = name; self.actionable = actionable
    }
}

/// SDK-support seam: the RN bridge supplies framework metadata without a core RN dependency.
@MainActor public enum InteractionTargetViewAdapters {
    private static var adapter: ((UIView) -> InteractionTargetViewHints?)?
    private static var owner: UUID?
    public static func register(_ read: @escaping (UIView) -> InteractionTargetViewHints?) -> () -> Void {
        let token = UUID(); owner = token; adapter = read
        return { if owner == token { adapter = nil; owner = nil } }
    }
    static func describe(_ view: UIView) -> InteractionTargetViewHints? { adapter?(view) }
}

/// Framework support adapters provide provenance only, without reading target labels.
@MainActor public enum InteractionOriginViewAdapters {
    private static var adapter: ((UIView) -> Bool)?
    private static var owner: UUID?
    public static func register(_ read: @escaping (UIView) -> Bool) -> () -> Void {
        let token = UUID(); owner = token; adapter = read
        return { if owner == token { adapter = nil; owner = nil } }
    }
    static func isDevtools(_ view: UIView) -> Bool { adapter?(view) == true }
}

struct InteractionTargetSnapshot {
    let label: String
    let data: [String: EverframeJSONAny]
    let captureRevision: UInt64
    init(label: String, data: [String: EverframeJSONAny], captureRevision: UInt64 = BreadcrumbRingBuffer.shared.captureRevision()) {
        self.label = label; self.data = data; self.captureRevision = captureRevision
    }
}

@MainActor enum InteractionTargetResolver {
    private static let actions: Set<String> = ["button", "link", "tab", "switch", "checkbox", "radio", "textfield", "slider"]
    static func resolve(_ view: UIView) -> InteractionTargetSnapshot {
        let revision = BreadcrumbRingBuffer.shared.captureRevision()
        let attribution = attribution(view)
        let selected = owner(view, useHints: !sensitiveAncestry(view))
        let snapshot = sensitiveAncestry(view) || sensitiveAncestry(selected)
            ? masked(role: nativeRole(selected), captureRevision: revision)
            : describe(selected, captureRevision: revision)
        return .init(label: snapshot.label, data: snapshot.data.merging(BreadcrumbRingBuffer.coerceHostData(attribution)) { _, value in value }, captureRevision: revision)
    }

    /// Only native identity and explicit bound annotations establish origin.
    private static func attribution(_ view: UIView) -> [String: Any] {
        var current: UIResponder? = view
        var seen = Set<ObjectIdentifier>()
        var reporter: String?
        while let candidate = current, seen.insert(ObjectIdentifier(candidate)).inserted {
            let name = NSStringFromClass(type(of: candidate))
            if ["RCTLogBoxView", "RCTRedBox", "EXDevMenu.DevMenuWindow", "EXDevMenu.DevMenuViewController",
                "expo_dev_menu.DevMenuWindow", "expo_dev_menu.DevMenuViewController",
                "EXDevLauncher.DevLauncherViewController", "expo_dev_launcher.DevLauncherViewController"].contains(name) {
                return ["origin": "devtools"]
            }
            if let host = candidate as? UIView {
                if InteractionOriginViewAdapters.isDevtools(host) { return ["origin": "devtools"] }
                let annotation = InteractionTargetRegistry.lookup(host)
                if interactionBool(annotation?["devtoolsOrigin"]) == true { return ["origin": "devtools"] }
                if reporter == nil { reporter = annotation?["reporterTrigger"] as? String }
            }
            current = candidate.next
        }
        if let reporter { return ["origin": "reporter", "trigger": reporter] }
        return [:]
    }

    static func sensitiveAncestry(_ view: UIView) -> Bool {
        var current: UIView? = view
        while let candidate = current {
            if SensitiveRectRegistry.isSensitive(candidate) { return true }
            current = candidate.superview
        }
        return false
    }

    private static func masked(role: String?, captureRevision: UInt64) -> InteractionTargetSnapshot {
        var target: [String: Any] = ["masked": true]
        if let role { target["role"] = role }
        return .init(label: "[masked]", data: BreadcrumbRingBuffer.coerceHostData(["masked": true, "target": target]), captureRevision: captureRevision)
    }

    private static func owner(_ view: UIView, useHints: Bool = true) -> UIView {
        var current: UIView? = view
        var semantic: UIView?
        for _ in 0..<32 {
            guard let candidate = current else { break }
            let hints = useHints ? InteractionTargetViewAdapters.describe(candidate) : nil
            let role = (useHints ? InteractionTargetRegistry.lookup(candidate)?["role"] as? String : nil) ?? hints?.role ?? nativeRole(candidate)
            if candidate is UIControl || hints?.actionable == true || role.map({ actions.contains($0) }) == true { return candidate }
            if semantic == nil && (role != nil || (useHints && (hints?.testId != nil || (hints?.name ?? candidate.accessibilityLabel)?.isEmpty == false))) { semantic = candidate }
            current = candidate.superview
        }
        return semantic ?? view
    }

    private static func describe(_ view: UIView, captureRevision: UInt64) -> InteractionTargetSnapshot {
        let hints = InteractionTargetViewAdapters.describe(view)
        let role = interactionTargetText(hints?.role, max: 64) ?? nativeRole(view)
        let id = interactionTargetText(hints?.testId) ?? interactionTargetText(view.accessibilityIdentifier)
        let accessibility = interactionTargetText(hints?.name ?? view.accessibilityLabel)
        let directText = visibleText(view)
        let text = directText ?? ((accessibility == nil) ? descendantText(view) : nil)
        let name = accessibility ?? text ?? id ?? interactionTargetText(String(describing: type(of: view))) ?? "view"
        let source = accessibility != nil ? "accessibility" : text != nil ? "text" : id != nil ? "testId" : "className"
        var target: [String: Any] = ["name": name, "nameFrom": source]
        if let role { target["role"] = role }
        if let id { target["testId"] = id }
        if let container = container(view) { target["container"] = container }
        if let screen = InteractionTargetScreenState.current() { target["screen"] = screen }
        if let annotation = InteractionTargetRegistry.lookup(view) {
            target.merge(annotation.filter { !["reporterTrigger", "devtoolsOrigin"].contains($0.key) }) { _, value in value }
            if annotation["name"] != nil { target["nameFrom"] = "annotation" }
            else if source == "testId", let override = annotation["testId"] { target["name"] = override }
        }
        let resolvedName = target["name"] as? String ?? name
        var data: [String: Any] = ["control": String(describing: type(of: view)), "target": target]
        if let id = target["testId"] { data["id"] = id }
        return .init(label: interactionTargetText(resolvedName, max: 48) ?? "view", data: BreadcrumbRingBuffer.coerceHostData(data), captureRevision: captureRevision)
    }

    /// Read the selected text host as well as descendant text hosts. Fabric's
    /// accessibilityLabel can aggregate inline views, so use its own attributedText.
    private static func visibleText(_ view: UIView) -> String? {
        guard !view.isHidden, view.alpha > 0, !SensitiveRectRegistry.isSensitive(view), !(view is UITextInput) else { return nil }
        if let button = view as? UIButton { return interactionTargetText(button.currentTitle) }
        if let label = view as? UILabel { return interactionTargetText(label.text) }
        let className = String(describing: type(of: view))
        if className == "RCTParagraphComponentView" {
            // RN's public introspection property, guarded without a core RN dependency.
            guard view.responds(to: NSSelectorFromString("attributedText")),
                  let text = view.value(forKey: "attributedText") as? NSAttributedString else { return nil }
            return interactionTargetText(text.string)
        }
        if className == "RCTTextView" { return interactionTargetText(view.accessibilityLabel) }
        return nil
    }

    static func descendantText(_ view: UIView, maxDepth: Int = 6) -> String? {
        var visits = 0
        func walk(_ node: UIView, depth: Int) -> String? {
            guard depth <= maxDepth, visits < 64 else { return nil }
            visits += 1
            guard !node.isHidden, node.alpha > 0, !SensitiveRectRegistry.isSensitive(node), !(node is UITextInput) else { return nil }
            if let text = visibleText(node) { return text }
            for child in node.subviews {
                if visits >= 64 { break }
                if let text = walk(child, depth: depth + 1) { return text }
            }
            return nil
        }
        for child in view.subviews {
            if visits >= 64 { break }
            if let text = walk(child, depth: 1) { return text }
        }
        return nil
    }

    private static func container(_ view: UIView) -> [String: Any]? {
        var current = view.superview
        var tableCell: UITableViewCell?
        var collectionCell: UICollectionViewCell?
        for _ in 0..<32 {
            guard let candidate = current else { break }
            if let cell = candidate as? UITableViewCell { tableCell = cell }
            if let cell = candidate as? UICollectionViewCell { collectionCell = cell }
            let hints = InteractionTargetViewAdapters.describe(candidate)
            let role = hints?.role ?? nativeRole(candidate)
            if let role, ["list", "grid", "tablist"].contains(role) {
                var fields: [String: Any] = ["role": role]
                if let id = interactionTargetText(hints?.testId) ?? interactionTargetText(candidate.accessibilityIdentifier) { fields["testId"] = id }
                if let name = interactionTargetText(hints?.name ?? candidate.accessibilityLabel) { fields["name"] = name }
                // Multi-section indices are ambiguous without explicit annotations.
                if let table = candidate as? UITableView, table.numberOfSections == 1 {
                    fields["count"] = table.numberOfRows(inSection: 0)
                    if let tableCell, let path = table.indexPath(for: tableCell) { fields["index"] = path.row }
                } else if let collection = candidate as? UICollectionView, collection.numberOfSections == 1 {
                    fields["count"] = collection.numberOfItems(inSection: 0)
                    if let collectionCell, let path = collection.indexPath(for: collectionCell) { fields["index"] = path.item }
                }
                return fields
            }
            current = candidate.superview
        }
        return nil
    }

    static func nativeRole(_ view: UIView) -> String? {
        if view is UITextInput { return "textfield" }
        #if os(iOS)
        if view is UISwitch { return "switch" }
        if view is UISlider { return "slider" }
        #endif
        if view is UITableView { return "list" }
        if view is UICollectionView { return "grid" }
        if view is UITabBar { return "tablist" }
        if view.accessibilityTraits.contains(.link) { return "link" }
        if view.accessibilityTraits.contains(.button) || view is UIButton { return "button" }
        if view.accessibilityTraits.contains(.header) { return "header" }
        if view.accessibilityTraits.contains(.adjustable) { return "slider" }
        if view is UIImageView || view.accessibilityTraits.contains(.image) { return "image" }
        if view is UILabel || view.accessibilityTraits.contains(.staticText) { return "text" }
        return nil
    }
}
#endif
