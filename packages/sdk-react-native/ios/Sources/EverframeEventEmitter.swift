// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RCTEventEmitter subclass for the bridge's native → JS events (today: the
// extra-resolver ask, spec 2026-09-17).
//
// iOS RN event emission requires an `RCTEventEmitter` subclass (one per
// module — the base class enforces a single supportedEvents() list). We
// can't bolt event emission onto the existing `EverframeModule` because:
//
//   1. `EverframeModule` already has `RCT_EXPORT_MODULE(Everframe)` and
//      conforms to the codegen-generated `NativeEverframeSpec`. RCTEventEmitter
//      requires `requiresMainQueueSetup` + `supportedEvents` overrides on a
//      class that subclasses RCTEventEmitter — Objective-C single-inheritance.
//   2. Splitting concerns lets the JS facade use `new
//      NativeEventEmitter(NativeModules.EverframeEventEmitter)` (matching
//      the same idiom Sentry/Notifee/Reanimated all use).
//
// Registration is via `RCT_EXPORT_MODULE` from the `@objc(EverframeEventEmitter)`
// Swift class — CocoaPods + the podspec's source globs autodiscover it and
// expose it on `NativeModules.EverframeEventEmitter` from JS. No `.mm` shim
// needed: RCTEventEmitter's RN-side wiring (`addListener` / `removeListeners`
// / `supportedEvents`) is reachable from pure Swift via the inherited
// Objective-C base.
//
// Threading: `sendEvent(withName:body:)` is thread-safe across the RN core
// (the internal bridge enqueues the event on the JS thread); we forward
// straight to the emitter without a main-thread hop.
//
// Event names — duplicated in the JS facade (`src/runtime.ts`). Keep in
// lock-step.
import Foundation
import React

@objc(EverframeEventEmitter)
public final class EverframeEventEmitter: RCTEventEmitter {

    /// Fired right before native drains pending attachments for ANY report
    /// (spec 2026-09-17 setExtra-resolver): the plain in-app `openReporter()`
    /// and native shake both trigger this, since both funnel through `Everframe.shared.report.open()` →
    /// `__consumePendingAttachments()`. Only fires when JS has a resolver
    /// CURRENTLY registered (`EverframeBridge.setExtraResolverActive`) — see
    /// `EverframeBridge.awaitJsExtraResolve`. Payload: String — the
    /// correlation_id JS echoes back via `signalExtraResolverReady`.
    public static let extraResolveRequestedEvent = "everframe.extra.resolveRequested"

    /// Shared instance accessor — RN constructs the emitter via the standard
    /// module registry. The first init stores `self` here so `EverframeBridge`
    /// can dispatch into the live instance without going through a JS-side
    /// `NativeModules` lookup. Mirrors the pattern documented in the RN
    /// `RCTEventEmitter` headers (and used by `RNEventEmitter` exports across
    /// the ecosystem).
    @objc public static private(set) weak var shared: EverframeEventEmitter?

    public override init() {
        super.init()
        EverframeEventEmitter.shared = self
    }

    public override class func requiresMainQueueSetup() -> Bool {
        // Pure value-passing emitter — no UIKit reads at init time.
        return false
    }

    /// EVERY event this class can ever send MUST be listed here. RN's
    /// `RCTEventEmitter` silently drops `sendEvent(withName:)` for a name
    /// absent from this array — no throw, no warning on the JS side, the
    /// listener simply never fires. Adding a `…Event` constant above without
    /// adding it here is the exact failure this comment exists to prevent.
    public override func supportedEvents() -> [String] {
        return [
            Self.extraResolveRequestedEvent,
        ]
    }

    // MARK: - Static helpers used by EverframeBridge

    /// Forward an extra-resolver ask correlation id to JS (spec 2026-09-17
    /// setExtra-resolver). JS signals
    /// the bridge back via `signalExtraResolverReady` when it has pushed a
    /// freshly resolved value (or given up) for this correlation id.
    @objc public static func sendExtraResolveRequested(_ correlationId: String) {
        shared?.sendEvent(withName: extraResolveRequestedEvent, body: correlationId)
    }
}
