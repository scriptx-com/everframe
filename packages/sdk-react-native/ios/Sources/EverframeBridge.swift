// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Swift glue layer for the React Native TurboModule bridge.
//
// CONTRACT (Plan 06-02 + D-05/D-07 flip 2026-05-11 — DO NOT widen without a
// new D-decision):
//
//   The RN bridge surface is the Phase 06 5-method TurboModule (configure,
//   openReporter, registerSensitiveRect, setExtra). The native
//   EFReporterPresenter owns the entire report UX (capture + annotate + redact +
//   submit) on iOS/iPadOS. On tvOS the on-device modal reporter was removed,
//   so openReporter() on tvOS resolves to .cancelled by way of the absent
//   presenter installer.
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
import CoreFoundation
import Combine
import os.log
import UIKit
import EverframeProtocol
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

    // Serialize the bridge's start/idempotence decision with synchronous health reservation.
    private static let configureLock = NSRecursiveLock()

    @objc public static func configure(
        sdkKey: NSString,
        endpoint: NSString,
        networkBodiesDisabled: Bool,
        installIdentifierDisabled: Bool,
        crashReportingDisabled: Bool,
        shakeToReportEnabled: Bool,
        quickCaptureEnabled: Bool,
        theme: NSDictionary?,
        vitalsEnabled: NSNumber?,
        vitalsSampleRate: NSNumber?,
        vitalsCaptureSourceQuery: NSNumber?,
        debugBuild: NSNumber?,
        releaseHealthEnabled: Bool,
        releaseHealthLoadedBuildId: NSString?,
        releaseHealthUserId: NSString?,
        releaseHealthIncludeDebugBuilds: Bool,
        jsBundleBuildId: NSString? = nil,
        jsBundleName: NSString? = nil,
        reporterDisabled: Bool = false,
        interactionsJson: NSString? = nil
    ) throws {
        configureLock.lock()
        defer { configureLock.unlock() }
        // `endpoint` arg is retained for ObjC ABI compatibility with the
        // codegen .mm — value is ignored. The SDK bakes the ingest URL at
        // compile time (sdk-ios IngestEndpoint).
        _ = endpoint
        os_log("[everframe] configure sdkKey=%{public}@", log: log, type: .info, sdkKey as String)
        // Polarity flips exactly once, here: JS sends the veto
        // (`networkBodiesDisabled`), native stores the permission.
        var cfg = EverframeConfig(sdkKey: sdkKey as String)
        cfg.interactions = InteractionEventPolicy.parse(interactionsJson as String?)
        cfg.loadedJsBundle = LoadedJsBundle(buildId: jsBundleBuildId as String?, bundleName: jsBundleName as String?)
        cfg.capture.networkBodies = !networkBodiesDisabled
        // Polarity flips exactly once, here: JS sends the veto
        // (`installIdentifierDisabled`), native stores the permission —
        // identical to `networkBodies` above.
        cfg.installIdentifierEnabled = !installIdentifierDisabled
        // Polarity flips exactly once, here: JS sends the veto
        // (`crashReportingDisabled`), native stores the permission.
        cfg.capture.crash = !crashReportingDisabled
        cfg.shakeToReportEnabled = shakeToReportEnabled
        cfg.quickCaptureEnabled = quickCaptureEnabled
        // Polarity flips exactly once, here: JS sends the crash-only switch
        // (`reporterDisabled`), native stores the permission.
        cfg.reporterEnabled = !reporterDisabled
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
        // Absent stays nil, so the native SDK detects a debug build itself; present wins.
        cfg.debugBuild = debugBuild?.boolValue
        let health: ReleaseHealthConfiguration?
        if releaseHealthEnabled, let loaded = releaseHealthLoadedBuildId {
            // The SDK reads the app version itself; the bridge carries the loaded bundle, the user ID and
            // whether debug builds count. A nil value (disabled, no loaded bundle, or an invalid identity) is off.
            health = try? ReleaseHealthConfiguration(userId: releaseHealthUserId as String?,
                loadedBuildId: loaded as String, loadedBundleStatus: .known,
                includeDebugBuilds: releaseHealthIncludeDebugBuilds)
        } else {
            health = nil
        }
        // The bridge owns release health through `health` alone: it needs the loaded Hermes bundle, and a new
        // user ID must reconfigure health without restarting the SDK. The native default
        // (`EverframeConfig.releaseHealth`, on) must not arm anonymous sessions at start or take part in
        // the unchanged-configuration comparison.
        cfg.releaseHealth = nil
        // Native code atomically checks installed config and reserves its exact owner.
        // An identical configure preserves the session.
        let applyHealth = try Everframe.shared.configureAndPrepareReleaseHealth(
            config: cfg, health: health, forceRestart: false)
        // Reservation is tied to this configure's exact native start generation. Later
        // configure/disable or a native restart invalidates the asynchronous operation.
        if let applyHealth {
            Task { _ = await applyHealth() }
        }
        installPresenterResolverIfNeeded()
        // Spec 2026-09-17 setExtra-resolver — installed unconditionally,
        // every configure(): this must cover the plain in-app openReporter()
        // path and native shake, both of which funnel through
        // Everframe.shared.report.open() → __consumePendingAttachments(). See `installExtraResolveHook()`'s own doc comment.
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

    /// Wires `EFReporterPresenter` as the resolver for `Everframe.shared.report
    /// .open()`. Called from configure(); the first call installs, subsequent
    /// calls no-op. tvOS has no on-device modal, so EverframeReporterUI's
    /// tvOS `installResolver()` is a no-op. The gate here skips that call.
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
        os_log("[everframe] tvOS — EFReporterPresenter not installed (no on-device reporter)", log: log, type: .info)
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
    /// Returns the fresh generation so `EverframeModule.mm`'s `-configureSync:`
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
    /// `EverframeModule.mm`'s `-configureSync:` calls this immediately after
    /// `configureWithSdkKey:...:error:` (which, on success or on the
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
    /// `signalExtraResolverReady`. A lock-guarded dictionary; the timeout
    /// resumes a continuation if JS never calls back.
    nonisolated(unsafe) private static var pendingExtraResolveContinuations:
        [String: CheckedContinuation<Void, Never>] = [:]
    private static let pendingExtraResolveLock = NSLock()

    /// Installed onto `Everframe.__pendingExtraResolveHook`. No-ops
    /// IMMEDIATELY — no event, no wait — unless JS has a resolver CURRENTLY
    /// registered (`extraResolverActive`), which is what keeps a
    /// string/object-only host's report path exactly as fast as before this
    /// feature landed (requirement: "no behaviour change whatsoever").
    ///
    /// Otherwise send `EverframeEventEmitter.sendExtraResolveRequested`, then
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
            // can't lose the race.
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
    /// after the 250ms fallback already fired is a harmless no-op.
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
    /// value `EverframeModule.mm`'s `-configureSync:` captured via
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
        openReporter(trigger: "button", completion: completion)
    }

    @objc(openReporterWithTrigger:completion:)
    public static func openReporter(trigger: String, completion: @escaping (NSDictionary?, NSError?) -> Void) {
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
                let result = try await Everframe.shared.report.open(trigger: ReporterTrigger(rawValue: trigger) ?? .button)
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
            } catch EverframeReporterError.reporterDisabled {
                completion(nil, NSError(
                    domain: "EverframeBridge", code: reporterDisabledErrorCode,
                    userInfo: [NSLocalizedDescriptionKey: EverframeReporterError.reporterDisabled.localizedDescription]
                ))
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    @objc public static func markReporterOpened(_ trigger: String, completion: @escaping @Sendable () -> Void) {
        guard let trigger = ReporterTrigger(rawValue: trigger) else { completion(); return }
        BreadcrumbRingBuffer.shared.reporterOpened(trigger: trigger, completion: completion)
    }

    @objc public static func markReporterClosed(_ completion: @escaping @Sendable () -> Void) {
        BreadcrumbRingBuffer.shared.reporterClosed(completion: completion)
    }

    /// `openReporter`'s error for a crash-only session (`reporterDisabled: true`).
    static let reporterDisabledErrorCode = 1101

    /// The promise rejection code for an `openReporter` failure. A crash-only session gets
    /// `EVERFRAME_REPORTER_DISABLED`, which the JS facade maps to
    /// `EverframeReporterDisabledError`; anything else keeps `open_reporter_failed`.
    @objc(openReporterRejectCodeFor:)
    public static func openReporterRejectCode(for error: NSError) -> String {
        error.domain == "EverframeBridge" && error.code == reporterDisabledErrorCode
            ? "EVERFRAME_REPORTER_DISABLED" : "open_reporter_failed"
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

    /// Cached, content-free native delivery facts. Encoding failure is rejected by JS.
    @objc public static func getReportDeliveryStatusJson() -> NSString {
        ((try? Everframe.shared.getReportDeliveryStatus().toJSON()) ?? "{}") as NSString
    }

    // MARK: - reportCrash (Task 13 — crash/error reporting spec 2026-07-18)

    /// Crash/error reporting. Synchronous: the RN fatal path must finish
    /// persisting before RN's default handler aborts. Identifies itself as
    /// `everframe-react-native` (distinct from `CrashReporter.captureFacts`'s
    /// `"everframe-ios"` default) so envelopes are attributable to the RN SDK.
    @objc public static func reportCrash(_ crashJson: NSString) -> Bool {
        let facts = crashJson as String
        // Replays on errors (spec 2026-10-11): only an error the app survives asks for a replay of the seconds
        // before it. A fatal JavaScript error ends the app, so it is a crash and never carries one.
        guard appSurvivesError(facts) else {
            return CrashReporter.captureFacts(json: facts, sdkName: "everframe-react-native", attachReplay: false)
        }
        return CrashReporter.captureFacts(json: facts, sdkName: "everframe-react-native", attachReplay: true)
    }

    /// Explicit handled capture acknowledges the core's completed encrypted enqueue. It is always an error the
    /// app survives, so it asks for a replay; the core decides whether the session qualifies.
    @objc public static func captureHandledException(_ crashJson: NSString) -> Bool {
        CrashReporter.captureHandledFacts(json: crashJson as String, sdkName: "everframe-react-native", attachReplay: true)
    }

    /// True when the facts describe an error the app survives: `fatal` is absent or the JSON boolean `false`,
    /// which is how `CrashReporter` classifies facts that are not marked fatal. Anything unreadable counts as
    /// fatal here, so it can only lose a replay, never ask for one on a crash.
    static func appSurvivesError(_ facts: String) -> Bool {
        guard let data = facts.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        guard let flag = object["fatal"] else { return true }
        guard let boolean = flag as? NSNumber,
              CFGetTypeID(boolean) == CFBooleanGetTypeID() else { return false }
        return !boolean.boolValue
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
    /// exactly like `setExtra` above never re-checks
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
    /// validation/coercion happens here, same contract as `setExtra`
    /// above. `nil` clears the active user (the bridge
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
    @objc public static func setStateSync(_ key: String, valueJson: String) -> Bool {
        guard valueJson.utf8.count <= 2048, let data = valueJson.data(using: .utf8),
              let value = try? JSONDecoder().decode(EverframeStateValue.self, from: data) else { return false }
        return Everframe.shared.setState(key, value: value)
    }
    @objc public static func clearStateSync(_ key: String) -> Bool { Everframe.shared.clearState(key) }

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
}
