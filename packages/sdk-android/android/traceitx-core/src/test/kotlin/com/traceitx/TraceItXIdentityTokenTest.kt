// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Native identity Task 8 (Kotlin twin of iOS Task 4,
// `IdentityTokenHolderTests.testKillClearsTheIdentityToken` /
// `.testStartClearsTheIdentityToken`) — proves `TraceItX.start()` and
// `TraceItX.kill()` actually clear `TraceItX._identityHolder`, not merely
// that `IdentityTokenHolder.set(null)` works in isolation (that's already
// covered exhaustively by `IdentityTokenHolderTest`). The hazard this guards
// against is cross-tenant: `start(projectA)` -> host signs a user in via
// `setIdentityToken` -> `start(projectB)` must not leave project A's user's
// bearer credential installed and presentable to project B — the identical
// class of bug `_startEpoch` exists to prevent, applied to a server-verified
// credential instead of a self-declared `setUser` label.
package com.traceitx

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.config.CaptureConfig
import com.traceitx.config.IdentityConfigWire
import com.traceitx.config.ReplayConfig
import com.traceitx.config.TraceItXConfig
import com.traceitx.identity.IdentityTokenSource
import com.traceitx.shared.SharedData
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class TraceItXIdentityTokenTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun validConfig(): TraceItXConfig = TraceItXConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        // Mirrors TraceItXTest.validConfig()'s rationale: keep the detached
        // heavy-init coroutine's other side effects (log tee install) out of
        // this suite entirely.
        capture = CaptureConfig(logs = false),
    )

    /** Build an unsigned-but-well-formed JWT. The holder never verifies, so a
     *  fake signature is the honest fixture here — mirrors
     *  `IdentityTokenHolderTest`'s own `jwt()` helper. */
    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    @Before
    fun setUp() {
        SharedData.init(context)
    }

    @After
    fun tearDown() {
        TraceItX.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
    }

    @Test
    fun `kill clears the identity token`() {
        val now = System.currentTimeMillis()
        TraceItX.start(context, validConfig())
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

        TraceItX.kill()

        val got = runBlocking { TraceItX._identityHolder.get(now) }
        assertNull("a killed SDK must present nothing", got)
    }

    /**
     * Independent review, round 10, P1 — proves the WIRING, not just
     * `IdentityTokenHolder.cancelOutstandingWork()` in isolation
     * (`IdentityTokenHolderTest` already covers the holder's own join/cancel
     * mechanics exhaustively). `setIdentityToken(Provider)` kicks off an
     * install-time warm on `sdkScope` that reaches the holder's own
     * `scope.async` for the actual provider call; before this round, that
     * inner call was an unstructured `GlobalScope.async` `kill()` could never
     * reach at all — a never-resolving provider left running past `kill()`
     * indefinitely, pinning a `Dispatchers.IO` thread with no way to stop it
     * short of process death. Mutation-verified: removing the
     * `_identityHolder.cancelOutstandingWork()` call from `kill()` makes the
     * `cancelled.await` below time out instead of completing.
     */
    @Test
    fun `kill cancels an outstanding provider call`() {
        val entered = CountDownLatch(1)
        val cancelled = CountDownLatch(1)

        TraceItX.start(context, validConfig())
        TraceItX.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = true),
        )
        TraceItX.setIdentityToken(
            IdentityTokenSource.Provider {
                entered.countDown()
                try {
                    delay(10_000) // never arrives on its own
                    jwt(sub = "grace", expMs = System.currentTimeMillis() + 300_000)
                } catch (e: CancellationException) {
                    cancelled.countDown()
                    throw e
                }
            },
        )

        // setIdentityToken's own install-time warm (__warmIdentityToken)
        // kicks the provider call off on sdkScope.
        assertTrue(
            "fixture sanity: the install-time warm must have entered the provider",
            entered.await(5, TimeUnit.SECONDS),
        )

        TraceItX.kill()

        assertTrue(
            "kill() must reach and cancel the outstanding provider call through to the holder's own scope, not merely abandon it",
            cancelled.await(3, TimeUnit.SECONDS),
        )
    }

    /**
     * The sibling of the `kill()` case above, and the more dangerous one:
     * `start()` installs a NEW `_config` (the SDK key / destination project)
     * without clearing a previously-installed identity source, so
     * `start(projectA) -> setIdentityToken(alice) -> start(projectB)` would
     * let project B's reports present project A's user's verified
     * credential — a falsely-verified identity in a DIFFERENT customer's
     * project, worse than the analogous `_user` leak `start()` already
     * closes, because a server actually trusts this one's signature.
     */
    @Test
    fun `start clears the identity token`() {
        val now = System.currentTimeMillis()
        TraceItX.start(context, validConfig())
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

        // Reconfigure onto a DIFFERENT project — no setIdentityToken call in
        // the new session anywhere.
        TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_other0987654321"))

        val got = runBlocking { TraceItX._identityHolder.get(now) }
        assertNull(
            "a freshly-started session must never carry over a previous project's identity token",
            got,
        )
    }

    /**
     * Independent review, Serious 1 — `__resolveIdentityToken`'s epoch
     * pre-check alone is a TOCTOU window: it is `suspend`, and its own
     * suspension point (`IdentityTokenHolder.get`'s provider re-ask) gives a
     * `start(projectB)` + `setIdentityToken(B)` landing DURING resolution —
     * after the pre-check already passed — a chance to land. This drives
     * that race for real: alice's subject is captured under project A, then
     * a provider swap forces the NEXT resolution to suspend on a real
     * (gated) provider call; while that call is in flight, on ANOTHER
     * thread, project B starts and installs its own token for the SAME
     * subject; releasing the gate lets alice's original call resolve. The
     * header must be withheld regardless. Mutation-verified: removing the
     * post-resolution re-check (`return if (capturedEpoch ==
     * currentStartEpoch()) resolved else null` -> `return resolved`) makes
     * this fail — confirmed empirically, not just argued.
     *
     * Why this genuinely isolates the NEW re-check rather than just
     * re-proving `IdentityTokenHolder`'s pre-existing generation guard: the
     * `setIdentityToken(Provider {...})` swap above ALSO fires this
     * branch's own install-time warm (`__warmIdentityToken`, fix round 2),
     * an INDEPENDENT coroutine that reaches the gated provider on its own
     * schedule. That warm is commonly the one that trips `entered` here —
     * plausible given raw-`Thread` startup latency versus a same-process
     * coroutine dispatch — which leaves `resolveThread`'s OWN
     * `holder.get()` call to take its snapshot LATER, by which point
     * project B's switch (self-caching, synchronous) has already landed:
     * `get()` then answers via its ordinary FAST PATH with B's token as its
     * own valid current state — no stale in-flight provider call, no
     * generation conflict for THIS call to catch. Only the epoch re-check
     * catches that case, which is exactly what the empirical mutation
     * result confirms.
     */
    @Test
    fun `resolveIdentityToken withholds the header when another project starts during resolution`() {
        val now = System.currentTimeMillis()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)

        TraceItX.start(context, validConfig())
        TraceItX.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = true),
        )
        // Alice's token, cached synchronously — this is what gets CAPTURED.
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        val captured = TraceItX.captureUserSnapshot()
        assertEquals("fixture sanity: the subject must be captured", "alice", captured.identitySubject)

        // Swap to a PROVIDER that blocks — swapping sources always clears
        // the cache (IdentityTokenHolder.set), so the NEXT holder.get()
        // (triggered by resolveIdentityHeader below) must re-ask, giving us
        // a real, controllable suspension to race against.
        TraceItX.setIdentityToken(
            IdentityTokenSource.Provider {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
                jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            },
        )

        val resultRef = AtomicReference<TraceItX.IdentityResolution?>(null)
        val resolveThread = Thread {
            resultRef.set(
                runBlocking { TraceItX.__resolveIdentityToken(captured.identitySubject, captured.startEpoch) },
            )
        }
        resolveThread.start()

        assertTrue(
            "fixture sanity: the provider must actually have been entered (resolution in flight)",
            entered.await(5, TimeUnit.SECONDS),
        )

        // THE RACE: while resolution is suspended awaiting alice's provider,
        // another project starts and installs its own token for the SAME
        // subject on a DIFFERENT thread.
        TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_projectB098765432"))
        TraceItX.setIdentityToken(
            IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)),
        )

        release.countDown()
        resolveThread.join(5_000)

        assertNull(
            "a project switch racing with resolution must withhold the header, even though the subject matches",
            resultRef.get()?.token,
        )
        // Independent review, P1 — the SAME result must also say the
        // captured epoch is no longer current, so a caller persisting an
        // OutboxEntry knows to null out identitySubject too, not just the
        // token.
        assertEquals(
            "the epoch decision must be reported so callers can gate the PERSISTED subject the same way",
            false,
            resultRef.get()?.epochStillCurrent,
        )
    }

    /**
     * Independent review, round 15, Serious — `__resolveIdentityToken`
     * snapshotted `identity.enabled`, waited up to
     * `IDENTITY_PROVIDER_TIMEOUT_MS` for the provider, then re-checked ONLY
     * the session epoch. A periodic config refresh can disable identity
     * during that wait WITHOUT bumping the epoch (only `start()`/`kill()`
     * do that), so the resolved token still attached. `ReportSubmitter
     * .drainOutbox`'s own drain paths already re-read enablement after the
     * identical await (round 11, P1(c)) — this closes the gap the LIVE
     * reporter/companion path had that the drain never did.
     *
     * Same race-construction technique as the sibling test above (a
     * blocking provider + a second thread racing a config change in while
     * resolution is suspended) — but the race here is a LIVE CONFIG CHANGE
     * with NO project switch at all, not a `start(projectB)`. Distinguishes
     * the two: [IdentityResolution.epochStillCurrent] must stay TRUE (the
     * captured snapshot itself is still trustworthy — same project, same
     * session, nothing about WHICH identity this belongs to changed), while
     * [IdentityResolution.token] must still come back null (the TOKEN
     * decision is what a live enablement flip must gate, deliberately kept
     * separate from epoch — see `__resolveIdentityToken`'s own doc comment).
     */
    @Test
    fun `resolveIdentityToken withholds the header when identity is disabled during resolution`() {
        val now = System.currentTimeMillis()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)

        TraceItX.start(context, validConfig())
        TraceItX.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = true),
        )
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        val captured = TraceItX.captureUserSnapshot()
        assertEquals("fixture sanity: the subject must be captured", "alice", captured.identitySubject)

        // Swap to a PROVIDER that blocks — same technique as the race
        // above: swapping sources clears the cache, so the next
        // holder.get() (triggered by resolveIdentityHeader below) must
        // re-ask, giving a real, controllable suspension to race against.
        TraceItX.setIdentityToken(
            IdentityTokenSource.Provider {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
                jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            },
        )

        val resultRef = AtomicReference<TraceItX.IdentityResolution?>(null)
        val resolveThread = Thread {
            resultRef.set(
                runBlocking { TraceItX.__resolveIdentityToken(captured.identitySubject, captured.startEpoch) },
            )
        }
        resolveThread.start()

        assertTrue(
            "fixture sanity: the provider must actually have been entered (resolution in flight)",
            entered.await(5, TimeUnit.SECONDS),
        )

        // THE RACE: while resolution is suspended awaiting the provider, a
        // REMOTE config refresh flips identity.enabled OFF — no
        // start()/kill() anywhere in this test, so the epoch never moves.
        TraceItX.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = false),
        )

        release.countDown()
        resolveThread.join(5_000)

        assertNull(
            "identity being disabled DURING resolution must withhold the header, even though the epoch never changed",
            resultRef.get()?.token,
        )
        assertEquals(
            "epochStillCurrent must remain true here — unlike the project-switch race above, a live " +
                "enablement flip with no project switch at all does not make the captured snapshot itself " +
                "untrustworthy, only today's token decision",
            true,
            resultRef.get()?.epochStillCurrent,
        )
    }
}
