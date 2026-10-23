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
// the previous one, nor before the stored link has loaded.
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
// SECURITY: never log, print or toast a token or a nonce.

package dev.everframe.devicelink

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import dev.everframe.Everframe
import dev.everframe.config.DeviceLinkingConfigWire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    /** Tests only: runs between a config's unlinked status and the forget it causes. */
    @Volatile internal var __beforeConfigForgetForTesting: () -> Unit = {}

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

    /** The token the latest config request carried. SECURITY: never log. */
    @Volatile private var lastRequestedToken: String? = null

    @Volatile var isLoaded: Boolean = false
        private set

    @Volatile var current: StoredDeviceLink? = null
        private set

    @Volatile var linkingEnabled: Boolean = false
        private set

    /** True while a hello is out or an attempt is being checked. */
    @Volatile var attemptInFlight: Boolean = false
        private set

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
        val loaded = scope?.let { store.load(it) }
        val previous = synchronized(lock) {
            if (!isCurrent()) return
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
            lastRequestedToken = null
            linkingEnabled = false
            attemptInFlight = false
            current = loaded
            isLoaded = true
            old
        }
        previous?.cancel()
        context?.let { runCatching { LinkBanner.install(it) } }
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
            }
        }
        // Only the token this status describes: a takeover may have replaced it since the lock was released.
        forgetToken?.let { token ->
            __beforeConfigForgetForTesting()
            forget(onlyIfToken = token)
        }
    }

    /** Fire and forget. Sent only by an unlinked, loaded device with linking enabled; see the file header. */
    fun sendHello() {
        val nonce: String
        val api: DeviceLinkApi
        val describe: () -> HelloDevice?
        synchronized(lock) {
            if (!isLoaded || !linkingEnabled || current != null || scope == null || attemptInFlight) return
            val t = now()
            lastHelloAt?.let { if (t - it < helloDebounceMs) return }
            api = client ?: return
            lastHelloAt = t
            attemptInFlight = true
            nonce = LinkNonce.generate() // SECURITY: never log
            describe = device
        }
        launchOwned { owner ->
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

    /** A takeover: the ingest answer to this device's upload named a pending attempt. Dropped if one runs. */
    fun beginAttempt(attemptId: String, number: Int, nonce: String) {
        val api: DeviceLinkApi
        synchronized(lock) {
            if (!isLoaded || scope == null || attemptInFlight) return
            api = client ?: return
            attemptInFlight = true
        }
        launchOwned { owner -> runAttempt(owner, api, attemptId, number, nonce) }
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
            lastRequestedToken = null
            isLoaded = false
            current = null
            linkingEnabled = false
            attemptInFlight = false
            old
        }
        previous?.cancel()
        safely { hideBanner() }
    }

    /**
     * Refreshes the config of the session current now, as a child of [refreshes], so a teardown or the next
     * install cancels it before it can fetch. `refreshConfigNow` also checks its session's generation first.
     */
    private fun launchConfigRefresh() {
        val session = Everframe._replaySession ?: return
        synchronized(lock) {
            if (!isLoaded) return
            scopeProvider().launch(refreshes) { runCatching { session.refreshConfigNow() } }
        }
    }

    // ---- Attempt loop ----

    /** Launches [block] as the single owned job; [block] gets its own Job to compare against [job]. */
    private fun launchOwned(block: suspend (Job) -> Unit) {
        val started = scopeProvider().launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            val self = coroutineContext[Job]!!
            try {
                block(self)
            } finally {
                synchronized(lock) {
                    if (job === self) {
                        job = null
                        attemptInFlight = false
                    }
                }
            }
        }
        synchronized(lock) {
            if (!attemptInFlight) {
                // A teardown landed between the claim and here.
                started.cancel()
                return
            }
            job = started
        }
        started.start()
    }

    private suspend fun runAttempt(owner: Job, api: DeviceLinkApi, attemptId: String, number: Int, nonce: String) {
        safely { showBanner(number) }
        try {
            val startedAt = now()
            while (now() - startedAt < checkWindowMs) {
                delay(checkIntervalMs)
                val result = try {
                    api.check(attemptId, nonce)
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
            safely { hideBanner() }
        }
    }

    private fun onLinked(owner: Job, result: CheckResult.Linked) {
        val linked: StoredDeviceLink
        synchronized(lock) {
            if (job !== owner || !sessionIsCurrent()) return
            val s = scope ?: return
            val st = store ?: return
            linked = StoredDeviceLink(result.token, result.owner, s)
            // A failed save leaves the device unlinked, silently.
            if (!st.save(linked)) return
            current = linked
        }
        safely { hideBanner() }
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
        __beforeConfigForgetForTesting = {}
    }

    /** Tests only: a linked state without a store round trip. */
    internal fun __setCurrentForTesting(link: StoredDeviceLink?, enabled: Boolean = true) {
        synchronized(lock) {
            current = link
            linkingEnabled = enabled
            isLoaded = true
        }
    }
}
