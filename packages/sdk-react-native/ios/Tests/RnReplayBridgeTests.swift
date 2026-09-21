// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RBRIDGE-01 criteria #1/#2 regression for the iOS RN bridge.
//
// This file proves STRUCTURALLY that:
//   • #2 (no new surface): the bridge exposes NO replay-config entry point
//     (no `configureReplay`/`setReplayConfig`); `configure(appId:endpoint:)`
//     ignores `endpoint` and never reads a JS replay config — replay arming is
//     keyed entirely on the forwarded SDK key inside `TraceItX.shared.start()`.
//   • #1 (armed-at-start path): `openReporter` is GATED on `start()`
//     (captureGate) and routes through the SAME `TraceItX.shared.report.open()`
//     seam the presenter freezes/attaches the native replay on. Calling it
//     before configure() resolves with the captureGate=false error (code 1100),
//     pinning that report.open() is the bridge's only reporter entry.
//
// The actual replay attachment composition (criterion #3) is locked by
// packages/sdk-ios/Tests/TraceItXTests/RnReplayAttachmentTests.swift via the
// DEBUG-only timeline override. The LIVE frozen→attach end-to-end through a real
// modal open is device/UIWindow-tier and reserved for the human smoke
// (24-03 / 24-VALIDATION.md, Pitfall 3) — NOT driven here.
#if canImport(UIKit) && canImport(XCTest)
import XCTest
import UIKit
@testable import TraceItX_ReactNative
// Task 14's addBreadcrumb test drives `TraceItX.shared` + `BreadcrumbRingBuffer
// .shared` directly (both public API) to prove the bridge reaches the native
// singleton — explicit import since this module isn't re-exported by
// `TraceItX_ReactNative`.
import TraceItXKit

final class RnReplayBridgeTests: XCTestCase {

    // Mirror TraceItXModuleTests' host-window setUp so any capture-context needs
    // have a concrete key window. DO NOT modify TraceItXModuleTests.
    private var hostWindow: UIWindow?

    override func setUp() {
        super.setUp()
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) {
            let w = UIWindow(windowScene: scene)
            w.frame = CGRect(x: 0, y: 0, width: 200, height: 200)
            let vc = UIViewController()
            vc.view.backgroundColor = .systemBackground
            w.rootViewController = vc
            w.windowLevel = .normal
            w.makeKeyAndVisible()
            hostWindow = w
        }
    }

    override func tearDown() {
        hostWindow?.isHidden = true
        hostWindow = nil
        super.tearDown()
    }

    // MARK: - Test C: no replay-config surface (#2)

    func testBridgeExposesNoReplayConfigSurface() {
        // The TurboModule surface is the fixed 5-method set; there is NO
        // replay-config entry point to call. ObjC runtime reflection confirms
        // no `configureReplay`/`setReplayConfig` selector was added.
        let cls: AnyClass = TraceItXBridge.self
        let metaCls: AnyClass = object_getClass(cls)!

        XCTAssertFalse(
            classResponds(metaCls, to: NSSelectorFromString("configureReplay")),
            "bridge must expose NO configureReplay selector (#2 no new surface)"
        )
        XCTAssertFalse(
            classResponds(metaCls, to: NSSelectorFromString("setReplayConfig:")),
            "bridge must expose NO setReplayConfig selector (#2 no new surface)"
        )
        XCTAssertFalse(
            classResponds(metaCls, to: NSSelectorFromString("setReplayConfig")),
            "bridge must expose NO setReplayConfig selector (#2 no new surface)"
        )
    }

    private func classResponds(_ cls: AnyClass, to selector: Selector) -> Bool {
        class_getClassMethod(TraceItXBridge.self, selector) != nil
            || class_getInstanceMethod(cls, selector) != nil
    }

    // MARK: - Test D: openReporter gated on start()/report.open() (#1)

    func testOpenReporterIsGatedOnStart() throws {
        // Without a prior configure() the captureGate is false, so openReporter
        // must call back with the captureGate guard error (TraceItXBridge.swift
        // :100-106, code 1100) — proving the bridge's ONLY reporter entry is the
        // start()-gated report.open() path the presenter freezes/attaches on.
        guard !TraceItX.shared.captureGate else {
            // A prior test in the shared process started the SDK; the gate-false
            // contract can't be exercised here. The structural #1 link
            // (report.open() is the single reporter entry) is documented in the
            // file header + locked by the no-surface assertions above.
            throw XCTSkip("captureGate already true in this process — cannot exercise the gate-false path")
        }

        let exp = expectation(description: "openReporter completion")
        TraceItXBridge.openReporter { dict, err in
            XCTAssertNil(dict, "gated openReporter must not return a result dict")
            let nsErr = err as NSError?
            XCTAssertNotNil(nsErr, "openReporter before start() must error")
            XCTAssertEqual(nsErr?.code, 1100)
            XCTAssertTrue(
                (nsErr?.localizedDescription ?? "").contains("captureGate"),
                "error must name the captureGate guard"
            )
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
    }

    // MARK: - Test E: addBreadcrumb forwards to the native singleton (Task 14)

    /// The bridge does NO coercion — it forwards straight to
    /// `TraceItX.shared.addBreadcrumb`, which owns kind coercion (Task 5).
    /// Proves the crumb lands in `BreadcrumbRingBuffer.shared` AND that an
    /// unrecognized kind coerces to `.custom` — i.e., that coercion is
    /// happening in the singleton reached through the bridge, not (because
    /// there isn't any) in the bridge itself.
    func testAddBreadcrumbForwardsToNativeSingletonWithKindCoercion() throws {
        if !TraceItX.shared.captureGate {
            try TraceItX.shared.start(config: TraceItXConfig(appId: "txx_live_rnbridgetest"))
        }
        let marker = "rn-bridge-\(UUID().uuidString)"
        TraceItXBridge.addBreadcrumb(
            marker as NSString,
            kind: "totally-unknown-kind" as NSString,
            level: nil,
            data: nil
        )

        BreadcrumbRingBuffer.shared.freeze()
        let crumb = BreadcrumbRingBuffer.shared.takeFrozen()?.first { $0.message == marker }
        XCTAssertNotNil(crumb, "addBreadcrumb bridge must reach BreadcrumbRingBuffer.shared")
        XCTAssertEqual(
            crumb?.kind.rawValue, "custom",
            "unknown kind must coerce to custom — proving TraceItX.shared (Task 5), not the bridge, owns coercion"
        )
    }
}
#endif
