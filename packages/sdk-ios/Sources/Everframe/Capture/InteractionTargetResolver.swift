// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import EverframeProtocol

public struct InteractionTargetViewHints {
    public let testId: String?
    public let role: String?
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

struct InteractionTargetSnapshot {
    let label: String
    let data: [String: EverframeJSONAny]
}

@MainActor enum InteractionTargetResolver {
    private static let actions: Set<String> = ["button", "link", "tab", "switch", "checkbox", "radio", "textfield", "slider"]
    static func resolve(_ view: UIView) -> InteractionTargetSnapshot {
        if sensitiveAncestry(view) { return masked(role: nativeRole(owner(view, useHints: false))) }
        let selected = owner(view)
        if sensitiveAncestry(selected) { return masked(role: nativeRole(selected)) }
        return describe(selected)
    }

    static func sensitiveAncestry(_ view: UIView) -> Bool {
        var current: UIView? = view
        while let candidate = current {
            if SensitiveRectRegistry.isSensitive(candidate) { return true }
            current = candidate.superview
        }
        return false
    }

    private static func masked(role: String?) -> InteractionTargetSnapshot {
        var target: [String: Any] = ["masked": true]
        if let role { target["role"] = role }
        return .init(label: "[masked]", data: BreadcrumbRingBuffer.coerceHostData(["masked": true, "target": target]))
    }

    private static func owner(_ view: UIView, useHints: Bool = true) -> UIView {
        var current: UIView? = view
        var semantic: UIView?
        for _ in 0..<32 {
            guard let candidate = current else { break }
            let hints = useHints ? InteractionTargetViewAdapters.describe(candidate) : nil
            let role = hints?.role ?? nativeRole(candidate)
            if candidate is UIControl || hints?.actionable == true || role.map({ actions.contains($0) }) == true { return candidate }
            if semantic == nil && (role != nil || (useHints && (hints?.testId != nil || candidate.accessibilityLabel?.isEmpty == false))) { semantic = candidate }
            current = candidate.superview
        }
        return semantic ?? view
    }

    private static func describe(_ view: UIView) -> InteractionTargetSnapshot {
        let hints = InteractionTargetViewAdapters.describe(view)
        let role = interactionTargetText(hints?.role, max: 64) ?? nativeRole(view)
        let id = interactionTargetText(hints?.testId) ?? interactionTargetText(view.accessibilityIdentifier)
        let accessibility = interactionTargetText(hints?.name) ?? interactionTargetText(view.accessibilityLabel)
        let directText = interactionTargetText((view as? UIButton)?.currentTitle) ?? interactionTargetText((view as? UILabel)?.text)
        let text = directText ?? ((accessibility == nil) ? descendantText(view) : nil)
        let name = accessibility ?? text ?? id ?? interactionTargetText(String(describing: type(of: view))) ?? "view"
        let source = accessibility != nil ? "accessibility" : text != nil ? "text" : id != nil ? "testId" : "className"
        var target: [String: Any] = ["name": name, "nameFrom": source]
        if let role { target["role"] = role }
        if let id { target["testId"] = id }
        if let container = container(view) { target["container"] = container }
        if let screen = InteractionTargetScreenState.current() { target["screen"] = screen }
        if let annotation = InteractionTargetRegistry.lookup(view) {
            target.merge(annotation) { _, value in value }
            if annotation["name"] != nil { target["nameFrom"] = "annotation" }
            else if source == "testId", let override = annotation["testId"] { target["name"] = override }
        }
        let resolvedName = target["name"] as? String ?? name
        var data: [String: Any] = ["control": String(describing: type(of: view)), "target": target]
        if let id = target["testId"] { data["id"] = id }
        return .init(label: interactionTargetText(resolvedName, max: 48) ?? "view", data: BreadcrumbRingBuffer.coerceHostData(data))
    }

    static func descendantText(_ view: UIView, maxDepth: Int = 6) -> String? {
        var visits = 0
        func walk(_ node: UIView, depth: Int) -> String? {
            guard depth <= maxDepth, visits < 64 else { return nil }
            visits += 1
            guard !node.isHidden, node.alpha > 0, !SensitiveRectRegistry.isSensitive(node), !(node is UITextInput) else { return nil }
            if let label = node as? UILabel, let text = interactionTargetText(label.text) { return text }
            if ["RCTParagraphComponentView", "RCTTextView"].contains(String(describing: type(of: node))),
               let text = interactionTargetText(node.accessibilityLabel) { return text }
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
                if let name = interactionTargetText(candidate.accessibilityLabel) { fields["name"] = name }
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
