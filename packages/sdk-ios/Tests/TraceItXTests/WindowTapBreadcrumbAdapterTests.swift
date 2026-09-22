// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Window-level tap crumbs (spec 2026-07-14 — RN parity). UIEvent/UITouch are
// not constructible headlessly, so these tests drive recordEndedTouch (the
// entire crumb path minus the 4-line touch extractor in the swizzle block).
// Suite conventions mirror BreadcrumbTapNavAdaptersTests.swift.
#if canImport(UIKit)
import Testing
import UIKit
@testable import TraceItXKit
import TraceItXProtocol

/// Simulates an RN Fabric container (Pressable/card) — plain view, no a11y
/// props, class name is what leaked into crumbs as "tap RCTViewComponentView".
private final class RCTViewComponentView: UIView {}
/// Simulates an RN Fabric text leaf: not a UILabel; mirrors its rendered
/// string into accessibilityLabel (same contract the replay producer reads).
private final class RCTParagraphComponentView: UIView {}

@MainActor
@Suite(.serialized)
struct WindowTapBreadcrumbAdapterTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    private func resetBreadcrumbState() {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
        TapBreadcrumbAdapter.__resetForTesting()
    }

    private func noLogCaptureConfig() -> TraceItXConfig {
        TraceItXConfig(appId: testAppId, capture: CaptureConfig(logs: false))
    }

    private func tapCrumbs() -> [Breadcrumb] {
        BreadcrumbRingBuffer.shared.freeze()
        return (BreadcrumbRingBuffer.shared.takeFrozen() ?? []).filter { $0.kind == .tap }
    }

    @Test func endedTouch_recordsTapWithAccessibilityLabel() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let marker = "Submit-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let leaf = UIView(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
                leaf.accessibilityLabel = marker
                window.addSubview(leaf)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: leaf, location: CGPoint(x: 10, y: 10), window: window, eventTimestamp: 100.0)

                let crumbs = tapCrumbs().filter { $0.message.contains(marker) }
                #expect(crumbs.count == 1)
                #expect(crumbs.first?.message == "tap \(marker)")
            }
            resetBreadcrumbState()
        }
    }

    @Test func labellessLeaf_resolvesToLabeledAncestor() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                // RN shape: Pressable (traits .button, labeled) wrapping a
                // paragraph leaf with no label of its own.
                let marker = "Checkout-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let pressable = UIView(frame: CGRect(x: 0, y: 0, width: 120, height: 44))
                pressable.accessibilityTraits = .button
                pressable.accessibilityLabel = marker
                let leaf = UIView(frame: pressable.bounds)
                pressable.addSubview(leaf)
                window.addSubview(pressable)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: leaf, location: CGPoint(x: 5, y: 5), window: window, eventTimestamp: 101.0)

                #expect(tapCrumbs().filter { $0.message == "tap \(marker)" }.count == 1)
            }
            resetBreadcrumbState()
        }
    }

    @Test func sendActionCrumb_suppressesWindowCrumbForSameEvent() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let marker = "Save-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let button = UIButton(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
                button.accessibilityLabel = marker
                window.addSubview(button)

                // sendAction fires first (inside the original sendEvent
                // call-through)…
                TapBreadcrumbAdapter.recordTap(sender: button, eventTimestamp: 102.0)
                // …then the window adapter sees the same UIEvent's ended touch.
                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: button, location: CGPoint(x: 10, y: 10), window: window, eventTimestamp: 102.0)

                #expect(tapCrumbs().filter { $0.message.contains(marker) }.count == 1,
                        "same-event window crumb must be suppressed")
            }
            resetBreadcrumbState()
        }
    }

    @Test func differentEvent_isNotSuppressed() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let marker = "Card-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let view = UIView(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
                view.accessibilityLabel = marker
                window.addSubview(view)

                TapBreadcrumbAdapter.recordTap(sender: view, eventTimestamp: 103.0)
                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: view, location: CGPoint(x: 10, y: 10), window: window, eventTimestamp: 104.0)

                #expect(tapCrumbs().filter { $0.message.contains(marker) }.count == 2)
            }
            resetBreadcrumbState()
        }
    }

    @Test func sensitiveView_recordsMaskedLabel() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let secretLabel = "SSN-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let secret = UIView(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
                secret.accessibilityLabel = secretLabel
                SensitiveRectRegistry.mark(secret)
                window.addSubview(secret)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: secret, location: CGPoint(x: 10, y: 10), window: window, eventTimestamp: 105.0)

                // Assert by exact masked message — the whole point is the crumb
                // must NOT contain any distinguishing text from the view.
                let crumbs = tapCrumbs()
                #expect(crumbs.filter { $0.message == "tap [masked]" }.count == 1)
                #expect(crumbs.filter { $0.message.contains(secretLabel) }.isEmpty)
            }
            resetBreadcrumbState()
        }
    }

    @Test func nilView_fallsBackToHitTestThenWindow() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: nil, location: CGPoint(x: 5, y: 5), window: window, eventTimestamp: 106.0)
                #expect(tapCrumbs().count == 1, "nil touch.view must still produce a crumb")
            }
            resetBreadcrumbState()
        }
    }

    @Test func labellessContainer_minesDescendantTextInsteadOfClassName() async throws {
        try await withGlobalCaptureStateLock {
            // RN shape behind "tap RCTViewComponentView" (2026-07-14): a Pressable
            // /card container with no a11y props whose caption lives in a child
            // text leaf. The label must come from the subtree's first visible
            // text, not the container's class name.
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let marker = "AddToCart-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let card = RCTViewComponentView(frame: CGRect(x: 0, y: 0, width: 200, height: 80))
                let caption = RCTParagraphComponentView(frame: CGRect(x: 8, y: 8, width: 180, height: 24))
                caption.accessibilityLabel = marker
                card.addSubview(caption)
                window.addSubview(card)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: card, location: CGPoint(x: 100, y: 60), window: window, eventTimestamp: 200.0)

                #expect(tapCrumbs().filter { $0.message == "tap \(marker)" }.count == 1)
                #expect(tapCrumbs().filter { $0.message.contains("RCTViewComponentView") }.isEmpty)
            }
            resetBreadcrumbState()
        }
    }

    @Test func labellessContainer_minesDescendantUILabelText() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let marker = "Checkout-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let container = UIView(frame: CGRect(x: 0, y: 0, width: 200, height: 80))
                let label = UILabel(frame: CGRect(x: 8, y: 8, width: 180, height: 24))
                label.text = marker
                container.addSubview(label)
                window.addSubview(container)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: container, location: CGPoint(x: 100, y: 60), window: window, eventTimestamp: 201.0)

                #expect(tapCrumbs().filter { $0.message == "tap \(marker)" }.count == 1)
            }
            resetBreadcrumbState()
        }
    }

    @Test func sensitiveDescendantText_isNeverMined() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let secret = "SSN-\(UUID().uuidString)"
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let container = UIView(frame: CGRect(x: 0, y: 0, width: 200, height: 80))
                let label = UILabel(frame: CGRect(x: 8, y: 8, width: 180, height: 24))
                label.text = secret
                SensitiveRectRegistry.mark(label)
                container.addSubview(label)
                window.addSubview(container)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: container, location: CGPoint(x: 100, y: 60), window: window, eventTimestamp: 202.0)

                let crumbs = tapCrumbs()
                #expect(crumbs.count == 1)
                #expect(crumbs.filter { $0.message.contains(secret) }.isEmpty,
                        "sensitive descendant text must never reach a tap label")
            }
            resetBreadcrumbState()
        }
    }

    @Test func textlessContainer_stillFallsBackToClassName() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try TraceItX.shared.start(config: noLogCaptureConfig())
            do {
                BreadcrumbSharedStateTestLock.lock.lock()
                defer { BreadcrumbSharedStateTestLock.lock.unlock() }
                let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
                let bare = RCTViewComponentView(frame: CGRect(x: 0, y: 0, width: 200, height: 80))
                window.addSubview(bare)

                WindowTapBreadcrumbAdapter.recordEndedTouch(
                    view: bare, location: CGPoint(x: 100, y: 60), window: window, eventTimestamp: 203.0)

                #expect(tapCrumbs().filter { $0.message == "tap RCTViewComponentView" }.count == 1)
            }
            resetBreadcrumbState()
        }
    }

    @Test func install_isIdempotent() async throws {
        try await withGlobalCaptureStateLock {
            WindowTapBreadcrumbAdapter.install()
            WindowTapBreadcrumbAdapter.install()
            #expect(WindowTapBreadcrumbAdapter.installedForTesting)
        }
    }
}
#endif
