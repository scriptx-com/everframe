// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Swift glue layer for the React Native TurboModule bridge.
//
// CONTRACT (Plan 06-02 + D-05/D-07 flip 2026-05-11 — DO NOT widen without a
// new D-decision):
//
//   The RN bridge surface is the Phase 06 5-method TurboModule (configure,
//   openReporter, registerSensitiveRect, setExtra, attachReactTree). The native
//   EFReporterPresenter owns the entire report UX (capture + annotate + redact +
//   submit) on iOS/iPadOS. On tvOS the on-device modal reporter was removed —
//   tvOS hosts call the companion start API and route reporting through the
//   phone-companion (QR → phone browser SPA) flow instead, so openReporter()
//   on tvOS resolves to .cancelled by way of the absent presenter installer.
//
//     1. configure(opts)            → start Everframe.shared with EverframeConfig
//                                     + install EFReporterPresenter resolver
//     2. openReporter()             → await Everframe.shared.report.open()
//                                     resolves with { status, reportId? }
//     3. registerSensitiveRect(tag) → SensitiveRectRegistry.mark(view)
//
// Strict invariants:
//   • NO new public method is added to `Everframe.shared`.
//   • Every method guards on `Everframe.shared.captureGate`.
//   • The presenter resolver is installed exactly once per process (idempotent
//     installer + a local flag for defense-in-depth).
import Foundation
import Combine
import os.log
import UIKit
import EverframeKit
import EverframeReporterUI    // tvOS slice present per Package.swift:12 (TV-03 of Phase 06.1)

@objc public final class EverframeBridge: NSObject {

    private static let log = OSLog(subsystem: "dev.everframe.rn", category: "bridge")

    // One-shot resolver install flag. `EFReporterPresenter.installResolver()`
    // itself is idempotent at the sdk-ios layer, but a local guard avoids the
    // os_log spam and the redundant `report.isPresenting` rewire.
    nonisolated(unsafe) private static var resolverInstalled = false
    private static let resolverInstallLock = NSLock()

    // MARK: - configure

    @objc public static func configure(
        appId: NSString,
        endpoint: NSString,
        networkBodiesDisabled: Bool,
        installIdentifierDisabled: Bool,
        attachPinUi: NSString?,
        companionDeviceId: NSString?,
        companionBadgeEnabled: Bool,
        shakeToReportEnabled: Bool,
        companionBadgePosition: NSString?,
        theme: NSDictionary?,
        vitalsEnabled: NSNumber?,
        vitalsSampleRate: NSNumber?,
        vitalsCaptureSourceQuery: NSNumber?
    ) throws {
        // `endpoint` arg is retained for ObjC ABI compatibility with the
        // codegen .mm — value is ignored. The SDK bakes the ingest URL at
        // compile time (sdk-ios IngestEndpoint).
        _ = endpoint
        os_log("[everframe] configure appId=%{public}@", log: log, type: .info, appId as String)
        // Polarity flips exactly once, here: JS sends the veto
        // (`networkBodiesDisabled`), native stores the permission.
        var cfg = EverframeConfig(appId: appId as String)
        cfg.capture.networkBodies = !networkBodiesDisabled
        // Polarity flips exactly once, here: JS sends the veto
        // (`installIdentifierDisabled`), native stores the permission —
        // identical to `networkBodies` above.
        cfg.installIdentifierEnabled = !installIdentifierDisabled
        // Explicit companion device-identity override (naming spec
        // 2026-08-24) — read straight off the flat ConfigOpts field, same
        // shape as attachPinUi below. nil/absent falls through to the
        // Keychain-then-stored-UUID chain inside CompanionDeviceId.resolve.
        cfg.companionDeviceId = companionDeviceId as String?
        // Companion on-screen name badge (naming spec 2026-08-24, controller
        // ruling / Task 6b) — read straight off the flat ConfigOpts fields,
        // same shape as companionDeviceId above. `companionBadgeEnabled` is
        // already defaulted to `true` by the .mm's `.value_or(true)`;
        // `companionBadgePosition` stays the raw string here — parsed into
        // `CompanionBadgePosition` only at `startCompanion()`, since a
        // position can't affect anything before a relay client (and its
        // badge) exist, mirroring `companionAttachPinUi` below.
        cfg.companionBadgeEnabled = companionBadgeEnabled
        cfg.shakeToReportEnabled = shakeToReportEnabled
        cfg.companionBadgePosition = companionBadgePosition as String?
        // Inline reporter theme (reporter branding spec 2026-08-25, RN
        // slice). The .mm collapses the 8 flat ConfigOpts `theme*` wire
        // fields into one role-keyed dictionary (nil when the host set no
        // theme at all), so this ObjC seam gains ONE parameter instead of
        // eight. Passthrough only — ThemeResolver revalidates hex per-field
        // at presentation time and the server watermark entitlement gates
        // rendering; an invalid or unentitled theme changes nothing here.
        cfg.theme = Self.parseTheme(theme)
        // Session Vitals (spec 2026-09-06) — the three flat ConfigOpts fields
        // the .mm reads off `opts`. PRESENT FIELDS ONLY: each assignment is
        // guarded, so an absent field keeps `VitalsConfig`'s own default
        // rather than being written with a coerced zero value. That is why
        // they cross as `NSNumber?` and not `Bool`/`Double` — absent must stay
        // distinguishable from `false`/`0` (nil `enabled` follows the
        // dashboard toggle; nil `sampleRate` follows the server rate).
        if let vitalsEnabled { cfg.vitals.enabled = vitalsEnabled.boolValue }
        if let vitalsSampleRate { cfg.vitals.sampleRate = vitalsSampleRate.doubleValue }
        if let vitalsCaptureSourceQuery { cfg.vitals.captureSourceQuery = vitalsCaptureSourceQuery.boolValue }
        // The attach-PIN UI mode for startCompanion() to read (spec 2026-08-19). configure()
        // precedes startCompanion() in every host's lifecycle, so this is the natural place to
        // parse the flat ConfigOpts string into the native enum; startCompanion is where it is
        // actually consumed (RelayWSClient's announce arg + the suppression seam), since a mode
        // can't affect anything before a relay client exists. Parsed into a LOCAL: the gate
        // below compares it against the stashed value, and only the start path adopts it.
        let newAttachPinUi = Self.parseAttachPinUi(attachPinUi as String?)
        // Codex round-6, H1 — IDEMPOTENT configure, twin of `EverframeModule.configure`'s gate on
        // Android, and decided against the INSTALLED config rather than a cache of the last
        // options this bridge started with.
        //
        // `Everframe.shared.start(...)` SUPERSEDES the running SDK: the outgoing controller's
        // shutdown detaches every integration it had announced, so a Provider that merely
        // REMOUNTS with the same config used to kill every live player registration for
        // nothing. An identical configuration installs identical state, so the cheapest correct
        // answer is not to start at all.
        //
        // Round-5 kept a cached snapshot of the options it last started with, and a cache can
        // disagree with the singleton it claims to describe: two overlapping configures (A then
        // B) can interleave so the cache says A while the SDK runs B, and a native host calling
        // `Everframe.shared.start(configB)` between two bridge configures of A reproduces it with
        // no concurrency at all — the second A matches the stale cached A, skips, and leaves B
        // installed under a JS host that believes it configured A. `currentConfig` cannot drift:
        // it IS the installed state.
        //
        // `captureGate` is the second term: a killed SDK must be restarted even by an identical
        // config, or the host is left with a dead SDK and no way to revive it.
        //
        // Codex round-7, I3 — the comparison is the WHOLE config (`EverframeConfig` is now
        // `Equatable`, matching Android's `data class`), not a rendering of the fields this
        // bridge happens to set. Round-6 hand-built a string snapshot here, which meant any
        // config field the snapshot's author had not listed — a new one, or one a native host
        // set directly — read as "unchanged" and silently suppressed a start that was needed.
        // `attachPinUi` is the one term that is NOT part of the config (it lands in module
        // state), so it is compared separately.
        //
        // Everything else this method does still runs on the skip path — the presenter-resolver
        // install and the crash-metadata prime — because both are idempotent and neither
        // depends on a fresh start. The attach-PIN stash is the exception, and only nominally:
        // on the skip path it would write the value it already holds.
        let unchanged = Everframe.shared.captureGate
            && Everframe.shared.currentConfig == cfg
            && companionAttachPinUi == newAttachPinUi
        if unchanged {
            os_log("[everframe] configure: SDK already running this exact config — skipping start()",
                   log: log, type: .debug)
        } else {
            try Everframe.shared.start(config: cfg)
            // Adopted only on the start path — the skip path has already established that the
            // stashed value equals this one.
            companionAttachPinUi = newAttachPinUi
        }
        installPresenterResolverIfNeeded()
        // Spec 2026-09-17 setExtra-resolver — installed unconditionally,
        // every configure(), NOT gated behind startCompanion() the way the
        // companion Combine subscriptions are: this must also cover the
        // plain in-app openReporter() path and native shake, both of which
        // funnel through Everframe.shared.report.open() →
        // __consumePendingAttachments() with no companion involvement at
        // all. See `installExtraResolveHook()`'s own doc comment.
        installExtraResolveHook()
        // Task 13: prime the device-metadata cache off the main queue so a
        // crash arriving shortly after configure() still has device context.
        CrashReporter.prime()
    }

    /// Build `ReporterThemeOptions` from the .mm's role-keyed dictionary
    /// (reporter branding spec 2026-08-25, RN slice). `nil` dictionary — the
    /// host set no theme — maps to `nil` options so `EverframeConfig.theme`
    /// stays "host did nothing"; per-role absence is preserved the same way.
    /// Values are NOT validated here: `ThemeResolver` owns hex validation
    /// per-field at presentation time.
    private static func parseTheme(_ raw: NSDictionary?) -> ReporterThemeOptions? {
        guard let raw else { return nil }
        func role(_ key: String) -> String? { raw[key] as? String }
        return ReporterThemeOptions(
            background: role("background"),
            surface: role("surface"),
            border: role("border"),
            text: role("text"),
            textMuted: role("textMuted"),
            accent: role("accent"),
            accentForeground: role("accentForeground"),
            destructive: role("destructive")
        )
    }

    /// Coerce the flat `ConfigOpts.attachPinUi` string into `AttachPinUi`.
    /// `nil` (field absent) and any unrecognised value both degrade to
    /// `.builtin` — the safe default matching "host did nothing special".
    private static func parseAttachPinUi(_ raw: String?) -> AttachPinUi {
        guard let raw, let mode = AttachPinUi(rawValue: raw) else { return .builtin }
        return mode
    }

    /// Coerce the flat `ConfigOpts.companionBadgePosition` string into
    /// `CompanionBadgePosition` (naming spec 2026-08-24, controller ruling /
    /// Task 6b). `nil` (field absent) and any unrecognised value both
    /// degrade to `.bottomRight` — matches `CompanionBadgeOptions.position`'s
    /// own default, so an absent field behaves exactly like never touching
    /// the option at all.
    private static func parseCompanionBadgePosition(_ raw: String?) -> CompanionBadgePosition {
        switch raw {
        case "bottom-left": return .bottomLeft
        case "top-right": return .topRight
        case "top-left": return .topLeft
        default: return .bottomRight
        }
    }

    /// Wires `EFReporterPresenter` as the resolver for `Everframe.shared.report
    /// .open()`. Called from configure(); the first call installs, subsequent
    /// calls no-op. tvOS has no on-device modal — reporting goes through the
    /// phone-companion flow (QR → phone browser) — so the presenter type
    /// itself is `#if !os(tvOS)`-gated in EverframeReporterUI. Mirror that
    /// gate here so the bridge compiles for the tvOS slice.
    private static func installPresenterResolverIfNeeded() {
        #if !os(tvOS)
        resolverInstallLock.lock()
        let alreadyInstalled = resolverInstalled
        resolverInstalled = true
        resolverInstallLock.unlock()
        guard !alreadyInstalled else { return }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                EFReporterPresenter.installResolver()
            }
            os_log("[everframe] installed EFReporterPresenter resolver", log: log, type: .info)
        }
        #else
        os_log("[everframe] tvOS — EFReporterPresenter not installed; reporting routes through phone companion", log: log, type: .info)
        #endif
    }

    // MARK: - Extra-resolver ask-and-wait (spec 2026-09-17 setExtra-resolver)

    /// Identity token for the CURRENTLY installed
    /// `Everframe.__pendingExtraResolveHook` closure (D1 fix — stale-teardown
    /// race). Bumped every time `installExtraResolveHook()` (re)installs the
    /// hook; `resetExtraResolverForTeardown(_:)` below compares a caller's
    /// captured value against this to decide whether ITS installation is
    /// still the live one. See that method's doc comment for the race this
    /// closes and why a plain counter — not a `Bool` — is what makes the
    /// comparison possible at all.
    nonisolated(unsafe) private static var extraResolveHookGeneration: Int = 0
    private static let extraResolveHookInstallLock = NSLock()

    /// Installs `awaitJsExtraResolve` onto `Everframe.__pendingExtraResolveHook`
    /// (see that property's doc comment on Everframe.swift). Called from
    /// EVERY `configure()`, UNCONDITIONALLY — mirrors Android's
    /// `EverframeModule.init` block installing its own `extraResolveHook`
    /// field unconditionally at every module construction ("the newest
    /// instance's closure always wins", per that field's doc comment),
    /// applied here at iOS's per-`configure()`-call granularity since
    /// `EverframeBridge` has no per-instance construction point of its own —
    /// every method on it is `static`.
    ///
    /// D1 fix: this used to be `installExtraResolveHookIfNeeded()`, gated by
    /// a once-per-process `Bool` flag so a second call was a no-op. That
    /// flag is exactly what let a STALE module instance's delayed
    /// `-invalidate` clobber a FRESH instance's install: once the stale
    /// teardown reset the flag to false and nil'd the hook, nothing was left
    /// to set it again — `configure()` had already run for the current
    /// bundle and nothing calls it a second time. See
    /// `resetExtraResolverForTeardown(_:)`'s doc comment for the full race.
    ///
    /// Reinstalling has no observable side effect beyond the generation
    /// bump: `awaitJsExtraResolve` captures no per-call state — it reads
    /// only process-static vars at invocation time — so calling this on
    /// every `configure()` is cheap, harmless churn, same as Android already
    /// accepts on every module construction.
    ///
    /// Returns the fresh generation so `EverframeModule.mm`'s `-configure:`
    /// can capture it (via `currentExtraResolveHookGeneration()` below) and
    /// hand it back to `resetExtraResolverForTeardown(_:)` at `-invalidate`
    /// time. `@discardableResult` because `configure()` itself has no use
    /// for the value — only the ObjC caller does, via the separate accessor.
    @discardableResult
    private static func installExtraResolveHook() -> Int {
        extraResolveHookInstallLock.lock()
        extraResolveHookGeneration += 1
        let generation = extraResolveHookGeneration
        extraResolveHookInstallLock.unlock()
        Everframe.__pendingExtraResolveHook = { await awaitJsExtraResolve() }
        return generation
    }

    /// ObjC-visible read of whichever generation is live RIGHT NOW — i.e.
    /// whatever the most recent `installExtraResolveHook()` call minted.
    /// `EverframeModule.mm`'s `-configure:` calls this immediately after
    /// `configureWithAppId:...:error:` (which, on success or on the
    /// already-running-unchanged skip path, calls `installExtraResolveHook()`
    /// internally) and stashes the result on its own instance ivar for
    /// `-invalidate` to hand back later. 0 means no `configure()` call has
    /// ever successfully reached the install site.
    @objc public static func currentExtraResolveHookGeneration() -> Int {
        extraResolveHookInstallLock.lock()
        defer { extraResolveHookInstallLock.unlock() }
        return extraResolveHookGeneration
    }

    /// JS presence flag — see `setExtraResolverActive`'s own doc comment on
    /// `NativeEverframe.ts`'s `Spec.setExtraResolverActive`. `nonisolated
    /// (unsafe)` + a lock (not `@Volatile` — Swift has no such attribute):
    /// written from the JS thread (`setExtraResolverActive` below) and read
    /// from `awaitJsExtraResolve`, which runs wherever
    /// `__consumePendingAttachments()`'s caller happens to run.
    nonisolated(unsafe) private static var extraResolverActive = false
    private static let extraResolverActiveLock = NSLock()

    /// JS calls this from EVERY `setExtra` call — see the full contract on
    /// `NativeEverframe.ts`'s `Spec.setExtraResolverActive`.
    @objc public static func setExtraResolverActive(_ active: Bool) {
        extraResolverActiveLock.lock()
        extraResolverActive = active
        extraResolverActiveLock.unlock()
    }

    /// Per-correlation_id continuation map, released by
    /// `signalExtraResolverReady`. Mirrors `CompanionCaptureBridge`'s
    /// `pendingAttachContinuations` exactly (same lock-guarded dictionary,
    /// same "the timeout resumes it if JS never calls back" shape).
    nonisolated(unsafe) private static var pendingExtraResolveContinuations:
        [String: CheckedContinuation<Void, Never>] = [:]
    private static let pendingExtraResolveLock = NSLock()

    /// Installed onto `Everframe.__pendingExtraResolveHook`. No-ops
    /// IMMEDIATELY — no event, no wait — unless JS has a resolver CURRENTLY
    /// registered (`extraResolverActive`), which is what keeps a
    /// string/object-only host's report path exactly as fast as before this
    /// feature landed (requirement: "no behaviour change whatsoever").
    ///
    /// Otherwise mirrors `CompanionCaptureBridge.awaitJsReactTreeAttach`
    /// exactly: send `EverframeEventEmitter.sendExtraResolveRequested`, then
    /// suspend up to 250ms for JS's `signalExtraResolverReady` ack.
    private static func awaitJsExtraResolve() async {
        extraResolverActiveLock.lock()
        let active = extraResolverActive
        extraResolverActiveLock.unlock()
        guard active else { return }

        let correlationId = UUID().uuidString
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            pendingExtraResolveLock.lock()
            pendingExtraResolveContinuations[correlationId] = cont
            pendingExtraResolveLock.unlock()
            // Send AFTER registering the continuation so a fast JS callback
            // can't lose the race — same ordering `awaitJsReactTreeAttach`
            // uses.
            EverframeEventEmitter.sendExtraResolveRequested(correlationId)
            // 250ms bounded fallback — resume if JS hasn't called back by then.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
                resumeAndDropPendingExtraResolve(correlationId: correlationId)
            }
        }
    }

    /// JS handshake ack: called once the `everframe.extra.resolveRequested`
    /// listener has — if a resolver is registered — pushed a freshly
    /// resolved value through `setExtra` above. Idempotent — a late signal
    /// after the 250ms fallback already fired is a harmless no-op, exactly
    /// like `signalCompanionReportRequestReady` below.
    @objc public static func signalExtraResolverReady(_ correlationId: NSString) {
        resumeAndDropPendingExtraResolve(correlationId: correlationId as String)
    }

    private static func resumeAndDropPendingExtraResolve(correlationId: String) {
        pendingExtraResolveLock.lock()
        let cont = pendingExtraResolveContinuations.removeValue(forKey: correlationId)
        pendingExtraResolveLock.unlock()
        cont?.resume()
    }

    /// Module-instance teardown fix (review finding F4, spec 2026-09-17
    /// setExtra-resolver). `extraResolverActive` is a process-static
    /// (above), so nothing was ever clearing it on its own. Scenario this
    /// fixes: an RN surface embedded in a native host, whose JS context is
    /// torn down WITHOUT `runtime.unmount()` running (a hard reload, or the
    /// host tearing down its `RCTBridge`/turbo module manager directly) — RN
    /// still calls `-invalidate` on every module that responds to it (see
    /// `EverframeModule.mm`'s own header comment), but `runtime.ts`'s
    /// `unmount()` (the thing that would otherwise flip
    /// `setExtraResolverActive(false)`) never runs. Left uncleared,
    /// `extraResolverActive` stays `true` forever: EVERY later report —
    /// even a pure-native one, with no live RN bridge at all — pays the
    /// full 250ms bounded wait for a `signalExtraResolverReady` ack that
    /// will never arrive. Fail-open still holds (the wait still resolves
    /// the report), but the "zero added latency for a non-resolver host"
    /// contract this feature promised breaks silently.
    ///
    /// Called from `-[EverframeModule invalidate]`, mirroring
    /// `RemoteVitalsBridge.reset()`'s own lifetime doc comment.
    ///
    /// IDENTITY GUARD (D1 fix — stale-teardown race). `generation` is the
    /// value `EverframeModule.mm`'s `-configure:` captured via
    /// `currentExtraResolveHookGeneration()` right after ITS OWN
    /// `configure()` call, stashed on that ObjC instance and handed back
    /// here at `-invalidate` time. RN dispatches `-invalidate` on a
    /// module's method queue, so a STALE module instance's `-invalidate`
    /// can be DELIVERED AFTER a reloaded bundle's fresh module instance has
    /// already run `configure()` and installed a new hook (bumping
    /// `extraResolveHookGeneration`). Before this guard, the stale
    /// instance's teardown unconditionally nil'd `Everframe
    /// .__pendingExtraResolveHook` and cleared `extraResolverActive` — the
    /// FRESH hook, out from under the new bundle. Because that fresh
    /// `configure()` already ran and nothing calls it a second time,
    /// nothing was left to reinstall: JS then calls `setExtra(resolver)`,
    /// sets `extraResolverActive = true`, and native never asks again —
    /// `extra` silently vanishes from every report for the rest of the
    /// process, with no error anywhere.
    ///
    /// `generation == extraResolveHookGeneration` is true only when THIS
    /// caller's installation is still the live one — exactly mirroring
    /// Android's `Everframe.__pendingExtraResolveHook === extraResolveHook`
    /// reference check (`EverframeModule.kt:570-574`). Android gets that
    /// identity for free because each module INSTANCE owns a distinct
    /// closure object it can compare by reference; `EverframeBridge` is
    /// entirely `static` and has no such object, so a monotonically
    /// incrementing generation counter plays the same role. A `generation`
    /// of 0 (this caller's own `configure()` never successfully reached the
    /// install site) also no-ops, same as a stale one.
    ///
    /// When the guard passes: any continuations still pending (a report
    /// mid-ask-and-wait at teardown time) are resumed immediately instead of
    /// idling out their own 250ms fallback, since nothing will ever answer
    /// them now. When it fails, pending continuations are left alone too —
    /// they may belong to the FRESH instance's own in-flight ask, and its
    /// own 250ms fallback (already scheduled) is what will resolve them if
    /// JS doesn't.
    @objc public static func resetExtraResolverForTeardown(_ generation: Int) {
        extraResolveHookInstallLock.lock()
        let isCurrentInstallation = generation != 0 && generation == extraResolveHookGeneration
        extraResolveHookInstallLock.unlock()
        guard isCurrentInstallation else {
            os_log("[everframe] resetExtraResolverForTeardown: stale instance (generation %ld) — a newer configure() is already live; leaving it untouched",
                   log: log, type: .info, generation)
            return
        }

        extraResolverActiveLock.lock()
        extraResolverActive = false
        extraResolverActiveLock.unlock()

        Everframe.__pendingExtraResolveHook = nil

        pendingExtraResolveLock.lock()
        let stillPending = pendingExtraResolveContinuations
        pendingExtraResolveContinuations.removeAll()
        pendingExtraResolveLock.unlock()
        for (_, cont) in stillPending {
            cont.resume()
        }
    }

    /// Install-race fix (spec 2026-08-19 review finding 3). `configure()`
    /// (above) queues the PIN presenter install via
    /// `installPresenterResolverIfNeeded()`'s `DispatchQueue.main.async` —
    /// note that call marks `resolverInstalled = true` BEFORE the async block
    /// actually runs, so that flag alone cannot tell a caller here whether
    /// `CompanionPinPresenter.install()` (which sets
    /// `CompanionAPI.__builtinPinUiInstalled`) has genuinely finished.
    ///
    /// `startCompanion()` builds `RelayWSClient` and calls `connect()`
    /// synchronously right after this; `connect()`'s announce path reads
    /// `__builtinPinUiInstalled` from a freshly-spawned `Task` that can run
    /// before the main-queue-dispatched install block does, especially early
    /// in a host's launch sequence when the main queue is already busy. A
    /// host that calls `startCompanion()` immediately after `configure()`
    /// resolves — the ordinary RN lifecycle — would then read `false` for
    /// the capability check for the ENTIRE session, so `.builtin` mode would
    /// never advertise `supportsAttachPin` even though the presenter finishes
    /// installing moments later.
    ///
    /// Fix: synchronously hop to MainActor and call
    /// `CompanionPinPresenter.install()` directly — the same call
    /// `EFReporterPresenter.installResolver()` itself makes — and WAIT for
    /// it, before `startCompanion()` constructs the client. `install()` is
    /// `@MainActor` and idempotent (its own internal `installed` flag), so
    /// this is cheap on every call after the first: the common case (install
    /// already genuinely finished by the time `startCompanion()` runs) pays
    /// only a MainActor hop, not real work. Scoped to the smallest change
    /// that closes the race — `installPresenterResolverIfNeeded()`'s async
    /// dispatch and its own `resolverInstalled` flag are untouched, since
    /// `EFReporterPresenter.installResolver()` also wires the full modal
    /// reporter (openReporter's resolver), which this call does not need to
    /// duplicate or wait for.
    ///
    /// Gate: `#if canImport(UIKit)`, matching `CompanionPinPresenter.swift`'s
    /// own gate — NOT `#if !os(tvOS)`. Round-2 review finding 2: tvOS hosts
    /// are a PRIMARY consumer of companion (see `CompanionPinPresenter.swift`
    /// header + `RelayWSClient`'s), and only `EFReporterPresenter` (the full
    /// modal reporter, iOS-only — tvOS has no on-device modal) needs the
    /// `!os(tvOS)` exclusion `installPresenterResolverIfNeeded()` above
    /// correctly keeps. Gating THIS call the same way silently left RN-tvOS
    /// builtin hosts with `CompanionAPI.__builtinPinUiInstalled` permanently
    /// false, so `startCompanion()`'s announce always reported
    /// `supportsAttachPin: false` and every tvOS host fell back to legacy
    /// one-click attach even though `CompanionPinPresenter` builds and runs
    /// fine there.
    private static func ensurePinPresenterInstalledSync() {
        #if canImport(UIKit)
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                CompanionPinPresenter.install()
            }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated {
                    CompanionPinPresenter.install()
                }
            }
        }
        #endif
    }

    // MARK: - openReporter

    /// Opens the native reporter modal and resolves with the user's outcome.
    /// Routes through `Everframe.shared.report.open()` so any host-installed
    /// observers (`report.isPresenting`) fire on the same code path used by
    /// non-RN consumers.
    ///
    /// Result NSDictionary shape (matches JS facade ReporterResult):
    ///   - { status: "submitted", reportId: "<uuid>" }
    ///   - { status: "queued",    reportId: "<uuid>" }
    ///   - { status: "cancelled" }
    @objc public static func openReporter(
        completion: @escaping (NSDictionary?, NSError?) -> Void
    ) {
        os_log("[everframe] openReporter.enter", log: log, type: .info)
        guard Everframe.shared.captureGate else {
            completion(nil, NSError(
                domain: "EverframeBridge", code: 1100,
                userInfo: [NSLocalizedDescriptionKey: "Everframe not started (captureGate=false). Call configure() first."]
            ))
            return
        }

        // Defense-in-depth: configure should have installed already, but a
        // stray openReporter before configure (race in host useEffect order)
        // shouldn't deadlock on the un-installed resolver.
        installPresenterResolverIfNeeded()

        Task {
            do {
                let result = try await Everframe.shared.report.open()
                let dict: NSDictionary
                switch result {
                case .submitted(let id):
                    dict = ["status": "submitted", "reportId": id.uuidString]
                case .queued(let id):
                    dict = ["status": "queued", "reportId": id.uuidString]
                case .cancelled:
                    dict = ["status": "cancelled"]
                }
                completion(dict, nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    // MARK: - registerSensitiveRect

    /// Mark a view as sensitive. Routed through MainActor.assumeIsolated so the
    /// outer @objc static stays non-MainActor (MainActor-isolated @objc statics
    /// silently drop from the generated bridge header on Xcode 26.4 + Swift 5.10
    /// framework targets). Parameter is NSObject? rather than UIView? to also
    /// dodge the parallel UIView-typed-@objc-static skip path. The .mm callers
    /// always pre-dispatch to main and pass a real UIView; the inner cast is
    /// belt-and-suspenders.
    @objc(markSensitive:)
    public static func markSensitive(_ view: NSObject) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let uiView = view as? UIView else {
            os_log("[everframe] markSensitive: expected UIView, got %{public}@; ignoring",
                   log: log, type: .error, String(describing: type(of: view)))
            return
        }
        MainActor.assumeIsolated {
            guard Everframe.shared.captureGate else { return }
            os_log("[everframe] markSensitive view=%{public}@", log: log, type: .info, uiView)
            SensitiveRectRegistry.mark(uiView)
        }
    }

    // MARK: - reportCrash (Task 13 — crash/error reporting spec 2026-07-18)

    /// Crash/error reporting. Synchronous: the RN fatal path must finish
    /// persisting before RN's default handler aborts. Identifies itself as
    /// `everframe-react-native` (distinct from `CrashReporter.captureFacts`'s
    /// `"everframe-ios"` default) so envelopes are attributable to the RN SDK.
    @objc public static func reportCrash(_ crashJson: NSString) -> Bool {
        CrashReporter.captureFacts(json: crashJson as String, sdkName: "everframe-react-native")
    }

    /// Explicit handled capture acknowledges the core's completed encrypted enqueue.
    @objc public static func captureHandledException(_ crashJson: NSString) -> Bool {
        CrashReporter.captureHandledFacts(json: crashJson as String, sdkName: "everframe-react-native")
    }

    // MARK: - setExtra

    /// Forward an opaque string from JS into Everframe.shared.setExtra.
    /// Empty string clears the pending extra.
    @objc public static func setExtra(_ value: NSString) {
        let s = value as String
        if s.isEmpty {
            Everframe.shared.clearExtra()
        } else {
            Everframe.shared.setExtra(s)
        }
    }

    // MARK: - addBreadcrumb (Plan 4 / Task 14)

    /// Manual breadcrumb escape hatch. Forwards straight to
    /// `Everframe.shared.addBreadcrumb(message:kind:level:data:)` (Task 5) —
    /// NO validation/coercion happens here. That singleton already owns
    /// kind/level/data coercion AND gating (no-op pre-start / while killed),
    /// exactly like `setExtra`/`attachReactTree` above never re-check
    /// `captureGate` themselves. `data` crosses as an `NSDictionary?` — the
    /// codegen-typed `UnsafeObject` boundary for freeform objects; a
    /// non-dictionary payload (shouldn't happen via codegen, but fail-soft
    /// regardless) is treated as absent rather than crashing the bridge.
    @objc public static func addBreadcrumb(
        _ message: NSString,
        kind: NSString?,
        level: NSString?,
        data: NSDictionary?
    ) {
        let resolvedData = data as? [String: Any]
        Everframe.shared.addBreadcrumb(
            message: message as String,
            kind: kind as String?,
            level: level as String?,
            data: resolvedData
        )
    }

    // MARK: - setUser (self-declared identity — spec 2026-08-12)

    /// Forward a host-declared user from JS into `Everframe.shared.setUser`.
    /// Pure pass-through: the native singleton owns storage — NO
    /// validation/coercion happens here, same contract as `setExtra`/
    /// `attachReactTree` above. `nil` clears the active user (the bridge
    /// forbids `T | null`, so JS expresses "clear" by calling with no
    /// argument, which crosses as `nil` here). A missing key on the incoming
    /// dictionary must become `nil`, never an empty string — that's what
    /// keeps the Task 9 email-only `EFUser` shape (nullable `id`) usable.
    ///
    /// External review, finding 2 (Serious) — checked, and safe as written.
    /// The Android sibling had a real defect here: `ReadableMap.getString`
    /// THROWS on a non-string value, `txGuardVoid` swallowed the throw before
    /// `Everframe.setUser` was reached, and `setUser({ id: 12345 })` therefore
    /// left the PREVIOUS account installed. The conditional casts below cannot
    /// do that — `NSDictionary` subscripting doesn't throw and `as? String`
    /// yields `nil` for a number/dictionary/array — so a bad field degrades to
    /// a partial (or empty) user and `Everframe.shared.setUser` is ALWAYS
    /// reached, which is what makes the call replace rather than preserve. The
    /// JS facade projects to these three string fields before the bridge
    /// anyway (`src/user-projection.ts`); this is the second layer, aligned in
    /// behaviour with Android's `stringOrNull` helper.
    @objc public static func setUser(_ user: NSDictionary?) {
        guard let user else {
            Everframe.shared.setUser(nil)
            return
        }
        Everframe.shared.setUser(EFUser(
            id: user["id"] as? String,
            email: user["email"] as? String,
            displayName: user["displayName"] as? String
        ))
    }

    // MARK: - recordScreen (screen markers — spec 2026-07-14)

    /// Navigation screen marker. Forwards straight to
    /// `Everframe.shared.recordScreen(_:data:)` — NO validation/coercion
    /// here (blank-name drop, from→to derivation, gating, and data coercion
    /// all live in the core singleton). Fail-soft on a non-dictionary
    /// payload, same as `addBreadcrumb`.
    @objc public static func recordScreen(
        _ name: NSString,
        data: NSDictionary?
    ) {
        Everframe.shared.recordScreen(
            name as String,
            data: data as? [String: Any]
        )
    }

    // MARK: - Session Vitals (spec 2026-09-06)
    //
    // NOT HERE. The five vitals shims and their `RemotePlayerRegistry` used to live on this
    // class as `static` funcs over a `private static let` registry — one map for the whole
    // PROCESS. Codex round-1, C4 moved them to `RemoteVitalsBridge`, one instance per
    // `EverframeModule` instance, because React Native does not guarantee one module
    // instance: a process-wide registry made two React instances share a token space (the
    // second instance's `rp1` was silently refused) and made either one's `invalidate`
    // tear down the OTHER's players. See RemoteVitalsBridge.swift for the full rationale;
    // Android's module has always owned its registry as an instance field, and this is now
    // the same shape.

    @objc(markSensitiveViewOrWarn:)
    public static func markSensitiveViewOrWarn(_ view: NSObject?) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let v = view else {
            os_log("[everframe] markSensitive: view not found for tag (registry no-op)",
                   log: log, type: .info)
            return
        }
        markSensitive(v)
    }

    // MARK: - Companion (Plan 06.2-11)
    //
    // Bridge-side ownership of:
    //   • At most ONE live RelayWSClient against the configured ingest endpoint.
    //   • Combine subscriptions on `Everframe.shared.companion.$state`,
    //     `.$pairUrl`, `.$code` and `.$attachedUserName` that forward into
    //     `EverframeEventEmitter`.
    //
    // The Combine subscriptions are installed lazily on first `startCompanion`
    // and kept across stop/start cycles (the companion observable survives the
    // WS lifetime — see CompanionAPI.swift). This avoids missing the initial
    // values that may already be present from a prior start.
    //
    // Concurrency: a single NSLock guards `companionClient` + `companionCancellables`
    // mirrors the RelayWSClient internal locking pattern. NEVER called from
    // RN's JS thread directly — the .mm shim hops to MainActor below to satisfy
    // both `Everframe.shared.start` semantics and the RelayWSClient init/teardown
    // contract.

    private static let companionLock = NSLock()
    nonisolated(unsafe) private static var companionClient: RelayWSClient?
    /// The host's configured attach-PIN UI mode (spec 2026-08-19), parsed
    /// from `ConfigOpts.attachPinUi` at `configure()` time. Defaults to
    /// `.builtin` — the pre-existing-behaviour default for a host that never
    /// set the flag (including every host on an older RN SDK version whose
    /// `configure()` call carries no such field at all).
    nonisolated(unsafe) private static var companionAttachPinUi: AttachPinUi = .builtin
    // `CompanionCaptureBridge` subscribes to the report.request notification
    // posted by RelayWSClient and runs the capture+send dance. Without an
    // instance alive, report.request fires into the void → phone hangs on
    // "Capturing the TV screen" forever (Plan 06.2-11 bugfix).
    nonisolated(unsafe) private static var companionCaptureBridge: CompanionCaptureBridge?
    nonisolated(unsafe) private static var companionCancellables: Set<AnyCancellable> = []
    nonisolated(unsafe) private static var companionSubscriptionsInstalled = false

    /// Open a relay WS connection and start forwarding
    /// `Everframe.shared.companion` signals to the JS event emitter. Idempotent:
    /// if a client is already live this is a no-op — the socket is NOT
    /// recreated. Call `stopCompanion()` first to tear the existing connection
    /// down before a subsequent `startCompanion()` opens a fresh one.
    @objc public static func startCompanion(_ endpoint: NSString) {
        // The JS-side `endpoint` arg is ignored — RelayWSClient defaults
        // to the build-time-baked `IngestEndpoint.url`.
        _ = endpoint

        // MUST run before `RelayWSClient` is constructed below — see
        // `ensurePinPresenterInstalledSync()`'s doc comment for the race this
        // closes (finding 3, spec 2026-08-19 review).
        ensurePinPresenterInstalledSync()

        // Combine subscriptions install once and survive stop/start cycles;
        // safe to (re-)call on every start (self-guarded). MUST run OUTSIDE
        // `companionLock` — it self-acquires the same non-reentrant lock.
        installCompanionSubscriptionsIfNeeded()

        companionLock.lock()
        // Idempotent: a live client means a prior startCompanion already
        // opened the socket. Do NOT recreate it — callers must stopCompanion()
        // first. Holding the lock across the check + install keeps two racing
        // starts from both constructing a client (belt-and-suspenders; the
        // .mm shim already serialises this on MainActor).
        if companionClient != nil {
            companionLock.unlock()
            os_log("[everframe] startCompanion ignored — already running; call stopCompanion() first",
                   log: log, type: .info)
            return
        }
        os_log("[everframe] startCompanion (endpoint arg ignored)",
               log: log, type: .info)
        // Runtime suppression of the built-in PIN presenter (spec 2026-08-19,
        // controller ruling): a runtime flag, not an install-site gate.
        // `EFReporterPresenter.installResolver()` always installs
        // `CompanionPinPresenter` (see `installPresenterResolverIfNeeded()`
        // above) so `__builtinPinUiInstalled` stays an honest capability
        // signal regardless of the host's chosen mode — only the PRESENTING
        // is silenced, here, at the one site where the mode is already known
        // (configure() precedes startCompanion() in every host's lifecycle).
        Everframe.shared.companion.__setBuiltinPinUiSuppressed(companionAttachPinUi != .builtin)
        // Companion discovery (spec 2026-08-07): announcing is what makes this
        // device appear in the dashboard's Companion tab. It is opt-in on the
        // SDK key the host ALREADY configured via `configure()` — we never ask
        // for a second one. A nil key takes the ticketless path: RelayWSClient
        // builds no announcer and connects to plain `/relay/tv`, byte-identical
        // to pre-companion behaviour. Announce must never be able to break
        // reporting — no key means "no dashboard presence", never "no socket".
        let client = RelayWSClient(
            companion: Everframe.shared.companion,
            sdkKey: configuredSdkKey(),
            deviceLabel: companionDeviceLabel(),
            attachPinUi: companionAttachPinUi,
            // Naming spec 2026-08-24 — read off the same `currentConfig`
            // snapshot `configuredSdkKey()` above already reads, not a
            // second configuration surface. nil falls through to
            // RelayWSClient's own Keychain-then-stored-UUID chain.
            companionDeviceId: Everframe.shared.currentConfig?.companionDeviceId,
            // Companion on-screen name badge (naming spec 2026-08-24,
            // controller ruling / Task 6b) — same `currentConfig` snapshot,
            // read fresh at start time (a mode/toggle can't affect anything
            // before a relay client and its badge exist). `?? true` covers
            // the same "never configured" edge `configuredSdkKey()`'s own
            // optional chain already tolerates.
            companionBadge: CompanionBadgeOptions(
                enabled: Everframe.shared.currentConfig?.companionBadgeEnabled ?? true,
                position: Self.parseCompanionBadgePosition(Everframe.shared.currentConfig?.companionBadgePosition)
            )
        )
        // Wire the capture bridge BEFORE connecting so the report.request
        // notification observer is registered before the first frame can fire.
        let captureBridge = CompanionCaptureBridge(client: client)
        companionClient = client
        companionCaptureBridge = captureBridge
        companionLock.unlock()

        client.connect()
    }

    /// The SDK key the host already configured through `configure()`, or nil
    /// when there isn't a usable one. Read straight off `Everframe.shared`'s
    /// own config snapshot — deliberately NOT a second place a key can be
    /// configured, and NOT a new public surface (`currentConfig` is already
    /// public and read-only).
    ///
    /// Returns nil when `Everframe.start` never ran, and when the host
    /// configured a blank/whitespace-only key. Both are "no dashboard
    /// presence", never "no socket": RelayWSClient skips the announce hop
    /// entirely on a nil key and reporting is unaffected.
    private static func configuredSdkKey() -> String? {
        guard let appId = Everframe.shared.currentConfig?.appId,
              !appId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return appId
    }

    /// Non-personal device label for the dashboard's device list — "Apple TV",
    /// "iPhone", "iPad". Deliberately `UIDevice.current.model` and NOT
    /// `UIDevice.current.name`, which is commonly a person's name
    /// ("Aurimas's Apple TV") and would leak into a shared dashboard list as a
    /// side effect of turning companion on. The display code is the real
    /// disambiguator; the label is only a convenience.
    private static func companionDeviceLabel() -> String? {
        let model = UIDevice.current.model
        return model.isEmpty ? nil : model
    }

    /// Test-only — object identity of the live companion client, so tests can
    /// prove a repeat `startCompanion()` is a no-op (same instance, not
    /// recreated). Nil when no client is live.
    static func _companionClientIdentityForTesting() -> ObjectIdentifier? {
        companionLock.lock()
        defer { companionLock.unlock() }
        return companionClient.map(ObjectIdentifier.init)
    }

    /// JS handshake: called from the RN-bridge ObjC shim once the JS-side
    /// `everframe.companion.reportRequested` listener is ready for capture to
    /// proceed. Releases the CompanionCaptureBridge's bounded wait.
    @objc public static func signalCompanionReportRequestReady(_ correlationId: NSString) {
        CompanionCaptureBridge.signalReactTreeAttached(correlationId: correlationId as String)
    }

    /// Disconnect the active companion WS client (if any) and drop the
    /// reference. Combine subscriptions stay alive across stop/start cycles
    /// because the underlying CompanionAPI singleton on `Everframe.shared`
    /// outlives the WS — replaying any state changes that happen between
    /// stop and the next start would otherwise be lost from JS's view.
    @objc public static func stopCompanion() {
        os_log("[everframe] stopCompanion", log: log, type: .info)
        companionLock.lock()
        let client = companionClient
        companionClient = nil
        // Drop the capture bridge so its NotificationCenter observers
        // deregister (CompanionCaptureBridge cleans up in deinit).
        companionCaptureBridge = nil
        companionLock.unlock()
        client?.disconnect()
    }

    /// Install Combine sinks on `Everframe.shared.companion.$state`,
    /// `.$pairUrl`, `.$code` and `.$attachedUserName` that forward to
    /// `EverframeEventEmitter`. Idempotent — the
    /// `companionSubscriptionsInstalled` flag guards re-entry.
    ///
    /// `@Published` publishers fire `.sink` synchronously on the writer's
    /// thread (URLSession delegate queue, our `__setState` callsite). The
    /// emitter's `sendEvent(withName:body:)` is thread-safe (RN bridge
    /// enqueues onto the JS thread), so no main-thread hop is needed.
    private static func installCompanionSubscriptionsIfNeeded() {
        companionLock.lock()
        let alreadyInstalled = companionSubscriptionsInstalled
        companionSubscriptionsInstalled = true
        companionLock.unlock()
        guard !alreadyInstalled else { return }

        let companion = Everframe.shared.companion
        var bag = Set<AnyCancellable>()
        companion.$state
            .sink { state in
                // CompanionState.rawValue is camelCase (Swift's default for
                // String-backed enums) — `.reportInProgress` would cross to
                // JS as "reportInProgress" and silently fail the union match
                // in `src/companion.ts` (CompanionState = 'report_in_progress'
                // | ...). Map to snake_case at the bridge boundary so both
                // platforms emit the same JS-facing strings. Android does the
                // equivalent via `CompanionState.toRnString()` in
                // EverframeModule.kt.
                EverframeEventEmitter.sendState(Self.rnString(for: state))
            }
            .store(in: &bag)
        companion.$pairUrl
            .sink { url in
                EverframeEventEmitter.sendPairUrl(url)
            }
            .store(in: &bag)

        // Companion discovery (spec 2026-08-07). `CompanionState.swift` also
        // posts `.everframeCompanionCodeChange` /
        // `.everframeCompanionAttachedUserNameChange` for UIKit/ObjC hosts, but
        // we take the `@Published` route here for the same reason `$pairUrl`
        // does: a `Published.Publisher` replays its CURRENT value to a new
        // subscriber, so JS still learns a code that was already set by a
        // prior start. NotificationCenter has no replay and posts only on a
        // real change — subscribing there would silently lose exactly the
        // initial values this install-once-and-survive-stop/start design
        // exists to preserve.
        companion.$code
            .sink { code in
                EverframeEventEmitter.sendCode(code)
            }
            .store(in: &bag)
        companion.$attachedUserName
            .sink { name in
                EverframeEventEmitter.sendAttachedUserName(name)
            }
            .store(in: &bag)

        // Resolved device display name (naming spec 2026-08-24). Same
        // replay-on-subscribe rationale as `$code`/`$attachedUserName`
        // above — a `Published` publisher replays its CURRENT value to a
        // new subscriber, so JS still learns a name that was already
        // resolved by a prior announce.
        companion.$resolvedName
            .sink { name in
                EverframeEventEmitter.sendResolvedName(name)
            }
            .store(in: &bag)

        // Attach-PIN challenge (spec 2026-08-19). Same replay-on-subscribe
        // rationale as `$code`/`$attachedUserName` above — a `Published`
        // publisher replays its CURRENT value to a new subscriber, so a
        // `'custom'`-mode host that starts JS-side listening after the
        // challenge already arrived still learns about it.
        companion.$attachChallenge
            .sink { challenge in
                EverframeEventEmitter.sendAttachChallenge(challenge.map {
                    ["code": $0.code, "requestedByName": $0.requestedByName, "ttlMs": $0.ttlMs]
                })
            }
            .store(in: &bag)

        // Forward `report.request` arrival to JS so the companion module
        // can acknowledge before the bridge proceeds with native capture
        // (see CompanionCaptureBridge.awaitJsReactTreeAttach). The
        // CompanionCaptureBridge posts this notification at the top of
        // handleReportRequest and then awaits the JS callback up to
        // 250ms before falling through.
        NotificationCenter.default.publisher(
            for: CompanionCaptureBridge.shouldAttachReactTreeNotification
        )
        .sink { note in
            guard let corrId = note.userInfo?["correlation_id"] as? String else { return }
            EverframeEventEmitter.sendReportRequested(corrId)
        }
        .store(in: &bag)

        companionLock.lock()
        companionCancellables = bag
        companionLock.unlock()
        os_log("[everframe] installed companion Combine subscriptions",
               log: log, type: .info)
    }

    /// Map `CompanionState` to the snake_case payload string the JS facade
    /// expects (`'unpaired' | 'paired' | 'report_in_progress' |
    /// 'phone_disconnected'`). MUST match `EverframeModule.toRnString()` on
    /// Android. Not `@objc` — `CompanionState` is a Swift enum that does not
    /// bridge to ObjC; consumers call this from Swift only (the .mm shim sends
    /// already-stringified payloads to the event emitter).
    public static func rnString(for state: CompanionState) -> String {
        switch state {
        case .unpaired: return "unpaired"
        case .paired: return "paired"
        case .reportInProgress: return "report_in_progress"
        case .phoneDisconnected: return "phone_disconnected"
        }
    }

    // MARK: - Test seams (internal access via @testable import)

    /// Whether a RelayWSClient is currently owned by the bridge. The test
    /// target uses this to assert that `startCompanion(...)` installs the
    /// client and `stopCompanion()` drops it.
    @objc public static func _hasCompanionClientForTesting() -> Bool {
        companionLock.lock()
        defer { companionLock.unlock() }
        return companionClient != nil
    }

    /// Test-only reset for the Combine subscription latch + cancellables —
    /// XCTest creates a fresh bridge state per test method.
    @objc public static func _resetCompanionForTesting() {
        companionLock.lock()
        companionClient?.disconnect()
        companionClient = nil
        companionCancellables.removeAll()
        companionSubscriptionsInstalled = false
        companionAttachPinUi = .builtin
        companionLock.unlock()
        Everframe.shared.companion.__setBuiltinPinUiSuppressed(false)
    }
}
