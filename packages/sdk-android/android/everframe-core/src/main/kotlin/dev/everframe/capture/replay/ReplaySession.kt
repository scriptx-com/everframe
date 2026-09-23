// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.replay

import android.app.Activity
import android.content.Context
import dev.everframe.BuildConfig
import dev.everframe.Everframe
import kotlinx.serialization.json.*
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.ResourceRingBuffer
import dev.everframe.capture.ResourceSampler
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.sharedResourceBuffer
import dev.everframe.capture.sharedNetworkBodyBuffer
import dev.everframe.capture.video.*
import dev.everframe.config.*
import dev.everframe.vitals.toVitalsServerConfig
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import okhttp3.OkHttpClient

/** One originating session. Config/identity/ancillary consumers remain independent of optional video. */
class ReplaySession(
    baseUrl: String = IngestEndpoint.url,
    apiKey: String,
    private val locallyDisabled: Boolean = false,
    private val activitySupplier: () -> Activity? = { Everframe.__activitySupplier?.invoke() },
    installIdProvider: () -> String? = { null },
    private val provider: ReplayConfigProvider = ReplayConfigProvider.make(baseUrl = baseUrl, apiKey = apiKey,
        fetcher = defaultFetcher, installIdProvider = installIdProvider),
    private val context: Context? = null,
    private val originatingStartEpoch: Int = Everframe.currentStartEpochVolatile(),
    private val captureConsent: Boolean = Everframe.captureGate,
) {
    @Volatile private var configBox = ReplayConfig.OFF
    internal val currentConfig get() = configBox
    private val refreshMutex = Mutex()
    private val epoch = AtomicInteger()
    private val isTornDown = AtomicBoolean()
    // Leaf generation lock. Buffer guards acquire it; teardown never holds it across buffer calls.
    private val sessionLock = ReentrantLock()
    private var initialRefreshJob: Job? = null
    private var refreshLoopJob: Job? = null
    private val sessionId = UUID.randomUUID().toString()
    private val samplingDraw = Math.random()
    private var generation = 0L
    private var authorized = false
    private var settings: NativeVideoSettings? = null
    /** Latest completed video publication, independent of ancillary last-good config and privacy revocation. */
    private data class VideoPolicy(val settings: NativeVideoSettings?, val durationSec: Int)
    private var videoPolicy: VideoPolicy? = null
    private var recordingOwner = newOwner()
    private var recorder: NativeVideoRecorder? = null
    private var previousVideoDiagnostics: JsonObject? = null
    /** Internal construction boundary for controlled encoder comparisons and deterministic native tests. */
    internal var recorderFactory: (Context, VideoOwner, () -> Activity?) -> NativeVideoRecorder = NativeVideoRecorder::create
    internal var videoStartupAdmission: VideoStartupAdmission? = null
    private var startupPending: Any? = null
    private var activeOwner: VideoOwner? = null
    private var privacyEpoch = VideoPrivacyRevocation.current
    private var privacySubscription: AutoCloseable? = null
    private var foreground = true
    private var state = NativeVideoRecorder.State.DISABLED

    /**
     * Report Resource Window (spec 2026-09-05) — CPU/memory sampler feeding
     * [sharedResourceBuffer]. Owned for the session's whole lifetime; nothing
     * is allocated until [ResourceSampler.start] runs. Armed and disarmed on
     * every [refreshConfigNow] from the server's LIVE `resources.enabled`, so
     * flipping the flag needs no SDK restart. `windowProvider` reads the
     * ring's own `windowSec` back rather than the raw config, keeping
     * [refreshConfigNow] the single writer of that property. Mirrors iOS's
     * `ReplaySession.resourceSampler`.
     */
    private val resourceSampler = ResourceSampler(windowProvider = { sharedResourceBuffer.windowSec })
    internal val __resourceSamplerIsRunningForTesting get() = resourceSampler.isRunning

    private fun newOwner() = VideoOwner(sessionId, UUID.randomUUID().toString())
    private fun currentGenerationValid(capturedEpoch: Int) = sessionLock.withLock {
        !isTornDown.get() && epoch.get() == capturedEpoch && Everframe.currentStartEpochVolatile() == originatingStartEpoch
    }
    internal val isTornDownForTesting get() = isTornDown.get()
    internal fun __lifecycleStateForTesting() = state

    /** Caller holds the existing report authorization lock; no new lock order. */
    internal fun nativeVideoDiagnostics(): JsonObject? {
        if (!BuildConfig.DEBUG) return null
        return buildJsonObject {
            put("sessionState", state.ordinal)
            put("configuredFps", settings?.framesPerSecond ?: 0)
            put("authorized", if (authorized) 1 else 0)
            put("foreground", if (foreground) 1 else 0)
            put("privacyBlocked", if (VideoPrivacyRevocation.blocked) 1 else 0)
            put("hasRecorder", if (recorder != null) 1 else 0)
            recorder?.let { put("current", it.diagnosticSnapshot()) }
            previousVideoDiagnostics?.let { put("previous", it) }
        }
    }

    fun enableIfConfigured() = Everframe.withReportAuthorizationLock {
        if (!currentGenerationValid(epoch.get())) return@withReportAuthorizationLock
        if (initialRefreshJob != null || refreshLoopJob != null) return@withReportAuthorizationLock
        // Subscription, snapshot recheck, and job publication serialize with teardown.
        // Out-of-order callbacks cannot lower the fence or replace a newer session's observer.
        val subscriptionEpoch = epoch.get()
        privacySubscription = VideoPrivacyRevocation.subscribe(callback = {
            Everframe.withReportAuthorizationLock {
                if (currentGenerationValid(subscriptionEpoch)) observePrivacyLocked()
            }
        }, onSettled = {
            Everframe.withReportAuthorizationLock {
                if (currentGenerationValid(subscriptionEpoch)) reconcileVideoLocked()
            }
        })
        observePrivacyLocked()
        initialRefreshJob = Everframe.sdkScope.launch { refreshConfigNow() }
        refreshLoopJob = Everframe.sdkScope.launch {
            while (isActive) { delay(300_000L); if (isActive) refreshConfigNow() }
        }
    }

    fun teardown() {
        val first = sessionLock.withLock {
            if (!isTornDown.compareAndSet(false, true)) false else { epoch.incrementAndGet(); true }
        }
        if (!first) return
        // Session-owned: once Everframe._replaySession is nulled nothing can
        // stop an orphaned sampler again. Taken before the authorization
        // lock — stop() is idempotent and needs no lock nesting.
        resourceSampler.stop()
        Everframe.withReportAuthorizationLock {
            initialRefreshJob?.cancel(); refreshLoopJob?.cancel()
            initialRefreshJob = null; refreshLoopJob = null
            privacySubscription?.close(); privacySubscription = null
            revokeReplayLocked(); state = NativeVideoRecorder.State.CLOSED
        }
    }

    internal suspend fun refreshConfigNow(): Unit = refreshMutex.withLock {
        val capturedEpoch = epoch.get()
        val succeeded = provider.refresh(force = true)
        val latest = provider.current
        if (!currentGenerationValid(capturedEpoch)) return
        val wasIdentityEnabled = isIdentityEnabled(configBox)
        configBox = latest
        // Signals retain their existing independent effects; never publish from a superseded generation.
        dev.everframe.companion.CompanionBadgeServerConfigSignal.publish(latest.companionBadge) { currentGenerationValid(capturedEpoch) }
        BrandingServerConfigSignal.publish(latest.branding) { currentGenerationValid(capturedEpoch) }
        dev.everframe.vitals.VitalsServerConfigSignal.publish(latest.toVitalsServerConfig()) { currentGenerationValid(capturedEpoch) }
        dev.everframe.trigger.ShakeToReportTrigger.publishRemote(latest.shakeToReport?.enabled) {
            currentGenerationValid(capturedEpoch)
        }
        if (!wasIdentityEnabled && isIdentityEnabled(latest) && currentGenerationValid(capturedEpoch)) Everframe.__warmIdentityToken()
        sharedBreadcrumbBuffer.applyConfig(latest.breadcrumbs) { currentGenerationValid(capturedEpoch) }
        // Report Resource Window (spec 2026-09-05). `windowSec` is read LIVE
        // on every resolved config; the ring's property is mutable precisely
        // so the change applies to every subsequent push/snapshot. A failed
        // fetch keeps whatever `latest` already holds (the provider's own
        // fail-closed cache), never an explicit reset.
        //
        // Re-validate first: `applyConfig` above can block on an externally
        // held lock, so a teardown can land and complete before this line
        // runs. That is only a pre-filter — the generation is re-checked
        // INSIDE the sampler's own lock via `guard`, the same shape
        // `NetworkBodyCaptureState.applyConfig` uses below, so an arm can
        // never survive a teardown that races it.
        if (!currentGenerationValid(capturedEpoch)) return
        sharedResourceBuffer.windowSec = latest.resources?.windowSec ?: ResourceRingBuffer.defaultWindowSec
        if (latest.resources?.enabled == true) {
            resourceSampler.start(guard = { currentGenerationValid(capturedEpoch) })
        } else {
            resourceSampler.stop()
        }
        NetworkBodyCaptureState.applyConfig(if (succeeded) latest.networkBodies else null,
            samplingRate = latest.samplingRate,
            locallyDisabled = NetworkBodyCaptureState.locallyDisabled(Everframe.currentConfig) ||
                NetworkBodyCaptureState.breadcrumbsExcludeNetwork(latest.breadcrumbs),
            guard = { currentGenerationValid(capturedEpoch) })
        sharedNetworkBodyBuffer.setTotalBudget(latest.networkBodies?.bodyTotalBudget ?: 262144) { currentGenerationValid(capturedEpoch) }
        Everframe.withReportAuthorizationLock {
            if (!currentGenerationValid(capturedEpoch)) return@withReportAuthorizationLock
            val effective = effectiveNativeVideo(latest, succeeded, locallyDisabled)
                ?.takeIf { samplingDraw < latest.samplingRate }
            val decision = VideoPolicy(effective, latest.replayDurationSec)
            if (authorized && videoPolicy != decision) revokeReplayLocked()
            videoPolicy = decision
            reconcileVideoLocked()
        }
    }

    private fun observePrivacyLocked() {
        val current = VideoPrivacyRevocation.current
        if (current > privacyEpoch) { privacyEpoch = current; revokeReplayLocked() }
    }

    /** Both publication and settlement reconcile current state, never the event's historical epoch. */
    private fun reconcileVideoLocked() {
        observePrivacyLocked()
        val decision = videoPolicy
        if (decision?.settings == null || !captureConsent || !Everframe.captureGate ||
            !VideoPrivacyRevocation.permits(privacyEpoch)) {
            revokeReplayLocked()
            return
        }
        authorized = true
        settings = decision.settings
        if (activeOwner == null && recorder == null) startRecordingLocked()
    }

    private fun revokeReplayLocked() {
        previousVideoDiagnostics = null
        generation++
        authorized = false
        startupPending = null
        recorder?.close(); recorder = null
        if (state != NativeVideoRecorder.State.CLOSED) state = NativeVideoRecorder.State.DISABLED
    }
    private fun startRecordingLocked() {
        if (!authorized || isTornDown.get() || activeOwner != null || startupPending != null) return
        val appContext = context ?: return
        val decision = videoPolicy ?: return
        val effective = decision.settings ?: return
        val pending = Any()
        startupPending = pending
        val capturedGeneration = generation
        val capturedEpoch = epoch.get()
        // The existing worker owns discovery and deletion; construction still has no file IO.
        (videoStartupAdmission ?: VideoStartupAdmission.process).request(appContext) { allowed ->
            Everframe.withReportAuthorizationLock {
                if (startupPending !== pending) return@withReportAuthorizationLock
                startupPending = null
                if (!currentGenerationValid(capturedEpoch) || generation != capturedGeneration ||
                    !authorized || activeOwner != null || recorder != null || !Everframe.captureGate ||
                    !VideoPrivacyRevocation.permits(privacyEpoch)) return@withReportAuthorizationLock
                if (!allowed) { revokeReplayLocked(); return@withReportAuthorizationLock }
                recordingOwner = newOwner()
                try {
                    recorder = recorderFactory(appContext, recordingOwner, activitySupplier)
                    recorder?.start(effective, decision.durationSec)
                    state = if (foreground) NativeVideoRecorder.State.BUFFERING else NativeVideoRecorder.State.SUSPENDED
                    if (!foreground) recorder?.pause()
                } catch (_: Throwable) { revokeReplayLocked() }
            }
        }
    }

    fun pause() = Everframe.withReportAuthorizationLock {
        foreground = false; recorder?.pause()
        if (state == NativeVideoRecorder.State.BUFFERING) state = NativeVideoRecorder.State.SUSPENDED
    }
    fun resume() = Everframe.withReportAuthorizationLock {
        foreground = true; recorder?.resume()
        if (state == NativeVideoRecorder.State.SUSPENDED) state = NativeVideoRecorder.State.BUFFERING
    }

    /** Called under Everframe's capture coordinator, which serializes snapshots with start/kill epoch changes. */
    internal fun freezeOwnedCapture(): FrozenReportCapture {
        val binding = Everframe.withReportAuthorizationLock {
            if (isTornDown.get() || activeOwner != null || Everframe.currentStartEpochVolatile() != originatingStartEpoch) return@withReportAuthorizationLock null
            val slot = ReportCaptureSlots.acquire() ?: return@withReportAuthorizationLock null
            val owner = recordingOwner
            activeOwner = owner
            val boundRecorder = recorder
            val export = boundRecorder?.freeze(owner)
            state = NativeVideoRecorder.State.FROZEN
            val capturedGeneration = generation
            val cancelled = AtomicBoolean()
            val released = AtomicBoolean()
            val origin = object : ReplayCaptureOrigin {
                override val sessionId = this@ReplaySession.sessionId
                override fun replayAllowed(owner: VideoOwner, generation: Long) = Everframe.withReportAuthorizationLock {
                    !cancelled.get() && authorized && !isTornDown.get() && generation == this@ReplaySession.generation &&
                        VideoPrivacyRevocation.permits(privacyEpoch)
                }
                override suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip? =
                    if (replayAllowed(owner, generation)) export?.invoke() else null
                override fun cancel(owner: VideoOwner) = Everframe.withReportAuthorizationLock {
                    cancelled.set(true); boundRecorder?.close(); Unit
                }
                override fun release(owner: VideoOwner) {
                    if (!released.compareAndSet(false, true)) return
                    Everframe.withReportAuthorizationLock {
                        if (BuildConfig.DEBUG && activeOwner == owner && recorder === boundRecorder &&
                            authorized && !isTornDown.get() && !cancelled.get() &&
                            capturedGeneration == generation && VideoPrivacyRevocation.permits(privacyEpoch)) {
                            previousVideoDiagnostics = boundRecorder?.diagnosticSnapshot()
                        }
                        boundRecorder?.close()
                        if (activeOwner == owner) {
                            activeOwner = null
                            if (recorder === boundRecorder) recorder = null
                            if (authorized && !isTornDown.get()) startRecordingLocked()
                        }
                    }
                    slot.close()
                }
            }
            Triple(owner, capturedGeneration, origin)
        } ?: return FrozenReportCapture.empty(originatingStartEpoch, sessionId)
        return try {
            val guard = { !isTornDown.get() && Everframe.currentStartEpochVolatile() == originatingStartEpoch }
            val snapshot = FrozenAncillarySnapshot(sharedBreadcrumbBuffer.snapshotForReport(guard), sharedNetworkBodyBuffer.snapshotForReport(guard))
            FrozenReportCapture(binding.first, originatingStartEpoch, binding.second, binding.third, snapshot)
        } catch (_: Throwable) {
            binding.third.cancel(binding.first); binding.third.release(binding.first)
            FrozenReportCapture.empty(originatingStartEpoch, sessionId)
        }
    }

    private companion object {
        val sharedClient = OkHttpClient()
        val defaultFetcher = ConfigFetcher { request -> sharedClient.newCall(request).execute() }
    }
}
