// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 8 — converts UIKit tap + navigation events into `.tap` / `.navigation`
// breadcrumbs via method swizzling. UIKit-only end to end (no AppKit/macOS
// analogue), so the ENTIRE file is compiled out on the macOS host build
// (`#if canImport(UIKit)`) — see the critical fact in the Task 8 brief:
// `swift test --package-path packages/sdk-ios` on macOS compiles out every
// body here, so its "green" is not evidence; only a run on an iOS Simulator
// (`xcodebuild test -scheme Everframe-Package -destination 'platform=iOS
// Simulator,name=iPhone 16'`) actually exercises this file.
//
// Swizzle mechanics: a block-based IMP REPLACEMENT
// (`class_getInstanceMethod` + `method_getImplementation` to capture the
// TRUE original IMP as a typed C function pointer, then
// `method_setImplementation` to install a new `imp_implementationWithBlock`
// IMP that calls the captured original THEN runs crumb logic), guarded by an
// install-once static flag per adapter (mirrors
// `LifecycleBreadcrumbObserver`/`ErrorBreadcrumbAdapter` in
// BreadcrumbAdapters.swift — Task 7).
//
// This is DELIBERATELY NOT the more commonly cited
// `method_exchangeImplementations` "swap two selectors, then call yourself
// by your own [now-original] name" idiom the Task 8 brief sketches. That
// idiom was tried FIRST here and reproduced a real, repeatable SIGSEGV
// (`swift_getObjectType` / null dereference, confirmed via
// `~/Library/Logs/DiagnosticReports/xctest-*.ips` crash reports) when
// exchanging `UIApplication.sendAction(_:to:from:for:)` on this toolchain
// (Xcode 26 host, iOS 26.4 Simulator runtime, `-target
// arm64-apple-ios15.0-simulator` deployment) — i.e. calling
// `self.<swappedSelectorName>(...)` from within the swapped method's own
// body, immediately after `method_exchangeImplementations`, crashed every
// time it was exercised, even before any of this file's own crumb logic
// ran. The "never crash the host" constraint is explicit and
// non-negotiable, so this file uses the IMP-capture-and-replace technique
// instead: it is externally indistinguishable (same install-once +
// always-call-through-first + crumb-after contract) and does not touch
// `self.<name>()` self-dispatch at all, eliminating that crash surface. See
// the Task 8 report for the full crash repro/triage notes.
//
// Never crash the host: swizzle bodies always call through FIRST (so any
// failure in our own crumb logic can never prevent the original UIKit
// behavior from running — the original IMP is invoked completely
// independently of, and before, any of our code), and crumb-derivation
// helpers use only optional-chaining / `as?` casts, never force-unwraps. If
// the original method can't be resolved at install time, `install()` is a
// silent no-op (no swizzle, no crumbs for that adapter, but the host is
// completely unaffected).
#if canImport(UIKit)
import Foundation
import ObjectiveC.runtime
import EverframeProtocol
import UIKit

// MARK: - Tap (kind: .tap)

/// Bridges `UIApplication.sendAction(_:to:from:for:)` — UIKit's single
/// chokepoint for every `UIControl` target-action dispatch (button taps,
/// switches, sliders, ...) — into `.tap` crumbs. `sendAction` always runs on
/// the main thread (it's part of the touch-handling / responder-chain path),
/// so `Thread.isMainThread` is checked defensively before touching any
/// `@MainActor` state rather than assumed.
///
/// EverframeReporter-UI's own controls (the bug-report composer, annotation toolbar,
/// etc.) DO reach the LIVE buffer through this same swizzle — nothing here
/// special-cases them. It is `BreadcrumbRingBuffer.freeze()` at reporter-open
/// (Task 6) that keeps them out of the SHIPPED snapshot, by freezing the
/// chain before the reporter UI's own taps can land. Same doctrine as web
/// (packages/sdk-react's bridge freezes before mounting the composer).
enum TapBreadcrumbAdapter {
    /// C calling convention matching `-(BOOL)sendAction:(SEL)action
    /// to:(id)target from:(id)sender forEvent:(UIEvent*)event` — `(self,
    /// action, target, sender, event) -> Bool`. `_cmd` is intentionally
    /// omitted (matches how the ORIGINAL IMP is actually invoked: its `_cmd`
    /// slot is bound to whatever selector was resolved through, which stays
    /// `sendAction:to:from:forEvent:` regardless of who calls it).
    fileprivate typealias SendActionFn =
        @convention(c) (UIApplication, Selector, Selector, AnyObject?, AnyObject?, UIEvent?) -> Bool

    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed = false

    /// Timestamp of the UIEvent whose sendAction most recently produced a
    /// tap crumb. UIControl target-action fires INSIDE the original
    /// UIWindow.sendEvent call-through, so by the time the window-level
    /// adapter's post-call logic runs, this is already stamped for the same
    /// UIEvent — the window adapter suppresses its own (poorer: no control
    /// semantics) crumb on a timestamp match. Main-thread-confined like
    /// NavigationBreadcrumbAdapter.previousClassName.
    nonisolated(unsafe) private(set) static var lastActionEventTimestamp: TimeInterval?

    /// Test-only flag.
    static var installedForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Install-once. Wired from `Everframe.start(config:)` (via
    /// `BreadcrumbTapNavAdapters.install()`) after the kill-gate is set. A
    /// second call is a no-op — the original IMP is captured exactly once,
    /// so re-running this can never wrap an already-wrapped IMP (which would
    /// otherwise double-fire crumb logic per real action).
    static func install() {
        lock.lock(); defer { lock.unlock() }
        guard !installed else { return }
        guard
            let method = class_getInstanceMethod(
                UIApplication.self, #selector(UIApplication.sendAction(_:to:from:for:)))
        else { return }
        installed = true
        let sel = #selector(UIApplication.sendAction(_:to:from:for:))
        // Captured into a closure-local `let`, NOT a static — invoked
        // directly (never via `self.<name>()` self-dispatch) so the
        // call-through path has no dependency on Swift's dynamic-self-call
        // ABI (see the file header for why that matters).
        let originalFn = unsafeBitCast(method_getImplementation(method), to: SendActionFn.self)
        let block: @convention(block) (UIApplication, Selector, AnyObject?, AnyObject?, UIEvent?) ->
            Bool = { app, action, target, sender, event in
                let snapshot: InteractionTargetSnapshot? = Thread.isMainThread ? MainActor.assumeIsolated {
                    guard BreadcrumbRingBuffer.shared.isKindEnabled(.tap),
                          !TapBreadcrumbAdapter.isIndirectTextInputAction(sender: sender, event: event)
                    else { return nil }
                    let revision = BreadcrumbRingBuffer.shared.captureRevision()
                    let (label, data) = TapBreadcrumbAdapter.deriveLabelAndData(sender: sender)
                    return InteractionTargetSnapshot(label: label, data: data, captureRevision: revision)
                } : nil
                let control: InteractionControlChange? = Thread.isMainThread ? MainActor.assumeIsolated {
                    guard let view = sender as? UIView else { return nil }
                    return InteractionControlAdapter.shared.beginAction(view, event: event)
                } : nil
                let result = originalFn(app, sel, action, target, sender, event)
                if let control, Thread.isMainThread { MainActor.assumeIsolated { InteractionControlAdapter.shared.complete(control) } }
                if let snapshot, Thread.isMainThread {
                    MainActor.assumeIsolated {
                        TapBreadcrumbAdapter.recordTap(sender: sender, eventTimestamp: event?.timestamp, snapshot: snapshot)
                    }
                }
                return result
            }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }

    /// Test-only reset seam. Does NOT touch `installed`/re-swizzle (the IMP
    /// replacement above is not meant to be applied twice — see `install`'s
    /// doc comment); clears `lastActionEventTimestamp` so tests get a clean
    /// "no prior sendAction" starting point.
    static func __resetForTesting() {
        lastActionEventTimestamp = nil
    }

    /// Test-only seam: drives the CURRENTLY INSTALLED
    /// `sendAction:to:from:forEvent:` implementation directly (whatever
    /// `install()` put there), exactly as UIKit would if the call actually
    /// reached that selector.
    ///
    /// Why this exists: verified via targeted debug instrumentation (see the
    /// Task 8 report) that in THIS repo's headless SwiftPM test bundle —
    /// which has no connected `UIWindowScene`
    /// (`UIApplication.shared.connectedScenes.count == 0` even after
    /// `UIWindow.makeKeyAndVisible()` + a run-loop spin) — neither
    /// `UIApplication.shared.sendAction(...)` nor `UIControl.sendActions(for:)`
    /// actually dispatch through the `sendAction:to:from:forEvent:` selector
    /// at all (confirmed by a print placed as the literal first statement of
    /// the installed block never firing). Modern UIKit's target-action
    /// machinery silently no-ops without a live scene — this is an iOS 13+
    /// platform behavior, not a bug in this adapter. This seam calls the
    /// exact same installed implementation a real touch event would reach in
    /// an app with a live scene, so it exercises this adapter's REAL
    /// call-through + crumb-recording code, not a stub.
    static func __invokeInstalledSendActionForTesting(
        action: Selector, target: AnyObject?, sender: AnyObject?, event: UIEvent?
    ) -> Bool {
        guard
            let method = class_getInstanceMethod(
                UIApplication.self, #selector(UIApplication.sendAction(_:to:from:for:)))
        else { return false }
        let fn = unsafeBitCast(method_getImplementation(method), to: SendActionFn.self)
        return fn(
            UIApplication.shared, #selector(UIApplication.sendAction(_:to:from:for:)), action,
            target, sender, event)
    }

    /// True when a UIControl-and-text-input sender's action was NOT caused
    /// by a direct touch on the control — the per-KEYSTROKE channel
    /// (2026-07-14 finding): RN's `RCTUITextField` registers a target for
    /// `.editingChanged`, so every typed character routes through
    /// `sendAction` with the text field as sender and produced one
    /// `tap <field>` crumb per key press. Typing a sentence flooded the ring
    /// buffer with dozens of identical crumbs and leaked keystroke cadence.
    ///
    /// The rule demands positive proof of a real tap: an `.ended` touch
    /// whose location falls inside the control (`point(inside:)`, so
    /// custom hit-area overrides are honored; `location(in:)` converts
    /// across windows via screen coordinates, so a software-keyboard touch
    /// resolves OUTSIDE the field). Keystroke-driven `editingChanged`
    /// carries either no event, a presses event, or keyboard-window
    /// touches — all filtered. A genuine tap on the field still crumbs
    /// once, via this path when a target-action fires with the in-bounds
    /// touch, or via WindowTapBreadcrumbAdapter's hit-test otherwise.
    ///
    /// DELIBERATELY scoped to text inputs (`UIControl & UITextInput` —
    /// UITextField, incl. RN's subclass; UITextView is not a UIControl and
    /// has no target-action to spam). Buttons/switches keep the permissive
    /// behavior: their actions cannot fire per-keystroke, and demanding
    /// touch proof would break tvOS (remote presses carry no touches) and
    /// accessibility activation (nil event).
    @MainActor
    static func isIndirectTextInputAction(sender: AnyObject?, event: UIEvent?) -> Bool {
        guard let control = sender as? UIControl, control is UITextInput else { return false }
        guard let event, event.type == .touches, let touches = event.allTouches else { return true }
        return !touches.contains { touch in
            touch.phase == .ended
                && control.point(inside: touch.location(in: control), with: nil)
        }
    }

    /// Called from the swizzled `sendAction` AFTER the original has already
    /// run (call-through-first — see file header) and after the
    /// `isIndirectTextInputAction` keystroke filter. The `isKindEnabled`
    /// pre-check is a hot-path optimization (skip label/reflection work
    /// entirely when `.tap` is off); `BreadcrumbRingBuffer.add` gates again
    /// for correctness.
    @MainActor
    static func recordTap(sender: Any?, eventTimestamp: TimeInterval?, snapshot: InteractionTargetSnapshot? = nil) {
        guard BreadcrumbRingBuffer.shared.isKindEnabled(.tap) else { return }
        let value = WindowTapBreadcrumbAdapter.maskedDispatchSnapshot(eventTimestamp: eventTimestamp) ?? snapshot ?? {
            let revision = BreadcrumbRingBuffer.shared.captureRevision()
            let (label, data) = deriveLabelAndData(sender: sender)
            return InteractionTargetSnapshot(label: label, data: data, captureRevision: revision)
        }()
        guard value.captureRevision == BreadcrumbRingBuffer.shared.captureRevision() else { return }
        lastActionEventTimestamp = eventTimestamp
        BreadcrumbRingBuffer.shared.addInteraction(message: "tap \(value.label)", data: value.data, captureRevision: value.captureRevision)
    }

    /// Pure-ish derivation (only reads UIKit state, never mutates) — kept as
    /// its own testable unit rather than inlined into `recordTap`.
    @MainActor
    static func deriveLabelAndData(sender: Any?) -> (label: String, data: [String: EverframeJSONAny]) {
        guard let view = sender as? UIView else {
            // Non-view senders (e.g. a UIBarButtonItem) can't be walked for
            // ancestor-sensitivity — degrade to a minimal, still-safe label
            // rather than dropping the crumb entirely.
            let className = sender.map { String(describing: type(of: $0)) } ?? "unknown"
            // `accessibilityLabel` is an NSObject category (UIAccessibility.h);
            // `accessibilityIdentifier` is a separate, narrower protocol
            // (`UIAccessibilityIdentification`) only some NSObject subclasses
            // (UIView, UIBarButtonItem, UIViewController, ...) adopt via a
            // PER-CLASS category rather than a blanket NSObject one.
            //
            // Deliberately NOT `sender as? UIAccessibilityIdentification`:
            // verified via this file's own test suite that on this toolchain
            // (Xcode 26 host / iOS 26 Simulator runtime) that conditional
            // cast TRAPS — does not merely fail to nil — when `sender` is a
            // `UIBarButtonItem` ("Could not cast value of type
            // 'UIBarButtonItem' ... to 'UIAccessibilityIdentification'"),
            // which would violate this file's "never crash the host"
            // contract for one of the most common non-view senders there
            // is. `responds(to:)` + `perform(_:)` is pure Objective-C
            // runtime introspection — it can only return false/nil, never
            // throw or trap — so it's used instead.
            let obj = sender as? NSObject
            let identifierSelector = Selector(("accessibilityIdentifier"))
            let identifier: String? =
                (obj?.responds(to: identifierSelector) == true)
                ? (obj?.perform(identifierSelector)?.takeUnretainedValue() as? String)
                : nil
            let label =
                nonEmpty(obj?.accessibilityLabel) ?? nonEmpty(identifier)
                ?? className
            return (label, BreadcrumbRingBuffer.coerceHostData(["control": className]))
        }

        let snapshot = InteractionTargetResolver.resolve(view)
        return (snapshot.label, snapshot.data)
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// UTF-16-unit cap (matches `BreadcrumbRingBuffer`'s own message-capping
    /// convention — JS `.length` parity).
    fileprivate static func capUTF16(_ s: String, _ n: Int) -> String {
        interactionTargetText(s, max: n) ?? ""
    }
}

// MARK: - Navigation (kind: .navigation)

/// Bridges `UIViewController.viewDidAppear(_:)` into `.navigation` crumbs.
/// Emits only when the appearing VC is either a child of a
/// `UINavigationController` (push/pop) or `isBeingPresented` (modal
/// present) — this excludes tab-switch re-appearances, container-VC
/// internal churn, etc. `viewDidAppear` always runs on the main thread (a
/// UIKit lifecycle callback), so no explicit thread-check is needed the way
/// `sendAction` gets one — the whole call chain is already main-thread-only
/// by UIKit's own contract.
///
/// **SwiftUI is a documented non-goal**: pure-SwiftUI navigation
/// (`NavigationStack`, `NavigationLink`) never routes through a
/// `UIViewController.viewDidAppear` — SwiftUI's navigation stack is not
/// backed by discrete, swizzlable `UIViewController` instances the way
/// UIKit's `UINavigationController` is. Hosts using SwiftUI-only navigation
/// get NO automatic `.navigation` crumbs from this adapter; the escape hatch
/// is `Everframe.addBreadcrumb(kind: .navigation, ...)` called manually from
/// `.onAppear`/`NavigationStack` path-change observers. This is the same
/// known gap already tracked for replay (native-replay-swiftui-gap: vtree
/// replay is rich on UIKit, thin on pure SwiftUI) — SwiftUI-only screens are
/// a second-class citizen throughout this iOS capture stack, not just here.
///
/// Since the 2026-07-14 screen-markers spec, SwiftUI hosts have a
/// first-class escape hatch: `Everframe.shared.recordScreen("Screen Name")` from
/// `.onAppear`, which feeds the same from→to chain as this adapter.
enum NavigationBreadcrumbAdapter {
    /// `-(void)viewDidAppear:(BOOL)animated` — `(self, animated) -> Void`.
    fileprivate typealias ViewDidAppearFn = @convention(c) (UIViewController, Selector, Bool) -> Void

    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed = false
    /// The class name of the most recently appeared qualifying VC — the
    /// "from" half of the NEXT qualifying transition. `nil` until the first
    /// qualifying `viewDidAppear` lands (there is no "from" for the very
    /// first screen).
    ///
    /// Previous-screen tracking is deliberately GLOBAL and chronological —
    /// the trail answers "what screen did the user go from/to", so a tab
    /// switch correctly reads TabA → TabB; per-stack scoping would hide it.
    /// (Spec 2026-07-08 ruling.)
    nonisolated(unsafe) private static var previousClassName: String?

    /// Test-only flag.
    static var installedForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Install-once. Wired from `Everframe.start(config:)` (via
    /// `BreadcrumbTapNavAdapters.install()`) after the kill-gate is set. See
    /// `TapBreadcrumbAdapter.install()`'s doc comment for why this is an IMP
    /// capture-and-replace rather than a `method_exchangeImplementations`
    /// swap.
    static func install() {
        lock.lock(); defer { lock.unlock() }
        guard !installed else { return }
        guard
            let method = class_getInstanceMethod(
                UIViewController.self, #selector(UIViewController.viewDidAppear(_:)))
        else { return }
        installed = true
        // See `TapBreadcrumbAdapter.install()`'s comment on the same
        // pattern — a closure-local `let`, not a static.
        let originalFn = unsafeBitCast(method_getImplementation(method), to: ViewDidAppearFn.self)
        let sel = #selector(UIViewController.viewDidAppear(_:))
        let block: @convention(block) (UIViewController, Bool) -> Void = { vc, animated in
            originalFn(vc, sel, animated)
            // `viewDidAppear` is a UIKit lifecycle callback and always runs
            // on the main thread by contract; `assumeIsolated` bridges into
            // `@MainActor`-isolated state synchronously without an `await`.
            if Thread.isMainThread {
                MainActor.assumeIsolated {
                    NavigationBreadcrumbAdapter.recordAppearance(of: vc)
                }
            }
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }

    /// Test-only reset seam — clears the tracked "previous" VC name so tests
    /// get a clean "no from yet" starting point. Does NOT re-swizzle (see
    /// `install`'s doc comment).
    static func __resetForTesting() {
        lock.lock(); defer { lock.unlock() }
        previousClassName = nil
    }

    /// Called from the swizzled `viewDidAppear` AFTER the original has
    /// already run. The qualifying guard stays here (UIKit-specific); the
    /// transition core below is shared with `Everframe.recordScreen`.
    @MainActor
    static func recordAppearance(of vc: UIViewController) {
        guard vc.parent is UINavigationController || vc.isBeingPresented else { return }
        InteractionTargetScreenState.recordNative(String(describing: type(of: vc)))
        recordTransition(toName: String(describing: type(of: vc)))
    }

    /// The single transition core (spec 2026-07-14 — screen markers). Owns
    /// kind-gating (BEFORE state update), the global previous-screen state,
    /// `A → A` self-transition suppression (new on iOS — parity with the
    /// Android twin; absorbs marker re-emits), and crumb emission.
    /// `from`/`to` win over `hostData` keys on collision. Thread-safe —
    /// callable off-main (RN bridge thread).
    static func recordTransition(toName: String, hostData: [String: Any]? = nil) {
        guard BreadcrumbRingBuffer.shared.isKindEnabled(.navigation) else { return }
        lock.lock()
        let fromName = previousClassName
        previousClassName = toName
        lock.unlock()
        // No "from" yet (first screen this process has seen).
        guard let fromName, fromName != toName else { return }
        var dict: [String: Any] = hostData ?? [:]
        dict["from"] = fromName
        dict["to"] = toName
        BreadcrumbRingBuffer.shared.add(
            kind: .navigation,
            message: "\(fromName) → \(toName)",
            data: BreadcrumbRingBuffer.coerceHostData(dict))
    }
}

// MARK: - Window-level tap (kind: .tap) — RN/SwiftUI-visible (spec 2026-07-14)

/// Bridges `UIWindow.sendEvent(_:)` — the chokepoint EVERY touch passes
/// through regardless of framework — into `.tap` crumbs. This is the iOS
/// analogue of Android's `EFWindowCallbackWrapper.dispatchTouchEvent`
/// ACTION_UP hit-test: React Native (gesture recognizers) and SwiftUI
/// (hosting-view gestures) never reach `UIApplication.sendAction`, so the
/// target-action adapter above is structurally blind to them.
///
/// Dedup: a UIControl tap produces BOTH a sendAction crumb (richer — names
/// the control) and an ended touch here. sendAction fires synchronously
/// inside the original sendEvent call-through, so
/// `TapBreadcrumbAdapter.lastActionEventTimestamp` is already stamped when
/// this adapter's post-call logic compares timestamps.
///
/// EverframeReporter-UI taps reach the LIVE buffer like every other tap — it's the
/// freeze-at-reporter-open doctrine that keeps them out of the shipped
/// snapshot (see TapBreadcrumbAdapter's header).

/// Same-button repeat suppression for remote-press crumbs. A held d-pad
/// edge repeats presses far faster than a human decision — one crumb per
/// 300 ms per button keeps the trail meaningful without starving the ring.
/// Main-thread-confined like `TapBreadcrumbAdapter.lastActionEventTimestamp`
/// above — every production call site is the `@MainActor recordEndedPress`,
/// and tests drive it synchronously from the main thread without hopping
/// actors, so the backing storage stays `nonisolated(unsafe)` rather than
/// actor-isolated.
enum PressCrumbRateLimiter {
    private static let windowSeconds: TimeInterval = 0.3
    nonisolated(unsafe) private static var lastButton: String?
    nonisolated(unsafe) private static var lastAt: TimeInterval = 0

    static func shouldRecord(
        button: String,
        now: TimeInterval = Date().timeIntervalSinceReferenceDate
    ) -> Bool {
        if button == lastButton, now - lastAt < windowSeconds { return false }
        lastButton = button
        lastAt = now
        return true
    }

    static func __resetForTesting() {
        lastButton = nil
        lastAt = 0
    }
}

enum WindowTapBreadcrumbAdapter {
    private final class PressStarts: NSObject { var snapshots: [Int: InteractionTargetSnapshot] = [:] }
    @MainActor private static let pressStarts = NSMapTable<UIWindow, PressStarts>(keyOptions: .weakMemory, valueOptions: .strongMemory)
    @MainActor static func snapshotForPress(type: UIPress.PressType, phase: UIPress.Phase, focusedView: UIView?, window: UIWindow) -> InteractionTargetSnapshot? {
        let starts = pressStarts.object(forKey: window) ?? PressStarts()
        pressStarts.setObject(starts, forKey: window)
        switch phase {
        case .began:
            starts.snapshots[type.rawValue] = focusedView.map { InteractionTargetResolver.resolve($0) }
                ?? InteractionTargetSnapshot(label: "screen", data: [:])
            return nil
        case .ended:
            return starts.snapshots.removeValue(forKey: type.rawValue)
                ?? focusedView.map { InteractionTargetResolver.resolve($0) }
                ?? InteractionTargetSnapshot(label: "screen", data: [:])
        case .cancelled:
            starts.snapshots.removeValue(forKey: type.rawValue)
            return nil
        default: return nil
        }
    }

    @MainActor private static var dispatchSnapshot: (TimeInterval, InteractionTargetSnapshot)?
    @MainActor private(set) static var interactionDispatchRevision: UInt64?
    @MainActor static func withDispatchSnapshot(_ snapshot: InteractionTargetSnapshot?, eventTimestamp: TimeInterval, _ body: () -> Void) {
        let previous = dispatchSnapshot
        let previousRevision = interactionDispatchRevision
        interactionDispatchRevision = snapshot?.captureRevision ?? BreadcrumbRingBuffer.shared.captureRevision()
        dispatchSnapshot = snapshot.map { (eventTimestamp, $0) }
        defer { dispatchSnapshot = previous; interactionDispatchRevision = previousRevision }
        body()
    }
    @MainActor static func maskedDispatchSnapshot(eventTimestamp: TimeInterval?) -> InteractionTargetSnapshot? {
        guard let (timestamp, snapshot) = dispatchSnapshot,
              timestamp == eventTimestamp, snapshot.data["masked"]?.value as? Bool == true else { return nil }
        return snapshot
    }

    /// `-(void)sendEvent:(UIEvent *)event` — `(self, event) -> Void`.
    fileprivate typealias SendEventFn = @convention(c) (UIWindow, Selector, UIEvent) -> Void

    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed = false

    /// Test-only flag.
    static var installedForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Install-once. See TapBreadcrumbAdapter.install()'s doc comment for
    /// why IMP capture-and-replace, never method_exchangeImplementations.
    static func install() {
        lock.lock(); defer { lock.unlock() }
        guard !installed else { return }
        guard
            let method = class_getInstanceMethod(
                UIWindow.self, #selector(UIWindow.sendEvent(_:)))
        else { return }
        installed = true
        let sel = #selector(UIWindow.sendEvent(_:))
        let originalFn = unsafeBitCast(method_getImplementation(method), to: SendEventFn.self)
        let block: @convention(block) (UIWindow, UIEvent) -> Void = { window, event in
            guard Thread.isMainThread else { originalFn(window, sel, event); return }
            MainActor.assumeIsolated {
                #if os(tvOS)
                // The quick-capture remote gesture reads presses first. A
                // disarmed session answers `needsPresses` with lock reads and
                // builds nothing. A press it consumes (a linked device's fired
                // gesture) is never delivered and leaves no crumb. Match the
                // class: keyboard events are a `UIPressesEvent` subclass.
                if let presses = event as? UIPressesEvent, TvGestureInput.shared.needsPresses,
                   !TvGestureInput.shared.handle(TvGestureInput.keyEvents(presses.allPresses), window: window) {
                    return
                }
                #endif
                var snapshot: InteractionTargetSnapshot?
                var remoteButton: String?
                if BreadcrumbRingBuffer.shared.isKindEnabled(.tap) {
                    #if os(tvOS)
                    if event.type == .presses, let presses = event as? UIPressesEvent {
                        for press in presses.allPresses {
                            if let value = snapshotForPress(type: press.type, phase: press.phase, focusedView: focusedView(in: window), window: window) {
                                remoteButton = pressName(press.type)
                                snapshot = value
                            }
                        }
                    }
                    #endif
                    if event.type == .touches, let ended = event.allTouches?.first(where: { $0.phase == .ended }) {
                        let view = ended.view ?? window.hitTest(ended.location(in: window), with: nil) ?? window
                        snapshot = InteractionTargetResolver.resolve(view)
                    }
                } else { pressStarts.removeObject(forKey: window) }
                #if targetEnvironment(simulator)
                // Simulator quick capture reads key-downs here, before delivery,
                // so its text-field guard sees the focus the key was typed into
                // (a field may resign in its own editing callback). `isArmed` is
                // checked before the presses are read, so a disarmed session
                // never builds a key event. Match the class, not `event.type`:
                // UIKit delivers hardware-keyboard keys as
                // `UIPhysicalKeyboardEvent`, a `UIPressesEvent` subclass whose
                // `type` is not `.presses`.
                var quickCaptureKeys: QuickCapture.KeyDelivery?
                if let presses = event as? UIPressesEvent, QuickCapture.shared.isArmed {
                    quickCaptureKeys = QuickCapture.shared.prepareKeyDelivery(
                        quickCaptureKeyEvents(presses.allPresses).map { ($0.0, Optional($0.1)) }, window: window)
                }
                #endif
                // Capture immutable evidence before callbacks mutate views, screen, or focus.
                // Emission stays after delivery so sendAction deduplication remains effective.
                withDispatchSnapshot(snapshot, eventTimestamp: event.timestamp) {
                    InteractionControlAdapter.shared.beforeEvent(event, window: window)
                    InteractionScrollAdapter.shared.beforeEvent(event, window: window)
                    originalFn(window, sel, event)
                    InteractionScrollAdapter.shared.afterEvent(event)
                }
                #if os(iOS) && !targetEnvironment(macCatalyst)
                if event.type == .motion, event.subtype == .motionShake {
                    // Quick capture, the reporter (when `shakeToReport` allows
                    // it) or a device-link hello, by the mode rule.
                    CaptureGestureRouter.live.handle(.shake)
                }
                #endif
                #if targetEnvironment(simulator)
                // The key was delivered unchanged above; now it may fire. Device
                // builds compile none of this.
                if let quickCaptureKeys { QuickCapture.shared.completeKeyDelivery(quickCaptureKeys) }
                #endif
                if let snapshot { recordSnapshot(snapshot, eventTimestamp: event.timestamp, remoteButton: remoteButton) }
            }
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }

    #if targetEnvironment(simulator)
    /// Hardware-keyboard presses that just went down, as quick-capture key events,
    /// each with the identity `QuickCapture` dedups on. `systemUptime` is
    /// monotonic, which the hotkey matcher's window needs.
    ///
    /// Dedup is on press identity plus `press.timestamp`, not on
    /// `window.isKeyWindow`. Whichever window UIKit hands a key event to, the
    /// press object and its timestamp are the same, so a press seen twice is
    /// dropped without deciding which window owns it. A key-window check would
    /// depend on which window is key at the moment of delivery, and would drop
    /// the only delivery if UIKit ever routed a key to a window that is not
    /// key. The cost is a scan of at most `CapturePressDeduplicator.capacity`
    /// entries per key-down, and only while quick capture is armed.
    @MainActor
    static func quickCaptureKeyEvents(_ presses: Set<UIPress>) -> [(CaptureKeyEvent, CapturePressID)] {
        let now = ProcessInfo.processInfo.systemUptime
        return presses.compactMap { press -> (CaptureKeyEvent, CapturePressID)? in
            guard let key = press.key, let event = CaptureKeyMapping.event(
                keyCode: key.keyCode.rawValue,
                charactersIgnoringModifiers: key.charactersIgnoringModifiers,
                modifierFlags: key.modifierFlags.rawValue,
                began: press.phase == .began,
                at: now
            ) else { return nil }
            return (event, CapturePressID(press: ObjectIdentifier(press), timestamp: press.timestamp))
        }
    }
    #endif

    /// The entire crumb path minus the touch extractor above — driven
    /// directly by tests (UIEvent/UITouch are not constructible headlessly).
    @MainActor
    static func recordEndedTouch(
        view: UIView?, location: CGPoint, window: UIWindow, eventTimestamp: TimeInterval
    ) {
        let target = view ?? window.hitTest(location, with: nil) ?? window
        recordSnapshot(InteractionTargetResolver.resolve(target), eventTimestamp: eventTimestamp)
    }

    @MainActor
    static func recordSnapshot(_ snapshot: InteractionTargetSnapshot, eventTimestamp: TimeInterval, remoteButton: String? = nil) {
        guard BreadcrumbRingBuffer.shared.isKindEnabled(.tap),
              snapshot.captureRevision == BreadcrumbRingBuffer.shared.captureRevision(),
              TapBreadcrumbAdapter.lastActionEventTimestamp != eventTimestamp else { return }
        var data = snapshot.data
        let message: String
        if let button = remoteButton {
            if data["origin"]?.value as? String == "reporter" {
                let trigger = data["trigger"]?.value as? String
                let activation = (trigger == "button" && button == "select") || (trigger == "menu" && button == "menu")
                if !activation { data.removeValue(forKey: "origin"); data.removeValue(forKey: "trigger") }
            }
            guard PressCrumbRateLimiter.shouldRecord(button: button) else { return }
            data.merge(BreadcrumbRingBuffer.coerceHostData(["inputType": "remote", "button": button])) { _, new in new }
            message = "press \(button) — \(snapshot.label)"
        } else { message = "tap \(snapshot.label)" }
        BreadcrumbRingBuffer.shared.addInteraction(message: message, data: data, captureRevision: snapshot.captureRevision)
    }

    @MainActor
    static func descendantText(of view: UIView, maxDepth: Int = 6) -> String? {
        InteractionTargetResolver.descendantText(view, maxDepth: maxDepth).map { TapBreadcrumbAdapter.capUTF16($0, 48) }
    }

    static func pressName(_ type: UIPress.PressType) -> String {
        switch type {
        case .select: return "select"
        case .menu: return "menu"
        case .playPause: return "playPause"
        case .upArrow: return "up"
        case .downArrow: return "down"
        case .leftArrow: return "left"
        case .rightArrow: return "right"
        case .pageUp: return "pageUp"
        case .pageDown: return "pageDown"
        @unknown default: return "button"
        }
    }

    /// The view holding focus in `window`'s focus system. Never asks
    /// `UIScreen.focusedView`: UIKit aborts with "screen-based focus
    /// unsupported" when the host app uses scene-based focus (the UIScene
    /// lifecycle), which made every remote press crash the app.
    @MainActor
    static func focusedView(in window: UIWindow) -> UIView? {
        containingView(of: UIFocusSystem.focusSystem(for: window)?.focusedItem)
    }

    /// The focused item when it is a view, otherwise the nearest view that
    /// contains it (the SKView of a focused SpriteKit node, for example),
    /// which is what `UIScreen.focusedView` reported.
    @MainActor
    static func containingView(of item: UIFocusEnvironment?) -> UIView? {
        var environment = item
        while let current = environment, !(current is UIView) {
            environment = current.parentFocusEnvironment
        }
        return environment as? UIView
    }

    /// tvOS remote-press crumb: same `.tap` kind as touch crumbs, tagged
    /// `inputType: remote` so dashboards need no schema work. Compiled on
    /// every UIKit platform (iOS-simulator tests drive it directly); only
    /// the sendEvent hook below is tvOS-gated.
    @MainActor
    static func recordEndedPress(
        type: UIPress.PressType, focusedView: UIView?, eventTimestamp: TimeInterval
    ) {
        guard BreadcrumbRingBuffer.shared.isKindEnabled(.tap) else { return }
        let snapshot = focusedView.map { InteractionTargetResolver.resolve($0) }
            ?? InteractionTargetSnapshot(label: "screen", data: [:])
        recordSnapshot(snapshot, eventTimestamp: eventTimestamp, remoteButton: pressName(type))
    }

    /// The deepest hit view is often an unlabeled leaf (an RN paragraph
    /// inside a Pressable, a bare container). Prefer the nearest
    /// self-or-ancestor that is sensitive (so deriveLabelAndData masks it),
    /// carries an accessibilityLabel, or reads as a control; fall back to
    /// the hit view itself.
    @MainActor
    static func resolveLabelBearer(from view: UIView) -> UIView {
        var current: UIView? = view
        while let v = current {
            if SensitiveRectRegistry.isSensitive(v) { return v }
            if let l = v.accessibilityLabel, !l.isEmpty { return v }
            if v.accessibilityTraits.contains(.button) || v is UIControl { return v }
            current = v.superview
        }
        return view
    }
}

// MARK: - Install orchestrator

enum BreadcrumbTapNavAdapters {
    /// Wired from `Everframe.start(config:)` immediately after
    /// `BreadcrumbAdapters.install()` (Task 7). Install-once for all three
    /// sub-adapters — safe across repeated `start()` calls.
    static func install() {
        TapBreadcrumbAdapter.install()
        NavigationBreadcrumbAdapter.install()
        WindowTapBreadcrumbAdapter.install()
    }
}
#endif
