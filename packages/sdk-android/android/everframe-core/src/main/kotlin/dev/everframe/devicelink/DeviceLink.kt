// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the device's link state.
//
// "PRESS IT NOW" LINKING. A teammate opens a link window on the dashboard.
// When the capture gesture fires on an unlinked device of an app with linking
// enabled, [sendHello] posts a hello. A `pending` answer shows the matching
// number in [LinkBanner] and checks the attempt every 3 s for at most 150 s.
// When the teammate picks the number, the next check returns the device token;
// it is stored ([DeviceLinkStore]) and the device shows `Linked to {name}`.
//
// TAKEOVER. A linked device sends no hello: its quick-capture upload carries a
// fresh link nonce, and an ingest answer naming a pending attempt calls
// [beginAttempt] with that nonce. Approval replaces the stored token.
//
// ONE ATTEMPT AT A TIME. A second gesture (or a double shake) while a hello or
// an attempt is in flight is dropped, and a hello is never sent within 5 s of
// the previous one, nor before the stored link has loaded. The slot is held by
// a claim tied to the installation (`start()`) and scope it was taken in, so
// an attempt begun before a restart can neither take over the next
// installation's slot nor store its token under the next project's scope.
//
// CONFIG. `GET /api/config` carries the stored token, and its `deviceLinking`
// block says whether linking is on and, for that token, whether it is still
// linked. A status is applied only when it describes the token the latest
// config request carried, so a response for a token that has since been
// replaced never unlinks the new one. A config request gets the token only
// when it is built for the scope (ingest origin and SDK key) the link was
// loaded for, while that link state is current, so a session left over from
// an earlier `start()` never sends the new project's token. The refresh a
// link change asks for dies with the link state ([teardown], [install]).
//
// RECORD ON DEVICE. A linked device's config may name a pending gesture
// recording; [applyConfig] hands it to [GestureRecording]. Bringing the app to
// the foreground refreshes config while linked (at most every 10 s), so a
// recording request reaches the device without a relaunch. Unlinked devices
// keep today's config traffic.
//
// SECURITY: never log, print or toast a token or a nonce.

package dev.everframe.devicelink

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.everframe.Everframe
import dev.everframe.config.DeviceLinkingConfigWire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

internal object DeviceLink {
    // ---- Test seams ----

    @Volatile internal var toaster: (String) -> Unit = { text -> defaultToast(text) }
    @Volatile internal var refreshConfig: () -> Unit = { launchConfigRefresh() }
    @Volatile internal var showBanner: (Int) -> Unit = { LinkBanner.show(it) }
    @Volatile internal var hideBanner: () -> Unit = { LinkBanner.hide() }
    /** Called after the stored link changes (linked, replaced, forgotten), so gesture arming can follow. */
    @Volatile internal var onLinkChanged: () -> Unit = { publishGestureArmed() }
    @Volatile internal var scopeProvider: () -> CoroutineScope = { Everframe.sdkScope }
    @Volatile internal var checkIntervalMs: Long = 3_000L
    @Volatile internal var checkWindowMs: Long = 150_000L
    @Volatile internal var helloDebounceMs: Long = 5_000L
    @Volatile internal var now: () -> Long = { android.os.SystemClock.elapsedRealtime() }
    /**
     * The scope of the project `start()` has configured now (its ingest origin and SDK key), which can run ahead
     * of [install]: `start()` bumps its epoch before its detached install runs.
     */
    @Volatile internal var startingScope: () -> String? = { defaultStartingScope() }
    /** Tests only: runs between a config's unlinked status and the forget it causes. */
    @Volatile internal var __beforeConfigForgetForTesting: () -> Unit = {}
    @Volatile internal var lifecycleOwner: () -> LifecycleOwner = { ProcessLifecycleOwner.get() }

    /** Foreground config refreshes while linked are at least this far apart. */
    internal const val FOREGROUND_REFRESH_MS: Long = 10_000L

    // ---- State (written under [lock]) ----

    private val lock = Any()
    private var store: DeviceLinkStore? = null
    private var client: DeviceLinkApi? = null
    private var scope: String? = null
    private var device: () -> HelloDevice? = { null }
    private var sessionIsCurrent: () -> Boolean = { false }
    private var appContext: Context? = null
    private var job: Job? = null
    private var lastHelloAt: Long? = null
    /** Parent of the config refreshes a link change asks for; cancelled by [teardown] and [install]. */
    private var refreshes: Job = SupervisorJob()
    private var lastForegroundRefreshAt: Long? = null
    private var observing = false

    /** The token the latest config request carried. SECURITY: never log. */
    @Volatile private var lastRequestedToken: String? = null

    @Volatile var isLoaded: Boolean = false
        private set

    @Volatile var current: StoredDeviceLink? = null
        private set

    @Volatile var linkingEnabled: Boolean = false
        private set

    /** One hello-or-attempt's hold on the single attempt slot, for the installation and scope it began in. */
    private class AttemptClaim(val installation: Long, val scope: String)

    /** Bumped by every [install] and [teardown]; a claim from an earlier installation is stale. */
    private var installation = 0L

    /** The claim holding the attempt slot, or null. Written under [lock]. */
    @Volatile private var claim: AttemptClaim? = null

    /** The attempt whose number the banner shows; only it may hide the banner. Written under [lock]. */
    private var bannerOwner: AttemptClaim? = null

    /** True while a hello is out or an attempt is being checked. */
    val attemptInFlight: Boolean get() = claim != null

    /**
     * Called from `start()`. Loads the link stored for [scope] synchronously; a null scope (unparseable
     * endpoint) means this session can neither use nor create a link.
     */
    fun install(
        store: DeviceLinkStore,
        client: DeviceLinkApi,
        scope: String?,
        device: () -> HelloDevice,
        isCurrent: () -> Boolean,
        context: Context? = null,
    ) {
        val previous = synchronized(lock) {
            if (!isCurrent()) return
            // Loaded under the lock, so a link an attempt saves mid-handoff (see [onLinked]) is either loaded here
            // or saved into this installation.
            val loaded = scope?.let { store.load(it) }
            val old = job
            job = null
            refreshes.cancel()
            refreshes = SupervisorJob()
            this.store = store
            this.client = client
            this.scope = scope
            this.device = device
            sessionIsCurrent = isCurrent
            appContext = context?.applicationContext ?: context
            lastHelloAt = null
            // start() fetches config itself; the foreground observer's first ON_START is that same launch.
            lastForegroundRefreshAt = now()
            lastRequestedToken = null
            linkingEnabled = false
            installation++
            claim = null
            current = loaded
            isLoaded = true
            old
        }
        previous?.cancel()
        context?.let {
            runCatching { LinkBanner.install(it) }
            observeForeground()
        }
    }

    /**
     * The stored link's token and the installed client's recording endpoint, read together from one installation,
     * so a recording's upload never pairs one installation's token with another's client (SDK key and endpoint).
     * Null while unloaded or unlinked. SECURITY: never log.
     */
    fun recordingSnapshot(): RecordingSnapshot? = synchronized(lock) {
        if (!isLoaded) return null
        val token = current?.token ?: return null
        RecordingSnapshot(token, client as? GestureRecordingApi)
    }

    /** Linked devices refresh config when the app comes to the foreground; see the file header. */
    internal val foregroundObserver: DefaultLifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            safely { onForeground() }
        }
    }

    private fun onForeground() {
        synchronized(lock) {
            if (!isLoaded || current == null) return
            val t = now()
            lastForegroundRefreshAt?.let { if (t - it < FOREGROUND_REFRESH_MS) return }
            lastForegroundRefreshAt = t
        }
        refreshConfig()
    }

    private fun observeForeground() {
        Handler(Looper.getMainLooper()).post {
            safely {
                synchronized(lock) {
                    if (observing || !isLoaded) return@post
                    observing = true
                }
                lifecycleOwner().lifecycle.addObserver(foregroundObserver)
            }
        }
    }

    private fun stopObservingForeground() {
        Handler(Looper.getMainLooper()).post {
            safely {
                synchronized(lock) {
                    if (!observing || isLoaded) return@post
                    observing = false
                }
                lifecycleOwner().lifecycle.removeObserver(foregroundObserver)
            }
        }
    }

    /**
     * The token for a `GET /api/config` built for [scope] (that request's ingest origin and SDK key). Null
     * unless the loaded link belongs to [scope] and this link state is still current. SECURITY: never log.
     */
    fun tokenForRequest(scope: String?): String? = synchronized(lock) {
        if (!isLoaded || scope == null || scope != this.scope || !sessionIsCurrent()) return null
        val token = current?.takeIf { it.scope == scope }?.token
        lastRequestedToken = token
        token
    }

    /**
     * The token for a capture queued under [scope], for the outbox drain: the loaded link when [scope] is the
     * active one, else the link stored for [scope] (the store keeps one link, for the scope that saved it
     * last). Null when no token is stored for [scope] or the link state has not loaded. SECURITY: never log.
     */
    fun tokenForQueuedCapture(scope: String?): String? {
        if (scope == null) return null
        val other = synchronized(lock) {
            if (!isLoaded) return null
            if (scope == this.scope) return current?.takeIf { it.scope == scope }?.token
            store
        } ?: return null
        return runCatching { other.load(scope)?.token }.getOrNull()
    }

    /** The `deviceLinking` block of each config apply. */
    fun applyConfig(wire: DeviceLinkingConfigWire?, isCurrent: () -> Boolean) {
        var forgetToken: String? = null // SECURITY: never log
        var recording: dev.everframe.config.RecordingRequestWire? = null
        synchronized(lock) {
            if (!isCurrent() || !isLoaded) return
            linkingEnabled = wire?.enabled == true
            val link = wire?.link ?: return
            val cur = current ?: return
            // A status describes the token its request carried; anything else is about a replaced token.
            if (lastRequestedToken != cur.token) return
            if (!link.linked) {
                forgetToken = cur.token
            } else {
                val owner = link.owner
                if (owner != null && owner != cur.owner) {
                    val renamed = StoredDeviceLink(cur.token, owner, cur.scope)
                    if (store?.save(renamed) == true) current = renamed
                }
                recording = link.recording
            }
        }
        // Only the token this status describes: a takeover may have replaced it since the lock was released.
        forgetToken?.let { token ->
            __beforeConfigForgetForTesting()
            forget(onlyIfToken = token)
        }
        recording?.let { request -> safely { GestureRecording.onRequest(request, isCurrent) } }
    }

    /** Fire and forget. Sent only by an unlinked, loaded device with linking enabled; see the file header. */
    fun sendHello() {
        val nonce: String
        val api: DeviceLinkApi
        val describe: () -> HelloDevice?
        val claimed: AttemptClaim
        synchronized(lock) {
            val s = scope
            if (!isLoaded || !linkingEnabled || current != null || s == null || claim != null) return
            val t = now()
            lastHelloAt?.let { if (t - it < helloDebounceMs) return }
            api = client ?: return
            lastHelloAt = t
            claimed = AttemptClaim(installation, s)
            claim = claimed
            nonce = LinkNonce.generate() // SECURITY: never log
            describe = device
        }
        launchOwned(claimed) { owner ->
            val result = try {
                val d = runCatching { describe() }.getOrNull()
                if (d == null) HelloResult.Stop else api.hello(nonce, d)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                HelloResult.Stop
            }
            if (result is HelloResult.Pending) runAttempt(owner, api, result.attemptId, result.number, nonce)
        }
    }

    /** The scope the loaded link state belongs to, or null before it loads. */
    val activeScope: String? get() = synchronized(lock) { scope.takeIf { isLoaded } }

    /**
     * A takeover: the ingest answer to this device's upload named a pending attempt. Dropped if one runs, and
     * when [forScope] (the scope of the link that upload carried) is not the active scope.
     */
    fun beginAttempt(attemptId: String, number: Int, nonce: String, forScope: String? = null) {
        val api: DeviceLinkApi
        val claimed: AttemptClaim
        synchronized(lock) {
            val s = scope
            if (!isLoaded || s == null || claim != null) return
            if (forScope != null && forScope != s) return
            api = client ?: return
            claimed = AttemptClaim(installation, s)
            claim = claimed
        }
        launchOwned(claimed) { owner -> runAttempt(owner, api, attemptId, number, nonce) }
    }

    /**
     * Forgets the stored link and shows `This device was unlinked`. With [onlyIfToken], does nothing (and
     * returns false) when a different token is stored, so a refusal for a replaced token keeps the new one.
     */
    fun forget(onlyIfToken: String? = null): Boolean {
        synchronized(lock) {
            val cur = current
            if (onlyIfToken != null && cur?.token != onlyIfToken) return false
            current = null
            store?.clear()
        }
        safely { toaster(DeviceLinkCopy.UNLINKED) }
        safely { onLinkChanged() }
        safely { refreshConfig() }
        return true
    }

    /** Called from `kill()`: cancels the loop, hides the banner and unloads the link. */
    fun teardown(isCurrent: () -> Boolean = { true }) {
        val previous = synchronized(lock) {
            if (!isCurrent()) return
            val old = job
            job = null
            refreshes.cancel()
            refreshes = SupervisorJob()
            store = null
            client = null
            scope = null
            device = { null }
            sessionIsCurrent = { false }
            lastHelloAt = null
            lastForegroundRefreshAt = null
            lastRequestedToken = null
            isLoaded = false
            current = null
            linkingEnabled = false
            installation++
            claim = null
            bannerOwner = null
            old
        }
        previous?.cancel()
        safely { GestureRecording.teardown() }
        safely { stopObservingForeground() }
        safely { hideBanner() }
    }

    /**
     * Refreshes the config of the session current now, as a child of [refreshes], so a teardown or the next
     * install cancels it before it can fetch. `refreshConfigNow` also checks its session's generation first.
     */
    private fun defaultStartingScope(): String? {
        val sdkKey = Everframe.currentConfig?.sdkKey ?: return null
        return DeviceLinkScope.of(dev.everframe.config.IngestEndpoint.url, sdkKey)
    }

    private fun launchConfigRefresh() {
        val session = Everframe._replaySession ?: return
        synchronized(lock) {
            if (!isLoaded) return
            scopeProvider().launch(refreshes) { runCatching { session.refreshConfigNow() } }
        }
    }

    // ---- Attempt loop ----

    /**
     * Launches [block] as the job of [claimed]. Published only while [claimed] still holds the slot: an
     * install or teardown between the claim and here (and any claim taken after it) cancels this job unstarted.
     * Completion releases the slot only for its own claim.
     */
    private fun launchOwned(claimed: AttemptClaim, block: suspend (AttemptClaim) -> Unit) {
        val started = scopeProvider().launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            val self = coroutineContext[Job]!!
            try {
                block(claimed)
            } finally {
                synchronized(lock) {
                    if (claim === claimed) claim = null
                    if (job === self) job = null
                }
            }
        }
        synchronized(lock) {
            if (claim !== claimed) {
                started.cancel()
                return
            }
            job = started
        }
        started.start()
    }

    private suspend fun runAttempt(owner: AttemptClaim, api: DeviceLinkApi, attemptId: String, number: Int, nonce: String) {
        synchronized(lock) {
            if (claim !== owner) return
            bannerOwner = owner
            safely { showBanner(number) }
        }
        try {
            val startedAt = now()
            while (now() - startedAt < checkWindowMs) {
                delay(checkIntervalMs)
                // Each check gets only what is left of the attempt's window: a call still out at the deadline
                // is cancelled, so the banner and the in-flight claim clear on time.
                val remaining = checkWindowMs - (now() - startedAt)
                if (remaining <= 0) return
                val result = try {
                    withTimeoutOrNull(remaining) { api.check(attemptId, nonce) } ?: return
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    CheckResult.Retry
                }
                when (result) {
                    CheckResult.Pending, CheckResult.Retry -> continue
                    is CheckResult.Linked -> {
                        onLinked(owner, result)
                        return
                    }
                    CheckResult.Expired, CheckResult.Stop -> return
                }
            }
        } finally {
            hideBannerIfOwner(owner)
        }
    }

    /** Hides the banner only while [owner]'s number is the one shown: a stale attempt never hides a newer one. */
    private fun hideBannerIfOwner(owner: AttemptClaim) {
        synchronized(lock) {
            if (bannerOwner !== owner) return
            bannerOwner = null
            safely { hideBanner() }
        }
    }

    private fun onLinked(owner: AttemptClaim, result: CheckResult.Linked) {
        // Stored under the scope the attempt began in, never under whichever scope is live now.
        val linked = StoredDeviceLink(result.token, result.owner, owner.scope)
        // Read before the lock: it takes the SDK's state lock, which is never taken inside this one.
        val starting = runCatching { startingScope() }.getOrNull()
        synchronized(lock) {
            // A cancellation can race a check that already returned, so a claim from an earlier installation
            // can get here. Nothing is stored after a kill.
            if (!isLoaded) return
            // Mid-handoff: start() has bumped its epoch and its install has not run yet. The server revoked the
            // replaced token and returns this one once, so for the same project (the scope being started is
            // the attempt's) it is kept; the next install loads it (its load is under this lock).
            val sameProject = scope == owner.scope && (sessionIsCurrent() || starting == owner.scope)
            if (!sameProject) {
                // Another project is live: keep the token for its own scope only while the live installation
                // is unlinked (the store holds one link, and a live link must stand). The live gate is unchanged.
                if (current == null) runCatching { store?.save(linked) }
                return
            }
            // The attempt's own installation, or a restart of the same project: this is the live scope's link.
            if (claim !== owner && owner.installation == installation) return
            val st = store ?: return
            // A failed save leaves the device unlinked, silently.
            if (!st.save(linked)) return
            current = linked
        }
        hideBannerIfOwner(owner)
        safely { toaster(DeviceLinkCopy.linked(linked.owner)) }
        safely { onLinkChanged() }
        safely { refreshConfig() }
    }

    private fun publishGestureArmed() {
        val isCurrent = synchronized(lock) { sessionIsCurrent }
        dev.everframe.trigger.ShakeToReportTrigger.publishGestureArmed(
            dev.everframe.quickcapture.CaptureGesture.isArmed(dev.everframe.quickcapture.CaptureGesture.currentInput(isTv = false)),
            isCurrent,
        )
        // The TV remote gesture follows the link too (a linked TV swallows the binding's keys).
        if (isCurrent()) dev.everframe.quickcapture.QuickCapture.rearmTvGesture()
    }

    private inline fun safely(block: () -> Unit) {
        try {
            block()
        } catch (_: Throwable) {
        }
    }

    private fun defaultToast(text: String) {
        val context = synchronized(lock) { appContext } ?: return
        Handler(Looper.getMainLooper()).post {
            try {
                Toast.makeText(context, text, Toast.LENGTH_SHORT).show()
            } catch (_: Throwable) {
            }
        }
    }

    /** Tests only: restore the production seams and drop all state. */
    internal fun __resetForTesting() {
        teardown()
        toaster = { text -> defaultToast(text) }
        refreshConfig = { launchConfigRefresh() }
        showBanner = { LinkBanner.show(it) }
        hideBanner = { LinkBanner.hide() }
        onLinkChanged = { publishGestureArmed() }
        scopeProvider = { Everframe.sdkScope }
        checkIntervalMs = 3_000L
        checkWindowMs = 150_000L
        helloDebounceMs = 5_000L
        now = { android.os.SystemClock.elapsedRealtime() }
        startingScope = { defaultStartingScope() }
        __beforeConfigForgetForTesting = {}
        lifecycleOwner = { ProcessLifecycleOwner.get() }
    }

    /** Tests only: a linked state without a store round trip. */
    internal fun __setCurrentForTesting(link: StoredDeviceLink?, enabled: Boolean = true) {
        synchronized(lock) {
            current = link
            if (link != null) scope = link.scope
            linkingEnabled = enabled
            isLoaded = true
        }
    }
}
