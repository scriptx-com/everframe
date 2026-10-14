// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Testing
import UIKit
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionTargetRegistryTests {
    private func run(_ body: () -> Void) {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        InteractionTargetRegistry.reset()
        defer { InteractionTargetRegistry.reset() }
        body()
    }
    private func fields(_ view: UIView) -> [String: Any] { InteractionTargetRegistry.lookup(view) ?? [:] }
    @Test func oldClearCannotRemoveNewOwner() { run {
        let view=UIView()
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name":"A"])
        InteractionTargetRegistry.set(view: view, registrationId: "B", generation: 2, annotation: ["name":"B"])
        InteractionTargetRegistry.clear(registrationId: "A", generation: 3)
        #expect(fields(view)["name"] as? String == "B")
    } }
    @Test func olderGenerationAndPendingWorkCannotResurrect() { run {
        let view=UIView()
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 2, annotation: ["name":"Current"])
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name":"Stale"])
        #expect(fields(view)["name"] as? String == "Current")
        #expect(InteractionTargetRegistry.beginSet(registrationId: "A", generation: 3))
        #expect(fields(view).isEmpty)
        InteractionTargetRegistry.clear(registrationId: "A", generation: 4)
        InteractionTargetRegistry.completeSet(view: view, registrationId: "A", generation: 3, annotation: ["name":"Stale"])
        #expect(fields(view).isEmpty)
        #expect(InteractionTargetRegistry.beginSet(registrationId: "B", generation: 1))
        InteractionTargetRegistry.reset()
        InteractionTargetRegistry.completeSet(view: view, registrationId: "B", generation: 1, annotation: ["name":"Stale"])
        #expect(fields(view).isEmpty)
    } }
    @Test func weakViewAndNumericTagReuse() { run {
        weak var old: UIView?
        do { let view=UIView(); old=view; view.tag=12
            InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name":"Old"])
        }
        #expect(old == nil)
        let replacement=UIView(); replacement.tag=12
        #expect(fields(replacement).isEmpty)
    } }
    @Test func identityMutationAndRecycleInvalidate() { run {
        let parent=UIView(), view=UIView(); parent.addSubview(view)
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name":"Old"])
        view.accessibilityIdentifier="new-item"
        #expect(fields(view).isEmpty)
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 2, annotation: ["name":"Current"])
        InteractionTargetRegistry.invalidate(view: view)
        #expect(fields(view).isEmpty)
    } }
    @Test func containerReplacementAndInvalidFieldNormalization() { run {
        let view=UIButton(); view.accessibilityIdentifier="auto"
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name":"Title", "screen":"FORBIDDEN", "container":["name":"Continue", "index":1,"count":3]])
        let target=InteractionTargetResolver.resolve(view).data["target"]?.value as? [String:Any]
        #expect(target?["nameFrom"] as? String == "annotation")
        #expect(target?["screen"] as? String != "FORBIDDEN")
        #expect((target?["container"] as? [String:Any])?["count"] as? Int64 == 3)
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 2, annotation: ["container":["name":"New", "index":4,"count":2]])
        let container=fields(view)["container"] as? [String:Any]
        #expect(container?["index"] == nil); #expect(container?["count"] == nil)
    } }
    @Test func maskedTargetNeverReadsAnnotations() { run {
        let view=UIButton(); SensitiveRectRegistry.mark(view)
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name":"SECRET", "testId":"SECRET", "container":["name":"SECRET"]])
        let snapshot=InteractionTargetResolver.resolve(view)
        #expect(snapshot.label == "[masked]")
        #expect(!String(describing:snapshot.data).contains("SECRET"))
    } }
    @Test func clippingAndSiblingReorderPreserveLiveOwnership() { run {
        let root = UIView(), view = UIView(), sibling = UIView(); root.addSubview(view)
        InteractionTargetRegistry.set(view: view, registrationId: "A", generation: 1, annotation: ["name": "Current"])
        root.insertSubview(sibling, at: 0)
        #expect(fields(view)["name"] as? String == "Current")
        view.removeFromSuperview(); root.addSubview(view)
        #expect(fields(view)["name"] as? String == "Current")
        InteractionTargetRegistry.invalidate(view: view)
        #expect(fields(view).isEmpty)
    } }

}
#endif
