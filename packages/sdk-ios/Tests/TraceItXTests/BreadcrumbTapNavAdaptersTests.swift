// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 8 — tap + navigation breadcrumb adapters. Same reset/lock discipline
// as BreadcrumbAdaptersTests.swift (Task 7): `.serialized` suite, explicit
// `resetBreadcrumbState()` around every case touching the process-wide
// `BreadcrumbRingBuffer.shared`. EVERY act -> assert window below — not just
// the disabled-kind ones — additionally holds `BreadcrumbSharedStateTestLock`
// for its full duration: `BreadcrumbAdaptersTests`' own disabled-kind tests
// call `applyConfig(kinds: ["network"])` / `applyConfig(kinds: ["console"])`
// UNDER that same lock, and since neither list includes "tap"/"navigation",
// such a call landing mid-window here would transiently disable OUR kind and
// silently drop the crumb THIS test is asserting the presence of — a real,
// observed flake (`tap_doubleInstall_stillFiresExactlyOneCrumbPerAction`
// failed exactly this way once during hardening). Taking the lock around the
// whole act -> assert section closes that window; unique per-test markers
// alone are not enough here because the vulnerability is "kind gated off",
// not "wrong crumb matched".
//
// UIKIT-ONLY: every test in this file requires a real UIApplication /
// UIViewController lifecycle, which macOS `swift test --package-path
// packages/sdk-ios` compiles OUT entirely (`#if canImport(UIKit)` around the
// whole file) — that run reports "green" while executing ZERO of these
// assertions (false pass). Evidence must come from an iOS Simulator run:
// `xcodebuild test -scheme TraceItX-Package -destination
// 'platform=iOS Simulator,name=iPhone 16'` (run from packages/sdk-ios).
//
// TAP TESTS use `TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting`
// instead of calling `UIApplication.shared.sendAction(...)` / `UIControl.
// sendActions(for:)` directly. Verified via targeted debug instrumentation:
// this repo's headless SwiftPM test bundle has NO connected `UIWindowScene`
// (`UIApplication.shared.connectedScenes.count == 0`, even with a real
// `UIWindow` that is `makeKeyAndVisible()`'d, laid out, AND given a run-loop
// spin to settle) — and modern UIKit's target-action dispatch machinery
// silently no-ops without one: neither call ever reaches the
// `sendAction:to:from:forEvent:` selector at all (confirmed by a print
// placed as the literal first statement of the installed implementation
// never firing). This is an iOS 13+ platform behavior of the test harness,
// not a bug in the adapter. The seam drives the exact same installed
// implementation a real touch event would reach in an app with a live scene
// — see the seam's doc comment and the Task 8 report for the full
// repro/triage notes. Real end-to-end verification (tap a real button in
// the example app, confirm a `.tap` breadcrumb lands) is the manual
// checklist item this maps to.
//
// NAVIGATION TESTS, by contrast, drive a REAL `UINavigationController` push
// under a real (if scene-less) `UIWindow` and DO reach `viewDidAppear` on
// both the pushed and root view controllers — but only after the run loop
// is given a short spin (`RunLoop.current.run(until:)`) past
// `makeKeyAndVisible()`/`pushViewController` for UIKit to actually process
// the queued appearance-transition callbacks even with `animated: false`.
import Testing
import Foundation
import TraceItXProtocol
#if canImport(UIKit)
import UIKit
@testable import TraceItXKit

/// Real target-action receiver reachable via `NSObject`'s `@objc` method
/// table (not a closure) — required by the `sendAction:to:from:forEvent:`
/// signature the seam below drives directly.
final class TapTargetSpy: NSObject {
    var tapCount = 0
    @objc func handleTap() { tapCount += 1 }
}

@MainActor
@Suite(.serialized)
struct BreadcrumbTapNavAdaptersTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    private func resetBreadcrumbState() {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
    }

    private func noLogCaptureConfig() -> TraceItXConfig {
        TraceItXConfig(appId: testAppId, capture: CaptureConfig(logs: false))
    }

    private func matchingCrumbs(kind: BreadcrumbKind, messageContains needle: String) -> [Breadcrumb] {
        BreadcrumbRingBuffer.shared.freeze()
        return (BreadcrumbRingBuffer.shared.takeFrozen() ?? []).filter {
            $0.kind == kind && $0.message.contains(needle)
        }
    }

    private func crumbs(kind: BreadcrumbKind) -> [Breadcrumb] {
        BreadcrumbRingBuffer.shared.freeze()
        return (BreadcrumbRingBuffer.shared.takeFrozen() ?? []).filter { $0.kind == kind }
    }

    /// Spin the run loop briefly so queued UIKit appearance-transition work
    /// (navigation push/pop callbacks) actually executes even with
    /// `animated: false` — see the file header comment.
    private func settleRunLoop() {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    // MARK: - Tap: sendAction through a real UIControl target-action

    @Test func tap_sendActionThroughRealButton_firesOneTapCrumbWithExpectedLabel() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let marker = "Submit-\(UUID().uuidString)"
            let button = UIButton(type: .system)
            button.setTitle(marker, for: .normal)
            let target = TapTargetSpy()
            button.addTarget(target, action: #selector(TapTargetSpy.handleTap), for: .touchUpInside)

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: button, event: nil)

            let matches = matchingCrumbs(kind: .tap, messageContains: marker)
            #expect(matches.count == 1)
            #expect(matches.first?.message == "tap \(marker)")
            #expect(matches.first?.data?["control"]?.value as? String == "UIButton")
        }
        resetBreadcrumbState()
    }

    // MARK: - Tap: install-once idempotency

    @Test func tap_doubleInstall_stillFiresExactlyOneCrumbPerAction() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        // A second, explicit install() call (mirrors a host calling start()
        // twice) must not double-wrap the IMP (which would otherwise fire
        // crumb logic twice per real invocation).
        TapBreadcrumbAdapter.install()
        TapBreadcrumbAdapter.install()
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let marker = "Idempotent-\(UUID().uuidString)"
            let button = UIButton(type: .system)
            button.setTitle(marker, for: .normal)
            let target = TapTargetSpy()
            button.addTarget(target, action: #selector(TapTargetSpy.handleTap), for: .touchUpInside)

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: button, event: nil)

            let matches = matchingCrumbs(kind: .tap, messageContains: marker)
            #expect(matches.count == 1)
        }
        resetBreadcrumbState()
    }

    // MARK: - Tap: masked-aware label (sender itself sensitive)

    @Test func tap_maskedSender_labelIsMaskedAndLeaksNoText() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let secretTitle = "SuperSecret-\(UUID().uuidString)"
            let controlMarker = "MaskedControl-\(UUID().uuidString)"
            let button = UIButton(type: .system)
            button.setTitle(secretTitle, for: .normal)
            button.accessibilityIdentifier = controlMarker
            SensitiveRectRegistry.mark(button)
            let target = TapTargetSpy()
            button.addTarget(target, action: #selector(TapTargetSpy.handleTap), for: .touchUpInside)

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: button, event: nil)

            // Filter by kind + exact masked message (never by the marker
            // text) since the whole point is the message must NOT contain
            // any distinguishing text from the view.
            BreadcrumbRingBuffer.shared.freeze()
            let all = BreadcrumbRingBuffer.shared.takeFrozen() ?? []
            let tapCrumbs = all.filter { $0.kind == .tap && $0.message == "tap [masked]" }
            #expect(tapCrumbs.count == 1)
            let crumb = tapCrumbs.first
            #expect(crumb?.data?["masked"]?.value as? Bool == true)
            #expect(crumb?.data?["control"]?.value as? String == "UIButton")
            #expect(crumb?.data?["id"] == nil)
            // Stringify the whole crumb and confirm the secret title never
            // appears anywhere in it (message OR data).
            let dump = String(describing: crumb)
            #expect(!dump.contains(secretTitle))
        }
        resetBreadcrumbState()
    }

    // MARK: - Tap: masked-aware label (an ANCESTOR is sensitive, not the sender itself)

    @Test func tap_maskedAncestor_labelIsMaskedAndLeaksNoText() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let secretTitle = "AncestorSecret-\(UUID().uuidString)"
            let sensitiveContainer = TXSensitiveView(frame: .zero)
            let button = UIButton(type: .system)
            button.setTitle(secretTitle, for: .normal)
            sensitiveContainer.addSubview(button)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
            window.addSubview(sensitiveContainer)

            let target = TapTargetSpy()
            button.addTarget(target, action: #selector(TapTargetSpy.handleTap), for: .touchUpInside)

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: button, event: nil)

            BreadcrumbRingBuffer.shared.freeze()
            let all = BreadcrumbRingBuffer.shared.takeFrozen() ?? []
            let tapCrumbs = all.filter { $0.kind == .tap && $0.message == "tap [masked]" }
            #expect(tapCrumbs.count == 1)
            let dump = String(describing: tapCrumbs.first)
            #expect(!dump.contains(secretTitle))
        }
        resetBreadcrumbState()
    }

    // MARK: - Tap: disabled-kind no-op

    @Test func tap_isNoOpWhenKindDisabled() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            BreadcrumbRingBuffer.shared.applyConfig(
                BreadcrumbsConfigWire(
                    enabled: true, kinds: ["network"], maxCount: 10, byteBudget: 16384,
                    consoleEntryCap: 1024))
            let marker = "ShouldNotLand-\(UUID().uuidString)"
            let button = UIButton(type: .system)
            button.setTitle(marker, for: .normal)
            let target = TapTargetSpy()
            button.addTarget(target, action: #selector(TapTargetSpy.handleTap), for: .touchUpInside)
            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: button, event: nil)
            #expect(crumbs(kind: .tap).filter { $0.message.contains(marker) }.isEmpty)
        }
        resetBreadcrumbState()
    }

    // MARK: - Tap: non-view sender (degrade path, BreadcrumbTapNavAdapters.swift:198-214)
    //
    // A `UIBarButtonItem` is `NSObject`-rooted but NOT a `UIView`, so it
    // exercises `deriveLabelAndData`'s non-view branch: no ancestor walk (it
    // has no superview chain), no `currentTitle` fallback (that only exists
    // on the `UIView`/`UIButton` branch) — just accessibilityLabel ->
    // accessibilityIdentifier -> class name. Each case below also plants a
    // `title` "secret" to prove the degrade path never reads it: `title` is
    // only ever consulted through `.currentTitle` on the UIView branch, so a
    // non-view sender's title must NEVER surface in the crumb regardless of
    // which precedence step wins.

    @Test func tap_nonViewSender_accessibilityLabelWinsOverIdentifierAndTitle() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let labelMarker = "BarLabel-\(UUID().uuidString)"
            let identifierMarker = "BarIdentifier-\(UUID().uuidString)"
            let secretTitle = "BarTitleSecret-\(UUID().uuidString)"
            let barButtonItem = UIBarButtonItem()
            barButtonItem.title = secretTitle
            barButtonItem.accessibilityIdentifier = identifierMarker
            barButtonItem.accessibilityLabel = labelMarker
            let target = TapTargetSpy()

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: barButtonItem,
                event: nil)

            let matches = matchingCrumbs(kind: .tap, messageContains: labelMarker)
            #expect(matches.count == 1)
            #expect(matches.first?.message == "tap \(labelMarker)")
            #expect(matches.first?.data?["control"]?.value as? String == "UIBarButtonItem")
            let dump = String(describing: matches.first)
            #expect(!dump.contains(identifierMarker))
            #expect(!dump.contains(secretTitle))
        }
        resetBreadcrumbState()
    }

    @Test func tap_nonViewSender_fallsBackToAccessibilityIdentifier_whenNoLabel() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let identifierMarker = "BarIdentifierOnly-\(UUID().uuidString)"
            let secretTitle = "BarTitleSecret-\(UUID().uuidString)"
            let barButtonItem = UIBarButtonItem()
            barButtonItem.title = secretTitle
            // Explicitly empty (not merely unset) so UIKit's own default
            // accessibilityLabel-from-title behavior can never fill this in
            // behind our back — the test must isolate "code never reads
            // .title", not "UIKit happened not to synthesize a label".
            barButtonItem.accessibilityLabel = ""
            barButtonItem.accessibilityIdentifier = identifierMarker
            let target = TapTargetSpy()

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: barButtonItem,
                event: nil)

            let matches = matchingCrumbs(kind: .tap, messageContains: identifierMarker)
            #expect(matches.count == 1)
            #expect(matches.first?.message == "tap \(identifierMarker)")
            #expect(matches.first?.data?["control"]?.value as? String == "UIBarButtonItem")
            let dump = String(describing: matches.first)
            #expect(!dump.contains(secretTitle))
        }
        resetBreadcrumbState()
    }

    @Test func tap_nonViewSender_degradesToClassName_andNeverConsultsTitleText() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let secretTitle = "BarTitleOnlySecret-\(UUID().uuidString)"
            let barButtonItem = UIBarButtonItem()
            barButtonItem.title = secretTitle
            // Same rationale as above: force both accessibility properties
            // to explicit "absent" values so neither precedence step above
            // class-name can win, and confirm the degrade floor is the class
            // name, not the title.
            barButtonItem.accessibilityLabel = ""
            barButtonItem.accessibilityIdentifier = ""
            let target = TapTargetSpy()

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: barButtonItem,
                event: nil)

            BreadcrumbRingBuffer.shared.freeze()
            let all = BreadcrumbRingBuffer.shared.takeFrozen() ?? []
            let tapCrumbs = all.filter { $0.kind == .tap && $0.message == "tap UIBarButtonItem" }
            #expect(tapCrumbs.count == 1)
            #expect(tapCrumbs.first?.data?["control"]?.value as? String == "UIBarButtonItem")
            // Non-view path never consults text content — the secret title
            // must never appear anywhere in the crumb (message OR data),
            // even though it's the only non-empty piece of state on the
            // sender.
            let dump = String(describing: tapCrumbs.first)
            #expect(!dump.contains(secretTitle))
        }
        resetBreadcrumbState()
    }

    // MARK: - Navigation: viewDidAppear under a UINavigationController

    @Test func navigation_pushUnderNavigationController_emitsOneCrumbWithClassNames() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        NavigationBreadcrumbAdapter.__resetForTesting()
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let root = NavRootFakeVC()
            let nav = UINavigationController(rootViewController: root)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
            window.rootViewController = nav
            window.makeKeyAndVisible()
            window.layoutIfNeeded()
            settleRunLoop()

            let second = NavSecondFakeVC()
            nav.pushViewController(second, animated: false)
            settleRunLoop()

            let matches = crumbs(kind: .navigation).filter {
                $0.data?["to"]?.value as? String == "NavSecondFakeVC"
            }
            #expect(matches.count == 1)
            #expect(matches.first?.data?["from"]?.value as? String == "NavRootFakeVC")
            #expect(matches.first?.message == "NavRootFakeVC → NavSecondFakeVC")
        }
        resetBreadcrumbState()
    }

    // MARK: - Navigation: disabled-kind no-op

    @Test func navigation_isNoOpWhenKindDisabled() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        NavigationBreadcrumbAdapter.__resetForTesting()
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            BreadcrumbRingBuffer.shared.applyConfig(
                BreadcrumbsConfigWire(
                    enabled: true, kinds: ["console"], maxCount: 10, byteBudget: 16384,
                    consoleEntryCap: 1024))

            let root = NavRootFakeVC()
            let nav = UINavigationController(rootViewController: root)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
            window.rootViewController = nav
            window.makeKeyAndVisible()
            window.layoutIfNeeded()
            settleRunLoop()
            let second = NavSecondFakeVC()
            nav.pushViewController(second, animated: false)
            settleRunLoop()

            #expect(crumbs(kind: .navigation).isEmpty)
        }
        resetBreadcrumbState()
    }

    // MARK: - recordScreen (screen markers — spec 2026-07-14)

    @Test func recordScreen_chainsFromTo_suppressesSelfTransition_andMergesHostData() throws {
        resetBreadcrumbState()
        NavigationBreadcrumbAdapter.__resetForTesting()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let a = "ScreenA-\(UUID().uuidString)"
            let b = "ScreenB-\(UUID().uuidString)"

            TraceItX.shared.recordScreen(a)                          // first screen — no crumb
            TraceItX.shared.recordScreen(a)                          // A → A — suppressed
            TraceItX.shared.recordScreen(b, data: ["stack": "root", "from": "spoofed"])
            TraceItX.shared.recordScreen("")                         // blank — dropped

            let matches = matchingCrumbs(kind: .navigation, messageContains: a)
            #expect(matches.count == 1)
            #expect(matches.first?.message == "\(a) → \(b)")
            #expect(matches.first?.data?["from"]?.value as? String == a)   // host "from" lost the collision
            #expect(matches.first?.data?["to"]?.value as? String == b)
            #expect(matches.first?.data?["stack"]?.value as? String == "root")
        }
        resetBreadcrumbState()
        NavigationBreadcrumbAdapter.__resetForTesting()
    }

    /// Parity with the Android twin's captureGate guard: pre-start / killed
    /// calls to `recordScreen` must be a full no-op — not just "no crumb
    /// emitted" but "the shared previous-screen chain is never touched"
    /// either. `captureGate` is a process-wide static that a prior test's
    /// `start()` may have already flipped true (the `.serialized` suite runs
    /// in one process), so this test explicitly `kill()`s first to force the
    /// closed-gate state rather than assuming a fresh process.
    @Test func recordScreen_preStartOrKilled_isNoOpAndDoesNotSeedChain() throws {
        resetBreadcrumbState()
        NavigationBreadcrumbAdapter.__resetForTesting()
        TraceItX.shared.kill() // force captureGate closed regardless of prior test order
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            TraceItX.shared.recordScreen("PreStartA")
            TraceItX.shared.recordScreen("PreStartB")

            let preStartMatches = crumbs(kind: .navigation)
            #expect(preStartMatches.isEmpty)
        }

        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            TraceItX.shared.recordScreen("Home")

            // If pre-start calls had leaked into `previousClassName`, this
            // "Home" call would read `from == "PreStartB"` and emit a
            // "PreStartB → Home" crumb. With the chain correctly unseeded,
            // "Home" is the first screen the process has seen and emits
            // nothing (no "from" yet — mirrors the existing
            // `recordScreen_chainsFromTo...` test's first-screen case).
            let allNav = crumbs(kind: .navigation)
            #expect(allNav.isEmpty)
            #expect(!allNav.contains { $0.message.contains("PreStartA") })
            #expect(!allNav.contains { $0.message.contains("PreStartB") })
            #expect(!allNav.contains { $0.message == "PreStartB → Home" })
        }
        resetBreadcrumbState()
        NavigationBreadcrumbAdapter.__resetForTesting()
    }

    // MARK: - Tap: keystroke filter (text-input senders demand touch proof)

    // RN's RCTUITextField registers a target for `.editingChanged`, so every
    // typed character routed through sendAction and crumbed `tap <field>`
    // once per key press (2026-07-14 finding — flooded the ring buffer and
    // leaked keystroke cadence). Text-input controls now demand positive
    // proof of a real tap: an ended touch inside the control. A keystroke's
    // sendAction carries no such touch (nil event, presses event, or
    // keyboard-window touches) — this test drives the REAL installed
    // sendAction path with the closest headless approximation (nil event;
    // UIEvent/UITouch are not constructible headlessly) and expects NO
    // crumb. The in-bounds geometric branch itself is exercised in the
    // example app (manual checklist: tap the field once → exactly one crumb,
    // type → none).
    @Test func tap_textFieldActionWithoutTouchProof_firesNoCrumb() throws {
        resetBreadcrumbState()
        try TraceItX.shared.start(config: noLogCaptureConfig())
        do {
            BreadcrumbSharedStateTestLock.lock.lock()
            defer { BreadcrumbSharedStateTestLock.lock.unlock() }
            let marker = "Field-\(UUID().uuidString)"
            let field = UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
            field.accessibilityIdentifier = marker
            let target = TapTargetSpy()
            target.tapCount = 0
            field.addTarget(target, action: #selector(TapTargetSpy.handleTap), for: .editingChanged)

            _ = TapBreadcrumbAdapter.__invokeInstalledSendActionForTesting(
                action: #selector(TapTargetSpy.handleTap), target: target, sender: field, event: nil)

            #expect(matchingCrumbs(kind: .tap, messageContains: marker).isEmpty,
                    "text-input sendAction without an in-bounds ended touch must not crumb")
        }
        resetBreadcrumbState()
    }

    @Test func isIndirectTextInputAction_textFieldWithoutTouchProof_isTrue() {
        let field = UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
        #expect(TapBreadcrumbAdapter.isIndirectTextInputAction(sender: field, event: nil))
    }

    // Buttons (and non-controls, and nil senders) keep the permissive path:
    // their actions cannot fire per-keystroke, and demanding touch proof
    // would break tvOS remote presses / accessibility activation, which
    // carry no touches.
    @Test func isIndirectTextInputAction_nonTextInputSenders_areFalse() {
        #expect(
            !TapBreadcrumbAdapter.isIndirectTextInputAction(
                sender: UIButton(type: .system), event: nil))
        #expect(!TapBreadcrumbAdapter.isIndirectTextInputAction(sender: UIView(), event: nil))
        #expect(!TapBreadcrumbAdapter.isIndirectTextInputAction(sender: nil, event: nil))
    }
}

/// Distinct fake VC classes so `String(describing: type(of:))` yields a
/// stable, PII-free class name distinguishable from other suites' VCs.
final class NavRootFakeVC: UIViewController {}
final class NavSecondFakeVC: UIViewController {}
#endif
