// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import XCTest
import UIKit
@testable import EverframeKit
#if canImport(EverframeRN)
@testable import EverframeRN
#endif

@MainActor final class RnInteractionTargetRegistrationTests: XCTestCase {
    func testRefBeforeNativeMountResolvesWhenViewAppears() async throws {
        InteractionTargetRegistry.reset()
        let registration = RnInteractionTargetRegistration()
        defer { registration.close(); InteractionTargetRegistry.reset() }
        var mounted: UIView?
        XCTAssertTrue(registration.setTarget(1, registrationId: "A", generation: 1, annotation: ["name":"Current"], resolve: { _ in mounted }))
        try await Task.sleep(nanoseconds: 30_000_000)
        let window = UIWindow(), view = UIView(); window.addSubview(view); mounted = view
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(InteractionTargetRegistry.lookup(view)?["name"] as? String, "Current")
        XCTAssertTrue(registration.clearTarget("A", generation: 2))
        XCTAssertNil(InteractionTargetRegistry.lookup(view))
    }
    func testClearBeforeMountNeverResurrects() async throws {
        InteractionTargetRegistry.reset()
        let registration = RnInteractionTargetRegistration()
        defer { registration.close(); InteractionTargetRegistry.reset() }
        var mounted: UIView?
        XCTAssertTrue(registration.setTarget(1, registrationId: "A", generation: 1, annotation: ["name":"Stale"], resolve: { _ in mounted }))
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(registration.clearTarget("A", generation: 2))
        let window = UIWindow(), view = UIView(); window.addSubview(view); mounted = view
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertNil(InteractionTargetRegistry.lookup(view))
    }
    func testAdapterReadsExplicitLabelAndCanonicalSliderRole() async throws {
        let registration = RnInteractionTargetRegistration()
        defer { registration.close() }
        registration.installAdapter { _ in ["role":"adjustable", "name":"Explicit", "actionable":true] }
        try await Task.sleep(nanoseconds: 30_000_000)
        let fields = InteractionTargetViewAdapters.describe(UIView())
        XCTAssertEqual(fields?.role, "slider")
        XCTAssertEqual(fields?.name, "Explicit")
        XCTAssertEqual(fields?.actionable, true)
    }
}
#endif
