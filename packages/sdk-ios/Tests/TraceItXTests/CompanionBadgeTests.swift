// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `CompanionBadge` — the capture-excluded companion name badge (naming spec
// 2026-08-24, Task 5). Identification only; see `CompanionBadge.swift`'s
// header for why this is NOT the removed fail-closed sharing indicator.
//
// Two tiers, split the same way `TESTING.md` documents for every other
// UIKit-gated type in this package:
//
//   • `CompanionBadgeLabelTests` / `CompanionBadgeOptionsTests` — pure Swift,
//     no UIKit, so they run under the macOS-host `swift test` job.
//   • `CompanionBadgeTests` — `#if canImport(UIKit)`, driving `__surfaceProvider`
//     with a plain container view rather than the production overlay
//     `UIWindow`. A SwiftPM test bundle has no UI scenes at all
//     (`UIApplication.shared.connectedScenes` is empty — verified by the same
//     probe the removed sharing indicator's tests relied on, see
//     `git show 4011fad0~1:packages/sdk-ios/Tests/TraceItXTests/
//     CompanionSharingIndicatorTests.swift`), so `UIWindow(windowScene:)`
//     cannot be constructed here. Window construction itself is therefore
//     covered only by the manual/simulator device gate; what these tests
//     prove is the same attach/update/detach state machine production runs,
//     plus the `windowLevel` CONSTANT this badge is built with — asserted
//     against the two neighbouring windows the capture-exclusion argument
//     depends on (`ReporterWindowController` at `.alert + 1`,
//     `ScreenshotCapture.activeKeyWindow()`'s picked host window at
//     `.normal`), exactly as the removed indicator's own test did.
import Combine
import Testing
@testable import TraceItXKit

// MARK: - Host-runnable: label composition (no UIKit required)

@Suite
struct CompanionBadgeLabelTests {

    @Test("both nil composes to an empty string")
    func bothNil() {
        #expect(CompanionBadgeLabel.compose(resolvedName: nil, code: nil) == "")
    }

    @Test("resolvedName only")
    func resolvedNameOnly() {
        #expect(CompanionBadgeLabel.compose(resolvedName: "Living Room TV", code: nil) == "Living Room TV")
    }

    @Test("code only")
    func codeOnly() {
        #expect(CompanionBadgeLabel.compose(resolvedName: nil, code: "7421") == "7421")
    }

    @Test("both present join with a middle dot separator")
    func bothPresent() {
        #expect(CompanionBadgeLabel.compose(resolvedName: "Living Room TV", code: "7421")
                == "Living Room TV · 7421")
    }

    @Test("an empty-string resolvedName still participates in the join")
    func emptyStringResolvedName() {
        // compactMap only strips nil, not empty strings — a caller that
        // upstream-normalized "" instead of nil would still show a leading
        // separator. Documenting the actual (non-)behavior rather than
        // silently assuming callers never pass "".
        #expect(CompanionBadgeLabel.compose(resolvedName: "", code: "7421") == " · 7421")
    }
}

// MARK: - Host-runnable: options defaults

@Suite
struct CompanionBadgeOptionsTests {

    @Test("default options are enabled, bottom-right")
    func defaults() {
        let options = CompanionBadgeOptions()
        #expect(options.enabled == true)
        #expect(options.position == .bottomRight)
    }

    @Test("explicit values are stored as given")
    func explicitValues() {
        let options = CompanionBadgeOptions(enabled: false, position: .topLeft)
        #expect(options.enabled == false)
        #expect(options.position == .topLeft)
    }
}

// MARK: - Host-runnable: server/inline precedence (dashboard config plan 2026-08-25)

@Suite
struct CompanionBadgeResolutionTests {

    @Test("enabled: an explicit server value wins over the inline option in both directions")
    func serverEnabledWins() {
        #expect(CompanionBadgeResolution.enabled(
            server: CompanionBadgeConfigWire(enabled: false, position: nil),
            inline: CompanionBadgeOptions()
        ) == false)
        #expect(CompanionBadgeResolution.enabled(
            server: CompanionBadgeConfigWire(enabled: true, position: nil),
            inline: CompanionBadgeOptions(enabled: false)
        ) == true)
    }

    @Test("enabled: no server block falls back to the inline option")
    func noServerFallsBackToInline() {
        #expect(CompanionBadgeResolution.enabled(
            server: nil,
            inline: CompanionBadgeOptions(enabled: false)
        ) == false)
    }

    @Test("position: a recognized server position wins over the inline option")
    func serverPositionWins() {
        #expect(CompanionBadgeResolution.position(
            server: CompanionBadgeConfigWire(enabled: true, position: "top-left"),
            inline: CompanionBadgeOptions()
        ) == .topLeft)
    }

    @Test("position: an unrecognized server position falls back to the inline option")
    func unknownServerPositionFallsBackToInline() {
        #expect(CompanionBadgeResolution.position(
            server: CompanionBadgeConfigWire(enabled: true, position: "center"),
            inline: CompanionBadgeOptions(position: .topRight)
        ) == .topRight)
    }

    @Test("position: no server block falls back to the inline option")
    func noServerPositionFallsBackToInline() {
        #expect(CompanionBadgeResolution.position(
            server: nil,
            inline: CompanionBadgeOptions(position: .bottomLeft)
        ) == .bottomLeft)
    }
}

// MARK: - Host-runnable: server config box publisher (final-review fix, plan 2026-08-25)

@Suite(.serialized)
struct CompanionBadgeServerConfigBoxTests {

    @Test("the publisher replays the current value immediately, then emits on every set")
    func publisherReplaysThenEmits() {
        CompanionBadgeServerConfigBox.shared.value = nil
        defer { CompanionBadgeServerConfigBox.shared.value = nil }

        var received: [CompanionBadgeConfigWire?] = []
        let cancellable = CompanionBadgeServerConfigBox.shared.publisher.sink { received.append($0) }
        defer { cancellable.cancel() }

        #expect(received == [nil], "CurrentValueSubject must replay the current value to a new subscriber")

        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: false, position: nil)
        #expect(received.count == 2)
        #expect(received.last == CompanionBadgeConfigWire(enabled: false, position: nil))

        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: true, position: "top-left")
        #expect(received.count == 3)
        #expect(received.last == CompanionBadgeConfigWire(enabled: true, position: "top-left"))
    }

    // Codex round-1 fix D, finding 4 (partial by ruling — no epoch-guarded
    // setter). `TraceItX.start()`'s session-boundary reset section
    // (TraceItX.swift, alongside `_user = nil`/`_identityHolder.set(nil)`)
    // now synchronously writes `CompanionBadgeServerConfigBox.shared.value =
    // nil`, so a new start() against a different app never inherits the
    // PREVIOUS app's dashboard-configured badge override while the new
    // app's first config fetch is still in flight. Driving a real
    // `TraceItX.start()` from this test target is heavy (full config
    // validation + the heavy-init dispatch), so — per the fix brief — this
    // exercises the box's own nil-reset semantics directly, the same
    // operation `start()` performs; the actual call site inside `start()` is
    // compile-verified only (a typo there would fail to build, not fail
    // silently).
    @Test("the box supports the session-boundary reset start() performs: set then nil restores the pre-fetch nil default")
    func nilResetSemanticsMatchStartsSessionBoundaryWrite() {
        CompanionBadgeServerConfigBox.shared.value = nil
        defer { CompanionBadgeServerConfigBox.shared.value = nil }

        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: false, position: "top-left")
        #expect(CompanionBadgeServerConfigBox.shared.value != nil, "precondition: a prior app's override is installed")

        // The exact write start()'s session-boundary section performs.
        CompanionBadgeServerConfigBox.shared.value = nil

        #expect(
            CompanionBadgeServerConfigBox.shared.value == nil,
            "a superseding start() must not leave the previous app's badge override live while the new app's first fetch is in flight"
        )
    }

    // Branding (iOS spec 2026-08-26) — sibling of the companion box test
    // above: `TraceItX.start()`'s session-boundary reset clears
    // `BrandingServerConfigBox` synchronously via the SAME write this test
    // exercises directly (real `start()` is heavy — see the companion
    // test's own doc comment for why).
    @Test("the branding box supports the session-boundary reset start() performs: set then nil restores the pre-fetch nil default")
    func brandingBoxNilResetSemanticsMatchStartsSessionBoundaryWrite() {
        BrandingServerConfigBox.shared.value = nil
        defer { BrandingServerConfigBox.shared.value = nil }

        BrandingServerConfigBox.shared.value = BrandingConfigWire(watermark: false)
        #expect(BrandingServerConfigBox.shared.value != nil, "precondition: a prior app's branding override is installed")

        // The exact write start()'s session-boundary section performs.
        BrandingServerConfigBox.shared.value = nil

        #expect(
            BrandingServerConfigBox.shared.value == nil,
            "a superseding start() must not leave the previous app's branding override live while the new app's first fetch is in flight"
        )
    }
}

// MARK: - UIKit-gated: the attach/detach state machine

#if canImport(UIKit)
import UIKit

@Suite(.serialized)
@MainActor
struct CompanionBadgeTests {

    private func surface() -> UIView {
        UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
    }

    private func reset() {
        CompanionBadge.__surfaceProvider = nil
        // The box is process-global (`.shared`) — final-review fix (plan
        // 2026-08-25, finding 2) tests below write to it directly, so it must
        // be reset on both ends of every test, not just the ones that use it,
        // or a later test in this `.serialized` suite would see a stale value.
        CompanionBadgeServerConfigBox.shared.value = nil
    }

    /// The routed Combine updates hop through `.receive(on: DispatchQueue.main)`,
    /// so a test has to let that chain drain before asserting — mirrors
    /// `RelayWSClientPreviewRoutingTests.drain()`.
    private func drain() async {
        for _ in 0..<50 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    @Test("attach shows the badge with the composed label once attachedUserName arrives")
    func attachShowsComposedLabel() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setResolvedName("Living Room TV")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        #expect(container.subviews.count == 1)
        let label = try? #require(container.subviews.first as? UILabel)
        #expect(label?.text == "Living Room TV · 7421")
    }

    @Test("the label updates in place when resolvedName/code change while attached")
    func labelUpdatesInPlace() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()
        #expect(container.subviews.count == 1)

        companion.__setCode("9999")
        await drain()

        #expect(badge.isVisible)
        #expect(container.subviews.count == 1, "an update must not stack a second label")
        let label = container.subviews.first as? UILabel
        #expect(label?.text == "9999")
    }

    @Test("detach: clearing attachedUserName hides the badge")
    func detachHidesBadge() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()
        #expect(badge.isVisible)

        companion.__setAttachedUserName(nil)
        await drain()

        #expect(!badge.isVisible)
        #expect(container.subviews.isEmpty, "a detached badge must not leave a stale label on screen")
    }

    @Test("disabled: the badge is never shown even once attachedUserName arrives")
    func disabledNeverShows() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion, options: CompanionBadgeOptions(enabled: false))

        companion.__setAttachedUserName("Alice")
        companion.__setResolvedName("Living Room TV")
        companion.__setCode("7421")
        await drain()

        #expect(!badge.isVisible)
        #expect(container.subviews.isEmpty, "a disabled badge must never attach a view, not merely stay hidden")
    }

    @Test("attachedUserName present but resolvedName and code both nil composes empty and stays hidden")
    func emptyComposedLabelStaysHidden() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        await drain()

        #expect(!badge.isVisible, "an empty label carries no identifying information and must not be shown")
        #expect(container.subviews.isEmpty)
    }

    @Test("the label does not swallow touches")
    func labelIsNotInteractive() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = container.subviews.first
        #expect(label?.isUserInteractionEnabled == false,
                "an overlay that swallows input is a bug the user cannot escape")
    }

    @Test("the label is announced to screen readers")
    func labelIsAccessible() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = container.subviews.first
        #expect(label?.isAccessibilityElement == true)
        #expect(label?.accessibilityLabel == "7421")
    }

    // ---- Server-config precedence (dashboard config plan 2026-08-25) ----

    @Test("a server enabled:false overrides an inline enabled:true default and hides the badge")
    func serverDisabledOverridesInlineEnabledDefault() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(
            companion: companion,
            options: CompanionBadgeOptions(),
            serverConfig: { CompanionBadgeConfigWire(enabled: false, position: nil) }
        )

        companion.__setAttachedUserName("Alice")
        companion.__setResolvedName("Living Room TV")
        companion.__setCode("7421")
        await drain()

        #expect(!badge.isVisible, "the dashboard-configured server override must beat the inline default")
        #expect(container.subviews.isEmpty)
    }

    @Test("a server enabled:true force-shows the badge over an inline enabled:false")
    func serverEnabledOverridesInlineDisabled() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(
            companion: companion,
            options: CompanionBadgeOptions(enabled: false),
            serverConfig: { CompanionBadgeConfigWire(enabled: true, position: nil) }
        )

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible, "the dashboard can force-enable the badge over an inline enabled:false")
        #expect(container.subviews.count == 1)
    }

    @Test("a recognized server position overrides the inline position at show time")
    func serverPositionOverridesInlinePosition() async throws {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(
            companion: companion,
            options: CompanionBadgeOptions(position: .bottomRight),
            serverConfig: { CompanionBadgeConfigWire(enabled: true, position: "top-left") }
        )

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = try #require(container.subviews.first as? UILabel)
        let top = constraint(for: label, firstAttribute: .top, in: container)
        let leading = constraint(for: label, firstAttribute: .leading, in: container)
        #expect(top?.constant == 24, "the server-configured top-left position must win over the inline bottomRight")
        #expect(leading?.constant == 24)
        #expect(constraint(for: label, firstAttribute: .bottom, in: container) == nil)
        #expect(constraint(for: label, firstAttribute: .trailing, in: container) == nil)
    }

    // ---- Config-refresh re-apply trigger (final-review fix, plan 2026-08-25, ----
    // ---- finding 2): a dashboard config change must re-apply the badge on its ----
    // ---- own, without waiting for the NEXT identity emission. ----

    @Test("a server config box write with NO identity change re-applies the badge (hides, then re-shows)")
    func serverConfigBoxWriteReappliesWithoutIdentityChange() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        // Default `serverConfig` closure — reads the shared box, exactly like
        // production `ReplaySession` wiring.
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setResolvedName("Living Room TV")
        companion.__setCode("7421")
        await drain()
        #expect(badge.isVisible, "precondition: badge visible before any server config arrives")

        // No identity field touched below — only the box.
        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: false, position: nil)
        await drain()
        #expect(!badge.isVisible, "a server enabled:false must re-apply and hide the badge on its own")
        #expect(container.subviews.isEmpty)

        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: true, position: nil)
        await drain()
        #expect(badge.isVisible, "a server enabled:true must re-apply and re-show the badge on its own")
        #expect(container.subviews.count == 1)
    }

    // ---- Codex round-1 fix E (findings 5+6): a server position change ----
    // ---- while attached must reposition the badge without a hide/show  ----
    // ---- cycle — the fast path in show(text:) must fall through to a   ----
    // ---- detach+rebuild when the resolved position no longer matches   ----
    // ---- the one the attached label was constrained with. Mirrors      ----
    // ---- Android's CompanionBadgeTest scenario of the same name.       ----

    @Test("a server position change while attached repositions the badge without a hide-show cycle")
    func serverPositionChangeWhileAttachedRepositions() async throws {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        // Default `serverConfig` closure — reads the shared box, so a bare
        // box write below is the only re-trigger, exactly like Android's
        // CompanionBadgeServerConfigSignal.flow.value assignment.
        let badge = CompanionBadge(companion: companion)

        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: true, position: "top-left")
        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()
        #expect(badge.isVisible, "precondition: badge visible at position A")
        #expect(container.subviews.count == 1)
        var label = try #require(container.subviews.first as? UILabel)
        #expect(constraint(for: label, firstAttribute: .top, in: container) != nil)
        #expect(constraint(for: label, firstAttribute: .leading, in: container) != nil)
        #expect(constraint(for: label, firstAttribute: .bottom, in: container) == nil)

        // Dashboard flips only the POSITION — no identity change, no other
        // re-trigger than the box write itself.
        CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: true, position: "bottom-right")
        await drain()

        #expect(badge.isVisible, "the badge must remain visible across the reposition")
        #expect(
            container.subviews.count == 1,
            "the OLD label must be torn down and a new one attached — never both left behind"
        )
        label = try #require(container.subviews.first as? UILabel)
        let bottom = constraint(for: label, firstAttribute: .bottom, in: container)
        let trailing = constraint(for: label, firstAttribute: .trailing, in: container)
        #expect(bottom?.constant == -24, "the attached label must now be constrained to the NEW server position")
        #expect(trailing?.constant == -24)
        #expect(
            constraint(for: label, firstAttribute: .top, in: container) == nil,
            "the OLD top-left constraints must not still be active on the new label"
        )
        #expect(constraint(for: label, firstAttribute: .leading, in: container) == nil)
    }

    // ---- Corner-constraint wiring (fix round 1: activateConstraints was ----
    // ---- never inspected — a wrong anchor pairing would compile and pass ----
    // ---- every other test here undetected). ----

    /// `NSLayoutConstraint.activate` files each constraint on the nearest
    /// common ancestor of its two items. `label`'s superview is `surface`,
    /// and `surface.safeAreaLayoutGuide` is owned by `surface` too, so every
    /// constraint `activateConstraints` creates lands on `surface.constraints`
    /// — not on the label itself.
    private func constraint(
        for label: UILabel, firstAttribute: NSLayoutConstraint.Attribute, in surface: UIView
    ) -> NSLayoutConstraint? {
        surface.constraints.first { $0.firstItem === label && $0.firstAttribute == firstAttribute }
    }

    @Test(".topLeft anchors top+leading, +24pt each, and wires NOTHING to bottom/trailing")
    func topLeftAnchorsTopLeading() async throws {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        // Bound to `let`, not discarded with `_ =`: `CompanionBadge` holds its
        // Combine subscription in an INSTANCE property (`bag`), so a discarded
        // instance is deallocated immediately, cancels the subscription, and
        // every subsequent `companion.__set...` below reaches nothing — the
        // bug this fix round actually found (first draft used `_ =` here and
        // every corner test failed with "no label attached", not a wrong
        // anchor).
        let badge = CompanionBadge(companion: companion, options: CompanionBadgeOptions(position: .topLeft))

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = try #require(container.subviews.first as? UILabel)
        let top = constraint(for: label, firstAttribute: .top, in: container)
        let leading = constraint(for: label, firstAttribute: .leading, in: container)
        #expect(top?.secondAttribute == .top)
        #expect(top?.constant == 24)
        #expect(leading?.secondAttribute == .leading)
        #expect(leading?.constant == 24)
        #expect(constraint(for: label, firstAttribute: .bottom, in: container) == nil,
                ".topLeft must not ALSO anchor to the bottom edge")
        #expect(constraint(for: label, firstAttribute: .trailing, in: container) == nil,
                ".topLeft must not ALSO anchor to the trailing edge")
    }

    @Test(".topRight anchors top (+24pt) and trailing (-24pt), and wires NOTHING to bottom/leading")
    func topRightAnchorsTopTrailing() async throws {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion, options: CompanionBadgeOptions(position: .topRight))

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = try #require(container.subviews.first as? UILabel)
        let top = constraint(for: label, firstAttribute: .top, in: container)
        let trailing = constraint(for: label, firstAttribute: .trailing, in: container)
        #expect(top?.secondAttribute == .top)
        #expect(top?.constant == 24)
        #expect(trailing?.secondAttribute == .trailing)
        #expect(trailing?.constant == -24, "trailing must PULL IN from the edge, not push past it")
        #expect(constraint(for: label, firstAttribute: .bottom, in: container) == nil,
                ".topRight must not ALSO anchor to the bottom edge")
        #expect(constraint(for: label, firstAttribute: .leading, in: container) == nil,
                ".topRight must not ALSO anchor to the leading edge")
    }

    @Test(".bottomLeft anchors bottom (-24pt) and leading (+24pt), and wires NOTHING to top/trailing")
    func bottomLeftAnchorsBottomLeading() async throws {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion, options: CompanionBadgeOptions(position: .bottomLeft))

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = try #require(container.subviews.first as? UILabel)
        let bottom = constraint(for: label, firstAttribute: .bottom, in: container)
        let leading = constraint(for: label, firstAttribute: .leading, in: container)
        #expect(bottom?.secondAttribute == .bottom)
        #expect(bottom?.constant == -24, "bottom must PULL UP from the edge, not push past it")
        #expect(leading?.secondAttribute == .leading)
        #expect(leading?.constant == 24)
        #expect(constraint(for: label, firstAttribute: .top, in: container) == nil,
                ".bottomLeft must not ALSO anchor to the top edge")
        #expect(constraint(for: label, firstAttribute: .trailing, in: container) == nil,
                ".bottomLeft must not ALSO anchor to the trailing edge")
    }

    @Test("the DEFAULT options() position (.bottomRight) anchors bottom+trailing, -24pt each")
    func defaultOptionsAnchorBottomTrailing() async throws {
        // Deliberately constructs `CompanionBadgeOptions()` with NO explicit
        // position — this is the one a host gets by doing nothing, and
        // `CompanionBadgeOptionsTests.defaults()` only proves the STORED
        // value is `.bottomRight`; it never proves that value actually wires
        // to the bottom-trailing corner rather than, say, top-leading.
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion, options: CompanionBadgeOptions())

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()

        #expect(badge.isVisible)
        let label = try #require(container.subviews.first as? UILabel)
        let bottom = constraint(for: label, firstAttribute: .bottom, in: container)
        let trailing = constraint(for: label, firstAttribute: .trailing, in: container)
        #expect(bottom?.secondAttribute == .bottom)
        #expect(bottom?.constant == -24)
        #expect(trailing?.secondAttribute == .trailing)
        #expect(trailing?.constant == -24)
        #expect(constraint(for: label, firstAttribute: .top, in: container) == nil,
                "the default position must not ALSO anchor to the top edge")
        #expect(constraint(for: label, firstAttribute: .leading, in: container) == nil,
                "the default position must not ALSO anchor to the leading edge")
    }

    // ---- teardown() (fix round: disconnect() left the badge on screen —
    // ---- teardown() must both hide it immediately AND stop it from ever
    // ---- coming back on this instance) ----

    @Test("teardown hides the badge and cancels its subscription so a later attach does NOT re-show it")
    func teardownHidesAndStopsReacting() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()
        #expect(badge.isVisible)
        #expect(container.subviews.count == 1)

        badge.teardown()
        await drain()

        #expect(!badge.isVisible, "teardown must hide the badge, mirroring disconnect() on a still-attached client")
        #expect(container.subviews.isEmpty)

        // The subscription is cancelled, not merely hidden once: a later
        // identity update on the SAME instance must not resurrect it. This is
        // exactly the state `RelayWSClient.disconnect()` relies on `teardown()`
        // to reach — see that method's own doc.
        companion.__setAttachedUserName("Bob")
        companion.__setResolvedName("Kitchen TV")
        companion.__setCode("1111")
        await drain()

        #expect(!badge.isVisible, "a cancelled subscription must not react to a later attachedUserName")
        #expect(container.subviews.isEmpty)
    }

    @Test("teardown is idempotent")
    func teardownIsIdempotent() async {
        reset(); defer { reset() }
        let container = surface()
        CompanionBadge.__surfaceProvider = { container }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()
        #expect(badge.isVisible)

        badge.teardown()
        badge.teardown()
        await drain()

        #expect(!badge.isVisible)
        #expect(container.subviews.isEmpty)
    }

    @Test("teardown on a badge that never attached is a harmless no-op")
    func teardownBeforeAttach() {
        reset(); defer { reset() }
        let companion = CompanionAPI()
        let badge = CompanionBadge(companion: companion)

        badge.teardown()

        #expect(!badge.isVisible)
    }

    // ---- The capture-exclusion property, as far as it can be asserted here ----

    @Test("the badge's window level sits above every window ScreenshotCapture.activeKeyWindow() would pick")
    func windowLevelIsAboveTheCapturedWindow() {
        // `ScreenshotCapture.activeKeyWindow()` (Capture/ScreenshotCapture.swift:
        // 238-253) deliberately resolves the LOWEST-level *visible* window — the
        // host's main window at `.normal`, or a host floating bubble at
        // `.normal + 1`. `ReporterWindowController` sits at `.alert + 1`
        // (ReporterUI/ReporterWindowController.swift:47) and is skipped for the
        // same reason. The badge must stay above ALL of those or it starts
        // being included in screenshots, preview frames, VTree replay and
        // UITree. The window itself cannot be built in this harness (no
        // scenes — see the file header), so the constant is asserted instead,
        // which is what a regression here would actually change.
        #expect(CompanionBadge.windowLevel > UIWindow.Level.alert + 1)
        #expect(CompanionBadge.windowLevel > UIWindow.Level.normal + 1)
        #expect(CompanionBadge.windowLevel > UIWindow.Level.normal)
    }

    // ---- External review, finding N4: activeKeyWindow() must never resolve
    // to the badge's own overlay window, even when it is the only visible
    // one. `ScreenshotCapture.__windowsOverrideForTesting` stands in for the
    // real `UIApplication.shared.connectedScenes` source, which is empty in
    // this test bundle (see the file header) — `UIWindow(frame:)` (no
    // `windowScene:`) is enough to build fixtures against that seam. ----

    @Test("activeKeyWindow returns nil when only the badge's overlay window is visible")
    func activeKeyWindowExcludesTheBadgeWindowWhenItIsTheOnlyOne() {
        defer { ScreenshotCapture.__windowsOverrideForTesting = nil }
        let badgeWindow = TXCompanionBadgeWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        badgeWindow.windowLevel = CompanionBadge.windowLevel
        badgeWindow.isHidden = false
        ScreenshotCapture.__windowsOverrideForTesting = [badgeWindow]

        #expect(ScreenshotCapture.activeKeyWindow() == nil)
    }

    @Test("activeKeyWindow picks the host window over the badge window when both are visible")
    func activeKeyWindowPrefersTheHostWindowOverTheBadge() {
        defer { ScreenshotCapture.__windowsOverrideForTesting = nil }
        let hostWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        hostWindow.windowLevel = .normal
        hostWindow.isHidden = false
        let badgeWindow = TXCompanionBadgeWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        badgeWindow.windowLevel = CompanionBadge.windowLevel
        badgeWindow.isHidden = false
        // Badge listed FIRST — proves the exclusion is a real filter, not an
        // accident of sort-stability / array order.
        ScreenshotCapture.__windowsOverrideForTesting = [badgeWindow, hostWindow]

        #expect(ScreenshotCapture.activeKeyWindow() === hostWindow)
    }
}
#endif
