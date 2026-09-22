// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Native video lifecycle and shared remote-config coordination.
import Foundation
import TraceItXProtocol

#if canImport(UIKit)
import UIKit

/// A tiny shared, synchronously-readable config box. The lifecycle's `getConfig`
/// closure reads it; a background task refreshes it from the fail-closed provider.
/// Starts at the OFF default so a never-resolved fetch leaves replay disabled.
@MainActor
private final class ConfigBox {
    var value: ReplayConfig = .off
}

/// Live session-replay coordinator. One per SDK session (owned by `TraceItX`).
@MainActor
public final class ReplaySession: NSObject {

    private let provider: ReplayConfigProvider
    private let video: NativeVideoSession
    private let locallyDisabled: Bool
    private let configBox: ConfigBox
    private var backgrounded = false
    private var memoryPressure = false

    /// Report Resource Window (spec 2026-09-05) — CPU/memory sampler feeding
    /// `ResourceRingBuffer.shared`. Owned for the session's whole lifetime
    /// (cheap: a plain NSLock object, no `Timer`/observers allocated until
    /// `start()` runs). Started/stopped on every
    /// `applyConfig` per the server's LIVE `resources.enabled`, same seam
    /// `windowSec` already uses — see `applyConfig`'s doc comment. `start()`/
    /// `stop()` are idempotent, so calling either on every refresh (even when
    /// nothing changed) is a harmless no-op.
    ///
    /// `windowProvider` reads `ResourceRingBuffer.shared.windowSec` back —
    /// NOT the raw config — so there is exactly one writer of that property
    /// (`applyConfig`, right below) and the sampler's own re-assignment of it
    /// on every tick is a no-op re-affirmation, never a second, potentially
    /// divergent source of truth.
    private let resourceSampler = ResourceWindowSampler(windowProvider: { ResourceRingBuffer.shared.windowSec })

    /// Test-only observability seam (mirrors `NetworkBodyCaptureGate.isActive`
    /// via `.shared`) — whether the resource sampler is currently armed.
    /// `internal`, not `public`: visible only via `@testable import`.
    internal var __resourceSamplerIsRunningForTesting: Bool { resourceSampler.isRunning }

    /// The live per-app config as last resolved by `refreshConfigNow()` —
    /// `.off` until the first successful fetch. Native identity Task 8b:
    /// this is the ONE source `TraceItX.currentReplayConfig()` reads to
    /// resolve `resolveIdentityHeader`'s `config:` parameter at every submit
    /// path (live, drain, crash), so the identity gate and the session-replay
    /// gate always agree on which fetch is "current."
    internal var currentConfig: ReplayConfig { configBox.value }

    /// The running periodic re-read loop (nil until `enableIfConfigured()` has
    /// been called once). Cancelled in `deinit` so it never outlives the
    /// session.
    private var refreshLoopTask: Task<Void, Never>?

    /// The initial refresh task kicked off by `enableIfConfigured()` (nil
    /// until then). Retained — and cancelled in `deinit`/`teardown()`
    /// alongside `refreshLoopTask` — for the same reason `refreshLoopTask`
    /// is: an unretained `Task` still runs to completion even after every
    /// OTHER strong reference to this object is gone, because `await`ing
    /// inside the task body re-derives a strong reference from its captured
    /// `weak self` for the duration of the await. Retaining the handle lets
    /// `teardown()` cancel it explicitly. Cancellation alone is still not
    /// sufficient to close the underlying race, though — see `epoch` below
    /// (round-3 review Finding F13, 2026-08-01-network-body-capture-native).
    private var initialRefreshTask: Task<Void, Never>?

    /// Monotonically increasing per-session generation counter, bumped
    /// exactly once by `teardown()`. Mirrors `TraceItX._startEpoch`
    /// (round-2 review Finding F9, commit 826e5f76) one level down: that
    /// epoch guards `TraceItX.start()`'s async tail against installing a
    /// `ReplaySession` after a racing `kill()`; THIS epoch guards a single
    /// already-installed session's OWN in-flight `refreshConfigNow()`
    /// against applying a stale fetch result after the session itself has
    /// been torn down.
    ///
    /// Round-3 review Finding F13: `refreshConfigNow()`'s
    /// `await provider.refresh(force: true)` promotes its captured `self`
    /// to a strong reference for the duration of the await — neither
    /// cancellation nor `deinit` can pre-empt that. A `kill()` (or any
    /// other teardown) that lands mid-await must therefore be observable to
    /// the STILL-RUNNING task once its await resolves, so it refuses to
    /// re-arm process-global state (the network-body gate, its ring
    /// buffer's byte budget, the breadcrumb config) off a response fetched
    /// for a session nothing owns anymore. `refreshConfigNow()` captures
    /// this epoch synchronously before its first `await` and re-checks it
    /// (plus `Task.isCancelled`) immediately before any global apply —
    /// session-local state (the `configBox` snapshot,
    /// `startBufferingIfEligible()`) is inert once nothing points at this
    /// session, so it is not gated.
    private var epoch = 0

    /// Set once by `teardown()`; makes it idempotent so a `deinit` firing
    /// after an explicit `teardown()` call (or a second `teardown()` call)
    /// is a harmless no-op.
    private var isTornDown = false

    /// Test-only seam (round-8 review Finding F39) — when set,
    /// `refreshConfigNow()` awaits this closure immediately after its epoch
    /// checks pass and BEFORE calling `NetworkBodyCaptureGate.shared
    /// .applyConfig(...)`. `start()`/`kill()` are synchronous, non-actor-
    /// isolated methods that can run on a background thread concurrently
    /// with this `@MainActor` method — this hook lets a test race such a
    /// call into EXACTLY that gap deterministically instead of hoping a
    /// guessed sleep lands there. `nil` in production — the tail proceeds
    /// straight through with no added delay. The fresh guard evaluated
    /// INSIDE `applyConfig`'s own critical section (not the now-possibly-
    /// stale check above this hook) is what actually protects the mutation;
    /// this hook only widens the window so a test can hit it reliably.
    internal var preApplyHookForTesting: (() async -> Void)?

    /// Round-6 review Finding F27 — the GLOBAL `TraceItX._startEpoch` value
    /// current at the moment this session was constructed (see
    /// `TraceItX.currentStartEpoch`'s doc comment for the full rationale).
    /// Captured once, at `init`, and compared against the CURRENT global
    /// epoch inside `refreshConfigNow()`, synchronously, before any
    /// process-global apply — this is what makes a superseding
    /// `start()`/`kill()` visible to an in-flight refresh the instant it
    /// runs, independent of whether THIS session's own `teardown()` has
    /// been called yet.
    private let startEpochAtCreation: Int

    /// Cadence of the periodic re-read loop — matches the remote config TTL
    /// (spec §3: "Remote kill-switch works without an app update (config TTL
    /// 300 s)"). Each tick calls `refresh(force: true)` so a real fetch is
    /// attempted every interval (a non-forced refresh would race the TTL and
    /// halve the effective cadence).
    private static let periodicRefreshIntervalNanos: UInt64 = 300_000_000_000

    /// - Parameter startEpoch: the GLOBAL `TraceItX._startEpoch` value this
    ///   session should be considered created under (round-6 review Finding
    ///   F27). No default here — `currentStartEpoch` is `internal`, so a
    ///   default-argument expression referencing it cannot appear on a
    ///   `public` declaration (Swift access-level rule); the internal
    ///   `init(provider:locallyDisabled:startEpoch:)` below has the
    ///   convenience default instead. This initializer's one production call
    ///   site (`TraceItX.swift`'s `start()`) always passes the EXACT epoch
    ///   value it just verified via its `stillCurrent` guard anyway.
    public convenience init(
        baseURL: URL, apiKey: String, locallyDisabled: Bool,
        startEpoch: Int,
        installIdProvider: @escaping @Sendable () -> String? = { nil }
    ) {
        self.init(
            provider: ReplayConfigProvider.make(
                baseURL: baseURL, apiKey: apiKey, installIdProvider: installIdProvider
            ),
            locallyDisabled: locallyDisabled,
            startEpoch: startEpoch
        )
    }

    /// Source-compatibility overload preserving the pre-F27 public signature.
    /// `startEpoch` could not be given a default argument on the initializer
    /// above (Swift forbids a `public` default-argument expression referencing
    /// the `internal` `currentStartEpoch`), but an overload whose *body*
    /// reads it is fine — so external callers written against the original
    /// three-parameter form keep compiling, adopting the current global epoch.
    public convenience init(baseURL: URL, apiKey: String, locallyDisabled: Bool) {
        self.init(
            baseURL: baseURL, apiKey: apiKey, locallyDisabled: locallyDisabled,
            startEpoch: TraceItX.shared.currentStartEpoch
        )
    }

    /// Test seam: construct with a pre-built `ReplayConfigProvider` (e.g. wired
    /// to a stub `URLSessionFetching` + injectable clock) so specs can drive
    /// `refreshConfigNow()` deterministically — flip the server response
    /// between calls and assert the gate reacts — without a real network call
    /// or waiting on the 300s periodic loop. Not `public`; visible only via
    /// `@testable import`.
    ///
    /// `startEpoch` defaults to the CURRENT global start epoch at
    /// construction time (round-6 review Finding F27) — see the public
    /// initializer's doc comment above.
    init(
        provider: ReplayConfigProvider, locallyDisabled: Bool,
        startEpoch: Int = TraceItX.shared.currentStartEpoch
    ) {
        self.provider = provider
        self.video = NativeVideoSession()
        self.locallyDisabled = locallyDisabled
        self.configBox = ConfigBox()
        self.startEpochAtCreation = startEpoch
        super.init()
        // A host can restart the SDK while a report is still being composed.
        // tvOS has no modal presenter: the companion owns that same freeze.
        if TraceItX.shared.report.isPresenting || CompanionCaptureBridge.hasActiveReportCapture {
            video.freeze()
        }
        for name in [UIApplication.didEnterBackgroundNotification,
                     UIApplication.didBecomeActiveNotification,
                     UIApplication.didReceiveMemoryWarningNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(runtimeChanged(_:)), name: name, object: nil)
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(thermalStateChanged),
            name: ProcessInfo.thermalStateDidChangeNotification, object: nil
        )
    }

    deinit {
        // Belt-and-suspenders: `teardown()` (called explicitly from
        // `TraceItX.kill()`'s MainActor hop — see its doc comment) is the
        // primary defense against a stale in-flight fetch, via the `epoch`
        // guard. This is a courtesy for any other path that drops the last
        // strong reference without going through `teardown()` first, so the
        // loop/initial-fetch tasks stop promptly rather than waiting on
        // their own `weak self` checks (up to ~300s for the periodic loop).
        refreshLoopTask?.cancel()
        initialRefreshTask?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    /// Explicit, synchronous (on `MainActor`) teardown — called from
    /// `TraceItX.kill()`'s MainActor hop immediately before nil'ing out its
    /// reference to this session (round-3 review Finding F13). Do not rely
    /// on `deinit` alone for this: ARC only deinits once every strong
    /// reference is gone, and an in-flight `refreshConfigNow()` `await`
    /// holds exactly such a reference for as long as its network call is
    /// outstanding — `deinit` can therefore run arbitrarily late, well
    /// after a stale fetch has already resolved and tried to apply itself.
    /// Bumping `epoch` here takes effect immediately regardless of when (or
    /// whether) `deinit` eventually runs. Also stops and revokes native video
    /// capture and stops the resource sampler (spec 2026-09-05). The resource
    /// sampler is NOT stopped by `freezeForReporter()`; see this
    /// function's body for why. Idempotent — safe to call more than once
    /// (e.g. once explicitly from `kill()`, once again if `deinit` also
    /// fires before the object is fully released).
    func teardown() {
        guard !isTornDown else { return }
        isTornDown = true
        epoch += 1
        initialRefreshTask?.cancel()
        refreshLoopTask?.cancel()
        initialRefreshTask = nil
        refreshLoopTask = nil
        // Report Resource Window (spec 2026-09-05) — same "everything stops"
        // posture as native video: kill()/a superseding
        // start() must genuinely stop sampling, not merely let it keep
        // ticking into a ring whose `append` happens to no-op once the
        // capture gate closes (`ResourceRingBuffer.shared.honorsKillGate`
        // already covers that as defense in depth; this stops the actual
        // timer so no CPU/battery is spent polling task_info either).
        // Deliberately NOT added to `freezeForReporter()`:
        // that one exists so the reporter's OWN UI is never recorded by
        // session replay, not to pause sampling — the resource window
        // should keep sampling right up to submit time.
        resourceSampler.stop()
        // NativeVideoSession owns capture and frozen claims. stop() invalidates
        // their generation, cancels pending work and revokes transferred claims.
        video.stop()
        NotificationCenter.default.removeObserver(self)
    }

    // Foundation posts thermal changes on a global dispatch queue. The
    // selector must not enter MainActor until it has marshalled delivery.
    @objc nonisolated private func thermalStateChanged() {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isTornDown,
                  self.startEpochAtCreation == TraceItX.shared.currentStartEpoch else { return }
            self.updateSuspension()
        }
    }

    @objc private func runtimeChanged(_ notification: Notification) {
        guard !isTornDown else { return }
        switch notification.name {
        case UIApplication.didEnterBackgroundNotification: backgrounded = true
        case UIApplication.didBecomeActiveNotification: backgrounded = false; memoryPressure = false
        case UIApplication.didReceiveMemoryWarningNotification: memoryPressure = true
        default: break
        }
        updateSuspension()
    }

    private func updateSuspension() {
        let thermal = ProcessInfo.processInfo.thermalState
        video.setSuspended(backgrounded || memoryPressure || thermal == .serious || thermal == .critical)
    }

    /// Kick off a background config refresh, then — if the lifecycle starts
    /// buffering — spin up the adaptive tick. Safe to call once at SDK start().
    /// Also arms the periodic re-read loop (see `startPeriodicRefreshLoop()`)
    /// so the remote kill-switch (spec §3) takes effect within one config TTL
    /// instead of only at the next process launch.
    public func enableIfConfigured() {
        backgrounded = UIApplication.shared.applicationState == .background
        updateSuspension()
        initialRefreshTask = Task { [weak self] in
            await self?.refreshConfigNow()
        }
        startPeriodicRefreshLoop()
    }

    /// Re-invokes the SAME refresh seam as the initial call above, on a
    /// ~300s cadence, for as long as the session is alive. This is what makes
    /// the remote kill-switch (and any other live config change) actually
    /// take effect during a long-lived session rather than only once at
    /// start() — the config TTL (spec §3) is meaningless if nothing ever
    /// re-reads it.
    ///
    /// Re-invoking the seam repeatedly is safe: the loop sleeps a full
    /// interval between forced fetches (no hammering); `ReplayLifecycle
    /// .tryStart()` guards every non-IDLE state, so a session already
    /// buffering/frozen/etc. is unaffected; the breadcrumb and body-gate
    /// `applyConfig()` calls are documented as live-config-safe; and the
    /// body-gate's sampling draw is one-shot sticky (drawn at most once,
    /// never re-drawn by a later `applyConfig` — see NetworkBodyCaptureGate's
    /// file header), so re-reading config can only ever turn capture OFF for
    /// an already-sampled-in session, never flip it in either direction on
    /// sampling itself.
    ///
    /// `[weak self]` + the `deinit` cancellation above ensure the loop never
    /// retains the session past teardown.
    private func startPeriodicRefreshLoop() {
        guard refreshLoopTask == nil else { return }
        refreshLoopTask = Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: ReplaySession.periodicRefreshIntervalNanos)
                if Task.isCancelled { return }
                guard let self else { return }
                await self.refreshConfigNow()
            }
        }
    }

    /// The refresh seam itself: re-read the remote config, apply it live to
    /// the breadcrumb + network-body-capture gates, and let the lifecycle
    /// (re-)start buffering if newly eligible. `internal` (not `private`) so
    /// specs can invoke it directly instead of waiting on the periodic loop.
    /// Runs on `MainActor` (this class is `@MainActor`), so — unlike the
    /// ad-hoc `Task { }` closure this was factored out of — no explicit
    /// `MainActor.run` hop is needed for the `configBox` / lifecycle writes.
    func refreshConfigNow() async {
        // Round-3 review Finding F13 — capture the generation this call was
        // armed under BEFORE the first `await` below (synchronously, so no
        // teardown can land between "read epoch" and "start awaiting"); see
        // `epoch`'s doc comment for why this specific spot is what makes the
        // guard below meaningful.
        let capturedEpoch = epoch

        // Final-review Finding 4 (polling at TTL doubles latency): force the
        // fetch rather than letting it race the provider's own TTL gate. The
        // periodic loop already sleeps exactly one TTL between calls, so an
        // unforced `refresh()` here was always just-under-TTL at each wake
        // and silently no-op'd — the remote kill-switch only ever actually
        // took effect every SECOND wake (~600s), not every wake (~300s).
        // `force: true` still records `lastFetchedAt`, so this stays in step
        // with any other (non-forced) caller of the same provider.
        let succeeded = await provider.refresh(force: true)
        let latest = await provider.current

        // Round-3 review Finding F13: both `await`s above can outlive this
        // session's teardown — `await`ing re-derives a strong `self` from a
        // `weak` capture (initial path) or is the last statement before a
        // `weak self` re-check that never gets a chance to run again until
        // the NEXT periodic tick (periodic path), so neither cancellation
        // nor `deinit` reliably pre-empts a fetch already in flight when
        // `teardown()` runs. Bail out here, before touching ANY
        // process-global state below (the network-body gate, its ring
        // buffer's byte budget, the breadcrumb config), if this call's
        // generation is no longer current or the task was cancelled — a
        // stale response must not re-arm globals for a session nothing
        // owns anymore.
        guard !Task.isCancelled, epoch == capturedEpoch else { return }

        // Round-6 review Finding F27: the session-local `epoch` check above
        // is NOT sufficient by itself to detect supersession by a NEWER
        // `start()` — this session's OWN `teardown()` (which bumps `epoch`)
        // is only requested via a `Task { @MainActor in ... }` dispatched
        // from `start()`'s synchronous section, not run synchronously
        // there (see that method's doc comment for why: `_replaySession`
        // is MainActor-isolated and `start()` must stay synchronous). This
        // continuation can resume on MainActor and reach this exact point
        // BEFORE that dispatched teardown task ever runs — at which point
        // `epoch == capturedEpoch` above still (correctly, as far as THIS
        // session knows) holds, even though a `start(B)` has already
        // superseded this session's app/config entirely.
        //
        // `TraceItX.shared.currentStartEpoch` closes that gap: it is bumped
        // SYNCHRONOUSLY inside `start()`/`kill()` themselves (no dispatch,
        // no await), so it is guaranteed to already reflect a superseding
        // `start()`/`kill()` by the time this line runs, regardless of
        // whether this session's own teardown task has been scheduled yet,
        // let alone executed. Checked here — synchronously, no `await`
        // between this check and the applies below (this class is
        // `@MainActor` with no suspension point in between) — so no
        // interleaving is possible between "check" and "apply".
        guard TraceItX.shared.currentStartEpoch == startEpochAtCreation else { return }

        // Round-8 review Finding F39 test seam — see `preApplyHookForTesting`'s
        // doc comment. No-op in production (`nil`).
        if let hook = preApplyHookForTesting {
            await hook()
        }

        // Task 5 (CONFIG gating): breadcrumb capture gates independently
        // of the replay ON/OFF decision below — this is the one seam in
        // the iOS SDK where a freshly-fetched `ReplayConfig` is read, so
        // apply its `breadcrumbs` block here on every read (live gating).
        // BreadcrumbRingBuffer is its own NSLock, not MainActor-isolated,
        // so no hop is needed for this call. Breadcrumbs intentionally keep
        // last-good semantics on a failed fetch (unchanged by Finding 5) —
        // `latest` is whatever the provider's fail-closed cache holds
        // either way.
        BreadcrumbRingBuffer.shared.applyConfig(latest.breadcrumbs)
        // Report Resource Window (spec 2026-09-05) — negotiation-gap fix:
        // `windowSec` is read LIVE here on every resolved config, the same
        // way `applyImageConfig` below reads `configBox.value.replayDurationSec`
        // rather than capturing it once. `ResourceRingBuffer.shared.windowSec`
        // is itself a lock-guarded, mutable property (Task 10) precisely so
        // this assignment applies to every subsequent append/snapshot with
        // no SDK restart. Same last-good semantics as breadcrumbs above: a
        // failed fetch keeps whatever `latest` already holds (the provider's
        // own fail-closed cache), never an explicit reset to the default.
        ResourceRingBuffer.shared.windowSec = latest.resources?.windowSec ?? ResourceRingBuffer.defaultWindowSec
        // Gate the sampler itself on the LIVE `enabled` flag — an app with
        // the feature switched off must do no sampling work at all, not just
        // ship an empty/absent `payload.resources`. Same last-good semantics
        // as `windowSec` immediately above (a failed fetch keeps whatever
        // `latest` already holds); `start()`/`stop()` are idempotent, so
        // re-issuing the same call on every refresh is harmless. Flipping
        // `enabled` false -> true on a later refresh starts sampling with no
        // SDK restart — this `applyConfig` call is reached by BOTH the
        // initial fetch (`enableIfConfigured()`) and the ~300s periodic loop.
        if latest.resources?.enabled == true {
            resourceSampler.start()
        } else {
            resourceSampler.stop()
        }
        // Network-body capture gate (Task 8): same live-gating seam as
        // breadcrumbs above — server block + client veto
        // (CaptureConfig.networkBodies, read off the MainActor-free
        // TraceItX.shared.currentConfig snapshot) + one-shot sampling.
        // NetworkBodyCaptureGate is its own NSLock, not MainActor-
        // isolated, so no hop is needed for this call either.
        //
        // Final-review Finding 5 (failed refresh must fail the body gate
        // closed): the provider's fail-closed contract means `latest` keeps
        // its LAST-GOOD value even when `succeeded == false` — reapplying
        // that stale value here would keep re-arming an already-ON gate
        // forever off a config we just failed to confirm is still current.
        // On a failed fetch we instead apply a nil server block, which
        // deactivates the gate (fail-closed) WITHOUT clearing the one-shot
        // sticky sampling draw (see NetworkBodyCaptureGate.applyConfig —
        // the draw is only ever set on a `serverOn` branch, never cleared on
        // a nil/off one), so a later successful ON read reactivates without
        // re-drawing.
        // Round-5 review Finding F22: `locallyDisabled` combines BOTH client
        // preconditions from spec §3 (`capture.network == true` AND
        // `capture.networkBodies != false`), not the veto alone — see
        // `NetworkBodyCaptureGate.locallyDisabled(for:)`'s doc comment for
        // why `capture.network` can't be treated as structural.
        // Round-6 review Finding F28: ALSO OR in `breadcrumbsExcludeNetwork`
        // — bodies are meaningless without a correlating network breadcrumb
        // (EnvelopeBuilder drops any unmatched `ref`), so a server config
        // that enables bodies while breadcrumbs are off/network-excluding
        // must keep the CAPTURE gate off too, not just filter at encode
        // time. `latest.breadcrumbs` is the exact same value just applied to
        // `BreadcrumbRingBuffer.shared` above, so this reads the live
        // breadcrumbs gating this session will actually get.
        // Round-8 review Finding F39: `guard` is re-evaluated FRESH, INSIDE
        // `applyConfig`'s own lock, immediately before the mutation — this is
        // what actually closes the window between the one-off
        // `currentStartEpoch` check above and this call landing, not the
        // check above by itself (see `applyConfig`'s doc comment for the
        // full rationale, and `startEpochAtCreation`'s for why a session-
        // local check alone isn't enough).
        NetworkBodyCaptureGate.shared.applyConfig(
            succeeded ? latest.networkBodies : nil,
            samplingRate: latest.samplingRate,
            locallyDisabled: NetworkBodyCaptureGate.locallyDisabled(for: TraceItX.shared.currentConfig)
                || NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(latest.breadcrumbs)
        ) { [startEpochAtCreation] in
            TraceItX.shared.currentStartEpoch == startEpochAtCreation
        }
        NetworkBodyRingBuffer.shared.setTotalBudget(
            latest.networkBodies?.bodyTotalBudget ?? 262_144)
        configBox.value = latest
        // Companion badge dashboard override (plan 2026-08-25) — snapshot the
        // block for CompanionBadge's sync show-time read; see
        // CompanionBadgeServerConfigBox's own doc for why a box and not
        // currentReplayConfig().
        //
        // Codex round-2 fix — `kill()` now clears this same box (TraceItX
        // .swift), but only from an async `Task { @MainActor in ... }`
        // dispatched AFTER `kill()`'s synchronous section returns (unlike
        // `start()`'s session-boundary reset, which clears it
        // synchronously). A call parked at `preApplyHookForTesting` just
        // above — between the `currentStartEpoch` check a few lines up and
        // this write — can otherwise resume AFTER kill()'s async clear has
        // already landed and resurrect the stale override, with no live
        // session left to overwrite it again. Re-check immediately before
        // writing, mirroring this SAME `currentStartEpoch` comparison
        // exactly as performed a few lines above — no new epoch machinery,
        // just closing the gap between that check and this specific write.
        guard TraceItX.shared.currentStartEpoch == startEpochAtCreation else { return }
        CompanionBadgeServerConfigBox.shared.value = latest.companionBadge
        // Branding (iOS spec 2026-08-26) — same parked-continuation hazard,
        // same guard as the companion write immediately above. The reporter
        // resolves this box once at presentation time (Approach A), so this
        // write is what a NEXT open observes.
        BrandingServerConfigBox.shared.value = latest.branding
        // Session Vitals (iOS spec 2026-09-05 §1) — same commit-site snapshot.
        // The predicate re-runs the SAME `currentStartEpoch == startEpochAtCreation`
        // comparison as the guard above, but INSIDE the box's own gate,
        // atomically with the write (Android codex round-4, #4): a start()/kill()
        // clear landing between the guard and this line must win.
        VitalsServerConfigBox.shared.publish(latest.toVitalsServerConfig()) {
            TraceItX.shared.currentStartEpoch == startEpochAtCreation
        }
        ShakeToReportTrigger.shared.publish(remoteEnabled: latest.shakeToReport?.enabled) {
            TraceItX.shared.currentStartEpoch == startEpochAtCreation
        }
        video.apply(
            settings: locallyDisabled ? nil : effectiveNativeVideo(config: latest, fetchConfirmed: succeeded),
            durationSec: latest.replayDurationSec,
            samplingRate: latest.samplingRate
        )
        // Independent review, round 4 (Serious 3) — mirrors the `configBox.value`
        // write above (now ahead of `applyImageConfig` — see Task 4 fix round 1's
        // comment there), but into a plain NSLock-protected flag
        // `captureUserSnapshot()` can read synchronously without a MainActor
        // hop (see `TraceItX._identityEnabledFlag`'s doc comment).
        //
        // Independent review, round 11, P1(b) — the epoch guard just above
        // is a ONE-OFF check, taken BEFORE this write, not evaluated AT it:
        // `start()`/`kill()` are synchronous and NOT actor-isolated, so one
        // can run concurrently on a background thread, bump the global
        // epoch, and reset this flag to `false` — landing AFTER the check
        // above but BEFORE this line runs — only for THIS (now-superseded)
        // session's write to silently overwrite it back to `true`. Passing
        // the SAME `guard` closure `NetworkBodyCaptureGate.applyConfig` above
        // already uses re-evaluates the identical epoch comparison atomically
        // WITH this mutation, inside `IdentityEnabledFlag`'s own lock, closing
        // that window regardless of how much real time elapses between the
        // one-off check above and this call.
        // Independent review, round 17, New — a host installing a
        // `.provider` immediately after `start()` (the documented,
        // recommended integration) finds identity disabled: config has not
        // been fetched yet, so the install-time warm
        // (`TraceItX.__warmIdentityToken()`) correctly no-ops per round 6's
        // enabled-gate. Nothing then retried the warm once THIS config
        // fetch enables identity — the cache stayed cold until some LATER
        // reporter-open warm happened to fire, so every capture in between
        // (including a crash) shipped anonymous for the exact integration
        // this SDK recommends.
        //
        // Fix: detect a genuine DISABLED -> ENABLED transition right where
        // `_identityEnabledFlag` — the value every submit path actually
        // reads — is already being updated, so the two decisions cannot
        // drift. Reuses the EXISTING `TraceItX.shared.__warmIdentityToken()`
        // entry point rather than a second one; that function is already a
        // detached `Task`, off the calling path, so this adds no blocking
        // to config apply. Deliberately gated on the TRANSITION, not "a
        // fetch happened": every periodic refresh (~300s) that LEAVES
        // identity enabled must not re-invoke the customer's provider on
        // every cycle — `wasIdentityEnabled` is read fresh, immediately
        // before the flag write below, so a fetch that keeps identity
        // enabled (the ordinary case) sees `true -> true` and never
        // re-fires. No new ordering hazard: `__warmIdentityToken()` only
        // ever POPULATES the holder's cache — round 16 removed every code
        // path that discards/wipes captured evidence from a warm, so there
        // is nothing here for a freshly warmed identity to race ahead of.
        let wasIdentityEnabled = TraceItX.shared._identityEnabledFlag.get()
        let nowIdentityEnabled = isIdentityEnabled(latest)
        TraceItX.shared._identityEnabledFlag.set(nowIdentityEnabled) { [startEpochAtCreation] in
            TraceItX.shared.currentStartEpoch == startEpochAtCreation
        }
        if !wasIdentityEnabled && nowIdentityEnabled {
            TraceItX.shared.__warmIdentityToken()
        }
    }

    /// Freeze before mounting reporter UI. Finalization runs asynchronously.
    public func freezeForReporter() {
        guard !isTornDown, TraceItX.shared.currentStartEpoch == startEpochAtCreation else { return }
        video.freeze()
    }

    internal func completeVideoForSubmit() async -> NativeVideoClaim? {
        guard !isTornDown, TraceItX.shared.currentStartEpoch == startEpochAtCreation else { return nil }
        let claim = await video.finishClaim()
        return NativeVideoClaim(artifact: claim.artifact, omissionReason: claim.omissionReason, validate: { [weak self] in
            guard let self else { return false }
            return !self.isTornDown && TraceItX.shared.currentStartEpoch == self.startEpochAtCreation && claim.isValid
        })
    }

    /// Called only after reporter dismissal, for both submit and cancel.
    public func cancelForReporter() {
        guard !isTornDown, TraceItX.shared.currentStartEpoch == startEpochAtCreation else { return }
        video.reporterDidClose()
    }

    internal func __lifecycleStateForTesting() -> ReplayState { video.state }
}
#endif
