// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-11 — RCTEventEmitter subclass for the phone-companion bridge.
//
// iOS RN event emission requires an `RCTEventEmitter` subclass (one per
// module — the base class enforces a single supportedEvents() list). We
// can't bolt event emission onto the existing `TraceItXModule` because:
//
//   1. `TraceItXModule` already has `RCT_EXPORT_MODULE(TraceItX)` and
//      conforms to the codegen-generated `NativeTraceItXSpec`. RCTEventEmitter
//      requires `requiresMainQueueSetup` + `supportedEvents` overrides on a
//      class that subclasses RCTEventEmitter — Objective-C single-inheritance.
//   2. Splitting concerns lets the JS facade use `new
//      NativeEventEmitter(NativeModules.TraceItXEventEmitter)` (matching
//      the same idiom Sentry/Notifee/Reanimated all use).
//
// Registration is via `RCT_EXPORT_MODULE` from the `@objc(TraceItXEventEmitter)`
// Swift class — CocoaPods + the podspec's source globs autodiscover it and
// expose it on `NativeModules.TraceItXEventEmitter` from JS. No `.mm` shim
// needed: RCTEventEmitter's RN-side wiring (`addListener` / `removeListeners`
// / `supportedEvents`) is reachable from pure Swift via the inherited
// Objective-C base.
//
// Threading: `sendEvent(withName:body:)` is thread-safe across the RN core
// (the internal bridge enqueues the event on the JS thread). Combine sinks
// installed in `TraceItXBridge` may fire on the URLSession delegate queue;
// we forward straight to the emitter without a main-thread hop.
//
// Event names — duplicated in JS facade `src/companion.ts`. Keep in lock-step.
import Foundation
import React

@objc(TraceItXEventEmitter)
public final class TraceItXEventEmitter: RCTEventEmitter {

    /// Event name forwarded as `traceitx.companion.state`.
    /// Payload: String — one of "unpaired" | "paired" | "report_in_progress" | "phone_disconnected".
    public static let stateEvent = "traceitx.companion.state"

    /// Event name forwarded as `traceitx.companion.pairUrl`.
    /// Payload: String | NSNull (NSNull crosses to JS as `null`).
    public static let pairUrlEvent = "traceitx.companion.pairUrl"

    /// Event name forwarded as `traceitx.companion.code`.
    /// The short display code returned by `/api/companion/announce`
    /// (spec 2026-08-07) — hosts render it beside the QR so a team member
    /// reading the TV screen can pick this device out of the dashboard list.
    /// Payload: String | NSNull (NSNull crosses to JS as `null`).
    public static let codeEvent = "traceitx.companion.code"

    /// Event name forwarded as `traceitx.companion.attachedUserName`.
    /// The dashboard member who attached to this device; nil on an ordinary
    /// QR bond. Payload: String | NSNull (NSNull crosses to JS as `null`).
    public static let attachedUserNameEvent = "traceitx.companion.attachedUserName"

    /// Event name forwarded as `traceitx.companion.resolvedName` (naming spec
    /// 2026-08-24). The server-resolved device display name for THIS device
    /// (e.g. an org-configured friendly name), or nil before the first
    /// successful announce / when discovery never ran. Payload: String |
    /// NSNull (NSNull crosses to JS as `null`).
    public static let resolvedNameEvent = "traceitx.companion.resolvedName"

    /// Event name forwarded as `traceitx.companion.attachChallenge` (spec
    /// 2026-08-19). The pending dashboard-initiated attach-PIN challenge, or
    /// nil when none is outstanding. Forwarded in every `attachPinUi` mode,
    /// including `'builtin'` (which renders the PIN natively AND still
    /// fires this event) — it's only NEEDED by hosts configured with
    /// `'custom'`, which must read it to build their own surface.
    /// Payload: `{ code, requestedByName, ttlMs }` | NSNull.
    public static let attachChallengeEvent = "traceitx.companion.attachChallenge"

    /// Fired when a `report.request` arrives from the paired phone. This
    /// used to give JS a window to walk the React fiber tree and call
    /// `attachReactTree`; both are gone (spec 2026-08-29). The event and
    /// the bridge's brief wait survive as the companion's JS-ready
    /// handshake (see CompanionCaptureBridge.awaitJsReactTreeAttach).
    /// Payload: String — the correlation_id of the inbound request.
    public static let reportRequestedEvent = "traceitx.companion.reportRequested"

    /// Fired right before native drains pending attachments for ANY report
    /// (spec 2026-09-17 setExtra-resolver) — NOT just the companion flow:
    /// the plain in-app `openReporter()` and native shake both trigger this
    /// too, since both funnel through `TraceItX.shared.report.open()` →
    /// `__consumePendingAttachments()`. Only fires when JS has a resolver
    /// CURRENTLY registered (`TraceItXBridge.setExtraResolverActive`) — see
    /// `TraceItXBridge.awaitJsExtraResolve`. Payload: String — the
    /// correlation_id JS echoes back via `signalExtraResolverReady`.
    public static let extraResolveRequestedEvent = "traceitx.extra.resolveRequested"

    /// Shared instance accessor — RN constructs the emitter via the standard
    /// module registry. The first init stores `self` here so `TraceItXBridge`
    /// can dispatch into the live instance without going through a JS-side
    /// `NativeModules` lookup. Mirrors the pattern documented in the RN
    /// `RCTEventEmitter` headers (and used by `RNEventEmitter` exports across
    /// the ecosystem).
    @objc public static private(set) weak var shared: TraceItXEventEmitter?

    public override init() {
        super.init()
        TraceItXEventEmitter.shared = self
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
            Self.stateEvent,
            Self.pairUrlEvent,
            Self.codeEvent,
            Self.attachedUserNameEvent,
            Self.resolvedNameEvent,
            Self.attachChallengeEvent,
            Self.reportRequestedEvent,
            Self.extraResolveRequestedEvent,
        ]
    }

    // MARK: - Static helpers used by TraceItXBridge

    /// Forward a companion-state change to JS. Silently dropped if no
    /// emitter instance is alive (e.g. before any listeners attached). The
    /// RN base class also warns when `sendEvent` fires with zero listeners,
    /// which is the documented behavior — our JS facade attaches listeners
    /// inside `useCompanion()`, so the warning surfaces only when no React
    /// subtree is rendering the companion screen.
    @objc public static func sendState(_ state: String) {
        shared?.sendEvent(withName: stateEvent, body: state)
    }

    /// Forward a pairUrl change to JS. `nil` is passed across the bridge as
    /// `NSNull()` so the JS handler receives an actual `null`. Note: pairUrl is
    /// now nulled only on socket close, so this `nil` branch fires rarely —
    /// hosts drive QR teardown off `state`, the reliably-delivered signal.
    @objc public static func sendPairUrl(_ url: String?) {
        if let url = url {
            shared?.sendEvent(withName: pairUrlEvent, body: url)
        } else {
            shared?.sendEvent(withName: pairUrlEvent, body: NSNull())
        }
    }

    /// Forward an announce display-code change to JS. `nil` crosses as
    /// `NSNull()` so the JS handler receives an actual `null` — that happens
    /// when companion discovery was never attempted (no SDK key configured),
    /// when the announce failed, or when the relay socket closed terminally.
    @objc public static func sendCode(_ code: String?) {
        if let code = code {
            shared?.sendEvent(withName: codeEvent, body: code)
        } else {
            shared?.sendEvent(withName: codeEvent, body: NSNull())
        }
    }

    /// Forward an attached-dashboard-user change to JS. `nil` crosses as
    /// `NSNull()` — an ordinary QR bond carries no `companion_user` block, so
    /// the nil branch is the common case here (unlike `sendPairUrl`).
    @objc public static func sendAttachedUserName(_ name: String?) {
        if let name = name {
            shared?.sendEvent(withName: attachedUserNameEvent, body: name)
        } else {
            shared?.sendEvent(withName: attachedUserNameEvent, body: NSNull())
        }
    }

    /// Forward a resolved device display-name change to JS (naming spec
    /// 2026-08-24). `nil` crosses as `NSNull()` — before the first successful
    /// announce, or when discovery never ran, this is the common case.
    @objc public static func sendResolvedName(_ name: String?) {
        if let name = name {
            shared?.sendEvent(withName: resolvedNameEvent, body: name)
        } else {
            shared?.sendEvent(withName: resolvedNameEvent, body: NSNull())
        }
    }

    /// Forward a `report.request` correlation id to JS. JS signals the
    /// bridge back via `signalCompanionReportRequestReady` when it is
    /// ready for capture to proceed.
    @objc public static func sendReportRequested(_ correlationId: String) {
        shared?.sendEvent(withName: reportRequestedEvent, body: correlationId)
    }

    /// Forward an attach-PIN challenge to JS. nil crosses as NSNull() → JS null.
    @objc public static func sendAttachChallenge(_ payload: [String: Any]?) {
        shared?.sendEvent(withName: attachChallengeEvent, body: payload ?? NSNull())
    }

    /// Forward an extra-resolver ask correlation id to JS (spec 2026-09-17
    /// setExtra-resolver). Mirrors `sendReportRequested` exactly — JS signals
    /// the bridge back via `signalExtraResolverReady` when it has pushed a
    /// freshly resolved value (or given up) for this correlation id.
    @objc public static func sendExtraResolveRequested(_ correlationId: String) {
        shared?.sendEvent(withName: extraResolveRequestedEvent, body: correlationId)
    }
}
