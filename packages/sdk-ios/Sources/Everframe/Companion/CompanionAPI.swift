// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 — Companion observation surface.
//
// `CompanionAPI` mirrors the `ReportAPI.isPresenting` pattern locked in
// `Everframe.swift:236-279`:
//   • `@Published public private(set) var state` — Combine surface.
//   • `didSet` posts a Notification ONLY when oldValue != newValue (no
//     duplicate posts on no-op assignments).
//   • Single-writer indirection via `__setState` / `__setPairUrl` — the
//     RelayWSClient and CompanionCaptureBridge mutate state through these
//     seams; hosts read only.
//
// Exposed to hosts as `Everframe.shared.companion`.
//
// File-ownership timeline:
//   • 06.2-07 — initial API; mutation seams used by 06.2-07's RelayWSClient.
import Foundation
import Combine

/// A pending dashboard-initiated attach request (spec 2026-08-19). Pushed by
/// the relay as `attach.challenge` when a dashboard member requests attach;
/// cleared by `attach.challenge.cleared` (reasons: expired|attached|burned|
/// superseded) or a terminal pair close. `code` is the short PIN the host
/// displays for the dashboard member to read aloud/type — SECURITY: never log
/// it, it authenticates the attach.
public struct CompanionAttachChallenge: Sendable, Equatable {
    public let code: String
    public let requestedByName: String
    public let ttlMs: Int

    public init(code: String, requestedByName: String, ttlMs: Int) {
        self.code = code
        self.requestedByName = requestedByName
        self.ttlMs = ttlMs
    }

    /// Pure deadline arithmetic (round-2 review finding 3, spec 2026-08-19):
    /// every consumer that needs to re-derive "how much time is left" — a
    /// presenter re-showing the built-in PIN window on app activation, a late
    /// RN subscriber — recomputes from an absolute `Date` deadline instead of
    /// replaying the original `ttlMs`, which would silently reset the clock.
    /// Lives here (EverframeKit), not `CompanionPinPresenter` (EverframeReporterUI,
    /// UIKit-bound), so it stays unit-testable without a UIKit host.
    /// Clamped to >= 0 — a deadline already in the past yields 0, never
    /// negative, so callers can treat 0 as "expired, dismiss now".
    public static func remainingMs(deadline: Date, now: Date = Date()) -> Int {
        max(0, Int(deadline.timeIntervalSince(now) * 1000))
    }
}

public final class CompanionAPI: ObservableObject, @unchecked Sendable {
    /// Current pairing state. Default `.unpaired` — populated by the
    /// RelayWSClient once a `pair.created` text frame arrives. Writes flow
    /// through `__setState(_:)`; the didSet posts
    /// `.everframeCompanionStateChange` only on a real value change.
    @Published public private(set) var state: CompanionState = .unpaired {
        didSet {
            guard oldValue != state else { return }
            NotificationCenter.default.post(
                name: .everframeCompanionStateChange,
                object: self,
                userInfo: ["state": state.rawValue]
            )
        }
    }

    /// The pair URL the host renders as a QR (e.g. `https://relay.example/r/<token>`).
    /// `nil` until the relay issues a `pair.created` message. Everframe SDK ships zero
    /// QR-rendering code — the host picks any QR library and reads this
    /// property (SPEC §3, mirrored Phase 05.1 host-rendered-chrome precedent).
    @Published public private(set) var pairUrl: String? = nil {
        didSet {
            guard oldValue != pairUrl else { return }
            NotificationCenter.default.post(
                name: .everframeCompanionPairUrlChange,
                object: self,
                userInfo: ["pairUrl": pairUrl as Any]
            )
        }
    }

    /// Short display code from a successful `/api/companion/announce`
    /// (spec 2026-08-07). The host renders it beside the QR so a team member
    /// reading the TV screen can pick this device out of the dashboard's
    /// list. `nil` when companion discovery wasn't attempted (no Everframe SDK key
    /// passed to `RelayWSClient`) or the announce failed for any reason —
    /// announce failing costs discovery, never pairing or reporting, so this
    /// is a pure display affordance with no effect on `state` / `pairUrl`.
    /// Shares `pairUrl`'s lifecycle: nulled only when the relay socket closes
    /// terminally.
    @Published public private(set) var code: String? = nil {
        didSet {
            guard oldValue != code else { return }
            NotificationCenter.default.post(
                name: .everframeCompanionCodeChange,
                object: self,
                userInfo: ["code": code as Any]
            )
        }
    }

    /// Display name from the `pair.bonded` frame's optional `companion_user`
    /// block — populated only when a dashboard user attached to this device,
    /// absent (and therefore reset to `nil`) on an ordinary QR bond. Hosts may
    /// surface it as "Paired with <name>". Shares `pairUrl`'s lifecycle.
    @Published public private(set) var attachedUserName: String? = nil {
        didSet {
            guard oldValue != attachedUserName else { return }
            NotificationCenter.default.post(
                name: .everframeCompanionAttachedUserNameChange,
                object: self,
                userInfo: ["attachedUserName": attachedUserName as Any]
            )
        }
    }

    /// Announce-resolved display name (spec 2026-08-24): custom rename ->
    /// host label -> server-composed default, resolved server-side at
    /// `/api/companion/announce` time. Updated live by `companion.name`
    /// pushes (a dashboard rename while this device stays connected). Shares
    /// `code`'s lifecycle — nil when announce wasn't attempted or failed, and
    /// nulled wherever the relay socket closes terminally. Never a personal
    /// name — this is the device's own display name, not the attached
    /// dashboard user's (see `attachedUserName` for that).
    @Published public private(set) var resolvedName: String? = nil {
        didSet {
            guard oldValue != resolvedName else { return }
            NotificationCenter.default.post(
                name: .everframeCompanionResolvedNameChange,
                object: self,
                userInfo: ["resolvedName": resolvedName as Any]
            )
        }
    }

    /// The pending attach-PIN challenge, or nil when none is outstanding
    /// (spec 2026-08-19). Populated by `RelayWSClient` off `attach.challenge`,
    /// cleared off `attach.challenge.cleared` or a terminal pair close.
    /// Custom hosts read this directly to render their own PIN UI even when
    /// the built-in `CompanionPinPresenter` is suppressed — suppression only
    /// silences the built-in presenter, it never clears this property.
    @Published public private(set) var attachChallenge: CompanionAttachChallenge? = nil {
        didSet {
            guard oldValue != attachChallenge else { return }
            let userInfo: [String: Any]
            if let c = attachChallenge {
                userInfo = ["code": c.code, "requestedByName": c.requestedByName, "ttlMs": c.ttlMs]
            } else {
                userInfo = [:]
            }
            NotificationCenter.default.post(
                name: .everframeCompanionAttachChallengeChange,
                object: self,
                userInfo: userInfo
            )
        }
    }

    /// Set true by `EverframeReporterUI`'s `CompanionPinPresenter.install()`.
    /// Read at announce time to decide the `supportsAttachPin` capability in
    /// `.builtin` mode — builtin without the reporter-UI module linked
    /// degrades honestly to legacy (no PIN UI advertised).
    ///
    /// `package(set)` rather than `internal(set)`: the writer
    /// (`CompanionPinPresenter.install()`) lives in the `EverframeReporterUI`
    /// target, a different module from this one but the same Swift package,
    /// which is exactly the access `package` grants and plain `internal`
    /// (module-scoped) cannot — hosts outside the package still see this as
    /// read-only.
    public package(set) var __builtinPinUiInstalled: Bool = false

    /// Runtime suppression of the built-in PIN presenter (spec 2026-08-19).
    /// Set by the RN bridge in a later task when a custom PIN UI takes over
    /// at runtime — `CompanionPinPresenter.present(_:)` checks this on every
    /// challenge and no-ops the built-in window while it's true.
    /// `attachChallenge` still updates either way so a custom UI can read it.
    /// Same `package(set)` rationale as `__builtinPinUiInstalled` above.
    public package(set) var __builtinPinUiSuppressed: Bool = false

    /// Public setter for `__builtinPinUiSuppressed` (Task 9). The property's
    /// setter is `package`-scoped — visible to every target INSIDE this
    /// Swift package, which the React Native bridge is not: `packages/
    /// sdk-react-native/ios` is a separate CocoaPods pod (`EverframeRN`)
    /// consuming `EverframeKit` as a built product, not a package(set) peer.
    /// `EverframeBridge.swift` (`companionAttachPinUi`/`startCompanion`) is
    /// the intended caller: it stashes the host's `attachPinUi` config mode
    /// at configure time and flips this flag at `startCompanion` time —
    /// `true` whenever the mode is not `.builtin`, `false` when it is.
    public func __setBuiltinPinUiSuppressed(_ v: Bool) {
        __builtinPinUiSuppressed = v
    }

    /// PR-fix 7 — the `correlation_id` of the report that currently OWNS
    /// `.reportInProgress`, or nil when no report does.
    ///
    /// `state` alone cannot answer "may this completion clear the report?".
    /// The pair can re-bond to a different dashboard user while an upload is
    /// still running (`releasePairBond` closes only the phone leg, so the same
    /// TV socket and the same client serve both users): that bond flips the
    /// shared state back to `.paired`, the new user's `report.request` is
    /// accepted and re-enters `.reportInProgress`, and the OLD upload then
    /// finishes and — before this field existed — flipped the state to
    /// `.paired` unconditionally. A third request was accepted over the second,
    /// re-freezing the replay/breadcrumb snapshot the second report's composer
    /// was about to consume.
    ///
    /// The identity is the `correlation_id` and not the bond/connect
    /// generation: correlation_id names the REPORT, which is what a completion
    /// is a completion OF. A generation is coarser — two reports run in
    /// sequence under one bond, so a stale completion from the first would
    /// still match the second's generation and clear it. Every frame in the
    /// report lifecycle already carries `correlation_id`, so nothing new has to
    /// be plumbed to use it.
    ///
    /// Guarded by `reportLock` rather than the (unsynchronised) `state`
    /// property because the read-compare-clear must be atomic: the WS receive
    /// thread begins reports while the bridge's `@MainActor` submit task ends
    /// them.
    private let reportLock = NSLock()
    private var reportInProgressCorrelationId: String?

    public init() {}

    /// Hops a `@Published`-property write onto the main thread — external
    /// review, finding N6. `CompanionAPI` is `@unchecked Sendable`, not
    /// main-actor isolated (see `RelayWSClient.swift`'s file-header threading
    /// note), so every `__set*` seam below is reachable from the URLSession
    /// delegate queue (`handleControl`, off the WS reader thread) and from
    /// unstructured `Task`s (announce completion) — publishing a `@Published`
    /// property off-main is undefined for any SwiftUI/Combine observer.
    ///
    /// A main-thread caller (every existing test that drives these seams
    /// directly, exactly as `CompanionBadge.teardown()`'s identical
    /// `Thread.isMainThread` check does) applies synchronously, in place.
    ///
    /// An off-main caller uses `DispatchQueue.main.sync`, not `.async`:
    /// `RelayWSClient`'s own serial-report invariant (`CompanionAPI.swift`'s
    /// `__beginReport`/`__finishReport` doc) depends on `state` reading back
    /// the value a PRIOR `__setState`/`__beginReport` call on the SAME WS
    /// reader thread just wrote, synchronously, before the next frame's guard
    /// check runs — `handleControl` never awaits between frames. An `.async`
    /// hop would let a second `report.request` frame's guard observe a stale
    /// pre-write value and accept a report that should have been rejected
    /// as already-in-flight. `.sync` preserves that ordering for every
    /// caller while still moving the actual mutation onto the main thread:
    /// blocking the WS reader thread for the few microseconds a property
    /// write takes is cheap, and the main thread is never otherwise blocked
    /// waiting on that thread, so there is no deadlock cycle to form.
    private func onMain(_ apply: @escaping @Sendable () -> Void) {
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.sync(execute: apply)
        }
    }

    // MARK: - Single-writer seams (Everframe SDK-internal; hosts must NEVER call)

    /// Internal seam used by `RelayWSClient` to mutate `state`. Hosts read
    /// only — never call this directly. Marked `internal` so the public ABI
    /// stays read-only.
    ///
    /// NOT the way to enter or leave `.reportInProgress` — use
    /// `__beginReport` / `__finishReport`, which carry the report's identity.
    /// A bare `__setState(.reportInProgress)` leaves the state owned by nobody
    /// and every completion, however stale, is then refused by
    /// `__finishReport`.
    ///
    /// Every OTHER state releases the claim, which is what keeps the invariant
    /// "a report owns `.reportInProgress` for exactly as long as the pair is in
    /// it" true. A terminal close (`.unpaired`), a backgrounding
    /// (`.phoneDisconnected`) or a re-bond (`.paired`) all end the running
    /// report's claim on this pair, and a completion arriving afterwards must
    /// not resurrect `.paired` on top of whatever came next.
    internal func __setState(_ s: CompanionState) {
        if s != .reportInProgress {
            reportLock.lock()
            reportInProgressCorrelationId = nil
            reportLock.unlock()
        }
        onMain { self.state = s }
    }

    /// Enter `.reportInProgress` on behalf of the report identified by
    /// `correlationId`, which from here until `__finishReport` matches is the
    /// sole owner of that state.
    ///
    /// External review, finding NN2 — this used to write `state` directly
    /// (`state = .reportInProgress`), bypassing [onMain] entirely. `state` is
    /// `@Published`, and this method is reachable from `RelayWSClient`'s
    /// `handleControl` on the URLSession delegate queue — i.e. off-main — so
    /// that direct write mutated a `@Published` property off the main thread,
    /// undefined for any SwiftUI/Combine observer (the exact hazard [onMain]'s
    /// own doc comment exists to close for every OTHER seam in this file).
    /// The lock is already released before this write in both the old and
    /// new code, so routing it through [onMain] is a pure wrap: no lock is
    /// held across the hop, and [onMain]'s own `.sync` (not `.async`) still
    /// guarantees the write lands before this call returns, preserving the
    /// same-thread synchronous-visibility contract [onMain]'s doc describes.
    internal func __beginReport(correlationId: String) {
        reportLock.lock()
        reportInProgressCorrelationId = correlationId
        reportLock.unlock()
        onMain { self.state = .reportInProgress }
    }

    /// Recheck request ownership after an asynchronous host-attachment wait.
    internal func __ownsReport(correlationId: String) -> Bool {
        reportLock.lock(); defer { reportLock.unlock() }
        return reportInProgressCorrelationId == correlationId
    }

    /// Return to `.paired` — but ONLY if `correlationId` is the report that
    /// currently owns `.reportInProgress`. Returns whether it did.
    ///
    /// `beforePaired` runs under the same claim, immediately before the flip,
    /// and ONLY when the claim succeeds. That is where a caller puts work that
    /// touches shared capture state (the replay discard in
    /// `CompanionCaptureBridge.sendFailed`): running it for a superseded report
    /// throws away the LIVE report's frozen snapshot, which is the same defect
    /// as clearing its state and is not fixed by gating the state write alone.
    ///
    /// External review, finding NN2 — this used to run the ENTIRE transition
    /// (the guard, `beforePaired()`, and the `state = .paired` write) inside
    /// `reportLock`, and wrote `state` directly rather than through [onMain].
    /// Two problems, both from the same cause: `state` is `@Published` and
    /// this method is reachable off-main (`CompanionCaptureBridge`'s submit
    /// completion, a URLSession/upload callback queue, not the WS reader
    /// thread `__beginReport` runs on) —
    ///   1. the direct write mutated a `@Published` property off-main,
    ///      exactly the [__beginReport] hazard above; and
    ///   2. routing that write through [onMain] WHILE STILL HOLDING
    ///      `reportLock` (the straightforward fix for (1)) opens a real
    ///      deadlock: [onMain]'s off-main path is `DispatchQueue.main.sync`,
    ///      which blocks this (background) thread until the main thread runs
    ///      the block — but if the main thread is itself blocked waiting on
    ///      `reportLock` (calling `__beginReport`/`__finishReport` from a
    ///      main-thread-driven capture/submit path is not excluded anywhere),
    ///      neither thread can ever make progress.
    ///
    /// Fix: compute the decision (the guard + clearing the claim) under the
    /// lock, release it, THEN run `beforePaired()` and publish via [onMain] —
    /// no lock is ever held across the `.sync` hop.
    ///
    /// ACCEPTED LIMITATION (residual of this fix, not introduced by it): the
    /// old doc's "the whole transition runs under `reportLock` so a
    /// `report.request` arriving on the WS thread cannot land between the
    /// discard and the flip and have its brand-new `.reportInProgress`
    /// immediately overwritten" guarantee no longer holds in full — a
    /// concurrent `__beginReport(newId)` can now interleave between this
    /// method's unlock and its own `onMain` publish, and WHICHEVER call's
    /// block the (serial) main queue happens to run last wins the visible
    /// `state`. This is not a new hazard this fix introduces: `__beginReport`
    /// ALREADY published its `state = .reportInProgress` write OUTSIDE
    /// `reportLock` before this fix (only `reportInProgressCorrelationId`
    /// was lock-guarded there), so the two writes could already race for
    /// last-write-wins on `state` — this fix changes WHERE that race is
    /// (queued-block ordering on the main queue vs. two raw memory writes),
    /// not WHETHER it exists. `reportInProgressCorrelationId` — the value
    /// every `__finishReport` guard actually checks — stays exactly as
    /// strictly lock-ordered as before, so a stale completion still cannot
    /// clear a NEWER report's claim; only the momentarily-displayed `state`
    /// value can lag in this narrow window. A real fix needs the same
    /// transition-barrier work already deferred elsewhere in this Everframe SDK (see
    /// `Everframe.swift`'s `discardCapturedEvidenceForIdentityChange` doc for
    /// the sibling "accepted, not silently left as a gap" precedent) — not a
    /// third lock-shape patch to this one method.
    @discardableResult
    internal func __finishReport(correlationId: String,
                                 beforePaired: () -> Void = {}) -> Bool {
        reportLock.lock()
        // The state test is implied by `__setState`'s release — a non-nil claim
        // means the pair is in `.reportInProgress` — and is written out anyway
        // because that invariant lives in a different method, and because
        // "return to `.paired` only from `.reportInProgress`" is the property
        // this method is named for.
        guard state == .reportInProgress,
              reportInProgressCorrelationId == correlationId else {
            reportLock.unlock()
            return false
        }
        reportInProgressCorrelationId = nil
        reportLock.unlock()
        beforePaired()
        onMain { self.state = .paired }
        return true
    }

    /// Test seam — which report, if any, owns `.reportInProgress` right now.
    /// Lets a test prove the owner really changed hands (anti-vacuity) rather
    /// than inferring it from the state alone.
    internal func __reportInProgressCorrelationIdForTesting() -> String? {
        reportLock.lock(); defer { reportLock.unlock() }
        return reportInProgressCorrelationId
    }

    /// Internal seam used by `RelayWSClient` to set the pair URL.
    internal func __setPairUrl(_ u: String?) { onMain { self.pairUrl = u } }

    /// Internal seam used by `RelayWSClient` to publish the announce display
    /// code (nil when the announce was skipped or failed).
    internal func __setCode(_ c: String?) { onMain { self.code = c } }

    /// Internal seam used by `RelayWSClient` to publish the attached
    /// dashboard user's display name (nil on an ordinary QR bond).
    internal func __setAttachedUserName(_ n: String?) { onMain { self.attachedUserName = n } }

    /// Internal seam used by `RelayWSClient` to publish/clear the pending
    /// attach-PIN challenge (spec 2026-08-19).
    internal func __setAttachChallenge(_ c: CompanionAttachChallenge?) { onMain { self.attachChallenge = c } }

    /// Internal seam used by `RelayWSClient` to publish/clear the
    /// announce-resolved display name (spec 2026-08-24).
    internal func __setResolvedName(_ n: String?) { onMain { self.resolvedName = n } }
}
