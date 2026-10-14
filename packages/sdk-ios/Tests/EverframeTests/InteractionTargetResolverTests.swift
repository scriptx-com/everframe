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
}
#endif
