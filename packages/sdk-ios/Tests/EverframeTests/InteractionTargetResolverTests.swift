// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Testing
import UIKit
import EverframeProtocol
@testable import EverframeKit

@MainActor @Suite(.serialized)
struct InteractionTargetResolverTests {
    private func withState(_ body: () -> Void) {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        let oldGate = Everframe.captureGate
        Everframe.captureGate = true
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
        InteractionTargetScreenState.reset()
        TapBreadcrumbAdapter.__resetForTesting()
        PressCrumbRateLimiter.__resetForTesting()
        defer {
            Everframe.captureGate = oldGate
            BreadcrumbRingBuffer.shared.clear()
            InteractionTargetScreenState.reset()
        }
        body()
    }
    private func target(_ view: UIView) -> [String: Any] {
        InteractionTargetResolver.resolve(view).data["target"]?.value as? [String: Any] ?? [:]
    }
    @Test func imageTapResolvesPosterOwner() {
        withState {
            let card = UIView(); card.accessibilityTraits = .button
            card.accessibilityIdentifier = "poster-low-orbit"; card.accessibilityLabel = "Low Orbit"
            let image = UIImageView(); card.addSubview(image)
            InteractionTargetScreenState.recordExplicit("Home")
            let result = target(image)
            #expect(result["testId"] as? String == "poster-low-orbit")
            #expect(result["role"] as? String == "button")
            #expect(result["name"] as? String == "Low Orbit")
            #expect(result["screen"] as? String == "Home")
        }
    }
    @Test func sensitiveChildCannotRevealPublicParent() {
        withState {
            let card=UIView(); card.accessibilityTraits = .button
            card.accessibilityIdentifier="SECRET-ID"; card.accessibilityLabel="SECRET-LABEL"
            let image=UIImageView(); card.addSubview(image); SensitiveRectRegistry.mark(image)
            InteractionTargetScreenState.recordExplicit("SECRET-SCREEN")
            let snapshot=InteractionTargetResolver.resolve(image)
            #expect(snapshot.label == "[masked]")
            #expect(snapshot.data["control"] == nil)
            let fields=snapshot.data["target"]?.value as? [String:Any] ?? [:]
            #expect(Set(fields.keys) == Set(["role","masked"]))
            #expect(fields["masked"] as? Bool == true)
            #expect(fields["role"] as? String == "button")
        }
    }
    @Test func sensitivityBeyondAncestorBudgetStillMasks() {
        withState {
            let root=UIView(); SensitiveRectRegistry.mark(root)
            var current=root
            for _ in 0..<40 { let child=UIView(); current.addSubview(child); current=child }
            current.accessibilityLabel="SECRET"
            #expect(target(current)["masked"] as? Bool == true)
        }
    }
    @Test func visibleDescendantTextSkipsPrivateHiddenAndEditableContent() {
        withState {
            let card=UIView(); card.accessibilityTraits = .button
            let hidden=UILabel(); hidden.text="HIDDEN"; hidden.isHidden=true; card.addSubview(hidden)
            let secret=UILabel(); secret.text="SECRET"; SensitiveRectRegistry.mark(secret); card.addSubview(secret)
            let input=UITextField(); input.text="VALUE"; card.addSubview(input)
            let label=UILabel(); label.text="Home"; card.addSubview(label)
            #expect(target(card)["name"] as? String == "Home")
            #expect(target(card)["nameFrom"] as? String == "text")
            #expect(target(input)["name"] as? String != "VALUE")
        }
    }
    @Test func unknownRoleIsAbsentAndTraversalIsBounded() {
        withState {
            #expect(target(UIView())["role"] == nil)
            let card=UIView(); card.accessibilityTraits = .button
            for _ in 0..<64 { card.addSubview(UIView()) }
            let label=UILabel(); label.text="TOO FAR"; card.addSubview(label)
            #expect(target(card)["name"] as? String != "TOO FAR")
        }
    }
    @Test func longNamesDoNotSplitSurrogatePairs() {
        withState {
            let view=UIView(); view.accessibilityLabel=String(repeating:"a",count:255)+"😀"
            #expect(target(view)["name"] as? String == String(repeating:"a",count:255))
        }
    }
    @Test func snapshotSurvivesNavigationAndLabelMutation() {
        withState {
            let view=UIView(); view.accessibilityTraits = .button; view.accessibilityLabel="Low Orbit"
            InteractionTargetScreenState.recordExplicit("Home")
            let snapshot=InteractionTargetResolver.resolve(view)
            view.accessibilityLabel="Next"; InteractionTargetScreenState.recordExplicit("Detail")
            let fields=snapshot.data["target"]?.value as? [String:Any]
            #expect(fields?["screen"] as? String == "Home")
            #expect(fields?["name"] as? String == "Low Orbit")
        }
    }
    @Test func remoteRetainsIdAndMaskedRemoteRemovesIdentity() {
        withState {
            let view=UIView(); view.accessibilityTraits = .button
            view.accessibilityIdentifier="poster-low-orbit"; view.accessibilityLabel="Low Orbit"
            WindowTapBreadcrumbAdapter.recordEndedPress(type:.select, focusedView:view, eventTimestamp:1)
            SensitiveRectRegistry.mark(view)
            WindowTapBreadcrumbAdapter.recordEndedPress(type:.leftArrow, focusedView:view, eventTimestamp:2)
            BreadcrumbRingBuffer.shared.freeze()
            let crumbs=BreadcrumbRingBuffer.shared.takeFrozen() ?? []
            #expect(crumbs.count == 2)
            #expect(crumbs.first?.data?["id"]?.value as? String == "poster-low-orbit")
            #expect(crumbs.last?.data?["id"] == nil)
            #expect(crumbs.last?.data?["control"] == nil)
            #expect(crumbs.last?.message == "press left — [masked]")
        }
    }
    @Test func screenContextSurvivesDisabledNavigationAndResets() {
        withState {
            BreadcrumbRingBuffer.shared.applyConfig(BreadcrumbsConfigWire(enabled:true,kinds:["tap"],maxCount:100,byteBudget:65536,consoleEntryCap:1024))
            Everframe.shared.recordScreen("Home")
            InteractionTargetScreenState.recordNative("Controller")
            #expect(InteractionTargetScreenState.current() == "Home")
            BreadcrumbRingBuffer.shared.freeze()
            #expect((BreadcrumbRingBuffer.shared.takeFrozen() ?? []).isEmpty)
            InteractionTargetScreenState.reset()
            #expect(InteractionTargetScreenState.current() == nil)
        }
    }
    @Test func semanticContainerDoesNotCountMountedChildren() {
        withState {
            let list=UIView(); list.accessibilityLabel="Originals"
            let card=UIView(); card.accessibilityTraits = .button; card.accessibilityLabel="Low Orbit"
            list.addSubview(card); list.addSubview(UIView()); list.addSubview(UIView())
            let dispose=InteractionTargetViewAdapters.register { view in
                view === list ? .init(testId:"originals",role:"list") : nil
            }
            defer { dispose() }
            let fields=target(card)["container"] as? [String:Any]
            #expect(fields?["name"] as? String == "Originals")
            #expect(fields?["count"] == nil)
            #expect(target(card)["name"] as? String == "Low Orbit")
        }
    }
    @Test func snapshotEmissionPreservesSourceAndControlWindowDeduplication() {
        withState {
            let view=UIView(); view.accessibilityTraits = .button; view.accessibilityLabel="Low Orbit"
            InteractionTargetScreenState.recordExplicit("Home")
            let snapshot=InteractionTargetResolver.resolve(view)
            InteractionTargetScreenState.recordExplicit("Detail"); view.accessibilityLabel="Next"
            TapBreadcrumbAdapter.recordTap(sender:view,eventTimestamp:42,snapshot:snapshot)
            WindowTapBreadcrumbAdapter.recordSnapshot(snapshot,eventTimestamp:42)
            BreadcrumbRingBuffer.shared.freeze(); let crumbs=BreadcrumbRingBuffer.shared.takeFrozen() ?? []
            #expect(crumbs.count == 1)
            #expect(crumbs.first?.message == "tap Low Orbit")
            let fields=crumbs.first?.data?["target"]?.value as? [String:Any]
            #expect(fields?["screen"] as? String == "Home")
        }
    }

    @Test func directionalRemoteKeepsFocusFromBeganAndClearsCancelledPresses() {
        withState {
            let window = UIWindow(), first = UIButton(), second = UIButton()
            first.accessibilityLabel = "Origin"; second.accessibilityLabel = "Destination"
            #expect(WindowTapBreadcrumbAdapter.snapshotForPress(type: .rightArrow, phase: .began, focusedView: first, window: window) == nil)
            let snapshot = WindowTapBreadcrumbAdapter.snapshotForPress(type: .rightArrow, phase: .ended, focusedView: second, window: window)
            #expect(snapshot?.label == "Origin")
            _ = WindowTapBreadcrumbAdapter.snapshotForPress(type: .leftArrow, phase: .began, focusedView: first, window: window)
            _ = WindowTapBreadcrumbAdapter.snapshotForPress(type: .leftArrow, phase: .cancelled, focusedView: second, window: window)
            #expect(WindowTapBreadcrumbAdapter.snapshotForPress(type: .leftArrow, phase: .ended, focusedView: second, window: window)?.label == "Destination")
        }
    }
    @Test func frameworkAggregatedLabelsNeverBypassFilteredTraversal() {
        withState {
            let list = AggregateLabelView(), card = AggregateLabelView()
            let secret = UILabel(); secret.text = "SECRET"; SensitiveRectRegistry.mark(secret)
            let publicText = UILabel(); publicText.text = "Public"
            card.addSubview(secret); card.addSubview(publicText); list.addSubview(card)
            let dispose = InteractionTargetViewAdapters.register { view in
                if view === list { return .init(role: "list", name: "") }
                if view === card { return .init(role: "button", name: "") }
                return nil
            }
            defer { dispose(); InteractionTargetRegistry.reset() }
            InteractionTargetRegistry.set(view: card, registrationId: "A", generation: 1, annotation: ["testId": "card"])
            let snapshot = InteractionTargetResolver.resolve(publicText)
            #expect(snapshot.label == "Public")
            #expect(!String(describing: snapshot.data).contains("SECRET"))
            #expect(card.reads == 0); #expect(list.reads == 0)
        }
    }
    @Test(arguments: [false, true]) func selectedFrameworkTextKeepsVisibleName(actionable: Bool) {
        withState {
            let paragraph = RCTParagraphComponentView()
            paragraph.attributedText = NSAttributedString(string: "Read more")
            paragraph.accessibilityLabel = "SECRET inline label"
            paragraph.accessibilityTraits = actionable ? .link : .staticText
            paragraph.accessibilityIdentifier = "article-link"
            let dispose = InteractionTargetViewAdapters.register { view in
                view === paragraph ? .init(name: "", actionable: actionable) : nil
            }
            defer { dispose() }
            let snapshot = InteractionTargetResolver.resolve(paragraph)
            let fields = snapshot.data["target"]?.value as? [String: Any]
            #expect(fields?["name"] as? String == "Read more")
            #expect(fields?["nameFrom"] as? String == "text")
            TapBreadcrumbAdapter.recordTap(sender: paragraph, eventTimestamp: 42, snapshot: snapshot)
            #expect(BreadcrumbRingBuffer.shared.snapshot().last?.message == "tap Read more")
            SensitiveRectRegistry.mark(paragraph)
            #expect(target(paragraph)["masked"] as? Bool == true)
        }
    }

    @Test(arguments: [false, true]) func capturedTargetStaysBoundedAfterRedaction(annotated: Bool) {
        withState {
            let view = UIButton()
            view.setTitle(String(repeating: "123-45-6789;", count: 20), for: .normal)
            if annotated {
                InteractionTargetRegistry.set(view: view, registrationId: "redaction", generation: 1,
                                              annotation: ["name": view.currentTitle!])
            }
            defer { InteractionTargetRegistry.reset() }
            TapBreadcrumbAdapter.recordTap(sender: view, eventTimestamp: 42)
            let stored = BreadcrumbRingBuffer.shared.snapshot().last?.data?["target"]?.value as? [String: Any]
            #expect(stored?["name"] as? String == String(repeating: "[REDACTED:ssn-us];", count: 14) + "[RED")
            #expect(stored?["nameFrom"] as? String == (annotated ? "annotation" : "text"))
        }
    }

    @Test func annotationRoleSelectsPlainPressableAncestor() {
        withState {
            let card = UIView(), image = UIImageView(); card.addSubview(image)
            InteractionTargetRegistry.set(view: card, registrationId: "A", generation: 1, annotation: ["role": "button", "name": "Annotated"])
            defer { InteractionTargetRegistry.reset() }
            #expect(target(image)["name"] as? String == "Annotated")
            SensitiveRectRegistry.mark(image)
            #expect(target(image)["masked"] as? Bool == true)
        }
    }
    @Test func maskedWindowHitDominatesControlDeduplication() {
        withState {
            let control = UIButton(); control.accessibilityIdentifier = "SECRET-ID"; control.accessibilityLabel = "SECRET-LABEL"
            let child = UIView(); control.addSubview(child); SensitiveRectRegistry.mark(child)
            let masked = InteractionTargetResolver.resolve(child)
            WindowTapBreadcrumbAdapter.withDispatchSnapshot(masked, eventTimestamp: 42) {
                TapBreadcrumbAdapter.recordTap(sender: control, eventTimestamp: 42)
            }
            WindowTapBreadcrumbAdapter.recordSnapshot(masked, eventTimestamp: 42)
            BreadcrumbRingBuffer.shared.freeze(); let crumbs = BreadcrumbRingBuffer.shared.takeFrozen() ?? []
            #expect(crumbs.count == 1)
            #expect(crumbs.first?.message == "tap [masked]")
            #expect(!String(describing: crumbs).contains("SECRET"))
        }
    }

}
// Fabric exposes attributedText separately from its potentially aggregated label.
// Core cannot import RN; exercise the same runtime-class boundary as the installed view.
@MainActor private final class RCTParagraphComponentView: UIView {
    @objc var attributedText: NSAttributedString?
    override init(frame: CGRect) { super.init(frame: frame); addSubview(UIView()) }
    required init?(coder: NSCoder) { fatalError("unused") }
}
@MainActor private final class AggregateLabelView: UIView {
    var reads = 0
    override var accessibilityLabel: String? {
        get { reads += 1; return "SECRET Public" }
        set { }
    }
}
#endif
