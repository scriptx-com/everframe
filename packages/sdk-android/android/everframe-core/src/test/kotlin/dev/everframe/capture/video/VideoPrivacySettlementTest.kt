// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real installed subscription/config/session/recorder path; only network, worker and codec boundaries controlled. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VideoPrivacySettlementTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val sessions = mutableListOf<ReplaySession>()
    private val tokens = mutableListOf<AutoCloseable>()
    private val scheduler = Scheduler()
    private val created = mutableListOf<Pair<VideoOwner, NativeVideoRecorder>>()
    private val attempts = AtomicInteger()
    private val durations = mutableListOf<Long>()
    private var captureFactory: () -> PixelCopyVideoCapture? = { null }
    private var body = ON
    private var fetch: () -> Unit = {}

    @Before fun setup() { dev.everframe.shared.SharedData.init(context); Everframe.captureGate = true }
    @After fun cleanup() {
        sessions.forEach { it.teardown() }; tokens.forEach { it.close() }; scheduler.drain()
        Everframe.captureGate = false
    }
    private fun begin() = VideoPrivacyRevocation.begin().also { tokens.add(it) }
    private fun session(disabled: Boolean = false, consent: Boolean = true) = ReplaySession(
        apiKey = "key", context = context, locallyDisabled = disabled, captureConsent = consent,
        provider = ReplayConfigProvider.make("https://settlement.test", "key", ConfigFetcher { request ->
            attempts.incrementAndGet(); fetch()
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("test")
                .body(body.toResponseBody()).build()
        })
    ).also { session ->
        sessions.add(session)
        session.videoStartupAdmission = VideoStartupAdmission(scheduler, { 0L }) { _, _ -> true }
        session.recorderFactory = { _, owner, _ ->
            NativeVideoRecorder(owner, scheduler, { task -> scheduler.worker(task); true }, { VideoSize(4, 4) }, { captureFactory() },
                { _, _, duration -> durations.add(duration); object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame): Boolean { frame.close(); return true }
                    override fun finish(deadline: Long) = emptyList<VideoSegment>()
                    override val isTerminal = false
                    override fun close() = Unit
                } }, { _, _ -> null }).also { created.add(owner to it) }
        }
    }
    // Join only the one installed initial job, without an extra refresh or waiting for the five-minute loop.
    private fun awaitInitial(session: ReplaySession) = runBlocking {
        val field = ReplaySession::class.java.getDeclaredField("initialRefreshJob").apply { isAccessible = true }
        kotlinx.coroutines.withTimeout(3_000) { (field.get(session) as Job).join() }
    }
    private fun enabled(): ReplaySession = session().also { it.enableIfConfigured(); awaitInitial(it); scheduler.drain() }

    @Test fun finalNestedCloseStartsExactlyOneFreshOwnerWithoutFetchAndNeverRevivesFrozenClaim() {
        val session = enabled()
        val oldRecorder = created.single().second
        val old = session.freezeOwnedCapture()
        val authority = dev.everframe.transport.ReportAuthorizationFactory.forCapture(Everframe.captureSessionSnapshot(), old)
        val first = begin(); val nested = begin()
        assertEquals(NativeVideoRecorder.State.CLOSED, oldRecorder.state)
        assertFalse(old.replayAllowed())
        first.close(); scheduler.drain(); assertEquals(1, created.size)
        nested.close(); scheduler.drain()
        assertFalse(old.replayAllowed()); assertFalse(authority.evaluate().replayAllowed)
        assertTrue(authority.evaluate().reportAllowed); assertNotNull(old.takeBreadcrumbs())
        assertEquals("frozen owner still occupies its slot", 1, created.size)
        old.finishConsumption(); scheduler.drain()
        assertEquals("settlement must resume without another config fetch", 2, created.size)
        assertNotEquals(created[0].first, created[1].first)
        assertEquals(NativeVideoRecorder.State.BUFFERING, created[1].second.state)
        nested.close(); first.close(); scheduler.drain(); assertEquals(2, created.size); assertEquals(1, attempts.get())
        old.cancel(); old.finishConsumption(); scheduler.drain()
        assertEquals(NativeVideoRecorder.State.BUFFERING, created[1].second.state)
        assertFalse(old.replayAllowed())
        assertFalse(session.nativeVideoDiagnostics()!!.containsKey("previous"))
    }

    @Test fun activeRecorderResumesOnSameEpochSettlementAndBackgroundRemainsSuspended() {
        val session = enabled(); session.pause()
        val token = begin(); val revokedEpoch = VideoPrivacyRevocation.current
        token.close(); scheduler.drain()
        assertEquals(revokedEpoch, VideoPrivacyRevocation.current)
        assertEquals(2, created.size)
        assertEquals(NativeVideoRecorder.State.CLOSED, created.first().second.state)
        assertEquals(NativeVideoRecorder.State.SUSPENDED, created.last().second.state)
        assertEquals(0L, created.last().second.attempts.get())
        session.resume(); scheduler.drain(); assertEquals(NativeVideoRecorder.State.BUFFERING, created.last().second.state)
        assertEquals(1, attempts.get())
    }

    @Test fun unrelatedSettlementCannotClearAnOutstandingUncertaintyToken() {
        enabled(); val uncertainty = begin(); val ordinary = begin()
        ordinary.close(); scheduler.drain()
        assertTrue(VideoPrivacyRevocation.blocked); assertEquals(1, created.size)
        assertEquals(NativeVideoRecorder.State.CLOSED, created.single().second.state)
        // Only the test owns proof that this synthetic uncertainty can be released during cleanup.
        assertNotNull(uncertainty)
    }

    @Test fun actualMarkerHistoryOverflowRemainsBlockingAfterUnrelatedTokenSettles() {
        val session = enabled()
        // Model a process restart only in this test: overflow intentionally exposes no production token/reset.
        val viewsField = VideoSensitiveViews::class.java.getDeclaredField("views").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val views = viewsField.get(null) as MutableList<java.lang.ref.WeakReference<android.view.View>>
        val savedViews = views.toList()
        val overflow = VideoSensitiveViews::class.java.getDeclaredField("overflowed").apply { isAccessible = true }
        val savedOverflow = overflow.getBoolean(null)
        val pending = VideoPrivacyRevocation::class.java.getDeclaredField("pending").apply { isAccessible = true }
            .get(null) as java.util.concurrent.atomic.AtomicLong
        val savedPending = pending.get()
        val retained = mutableListOf<android.view.View>()
        try {
            repeat(2049) { android.view.View(context).also { retained.add(it); VideoSensitiveViews.rememberObserved(it) } }
            begin().close(); scheduler.drain()
            assertEquals(savedPending + 1L, pending.get())
            assertTrue(VideoPrivacyRevocation.blocked); assertEquals(1, created.size)
            assertEquals(NativeVideoRecorder.State.CLOSED, created.single().second.state)
            assertNull(VideoSensitiveViews.inspect(null, 1L, 4096, now = { 0L }))
        } finally {
            session.teardown(); pending.set(savedPending); overflow.setBoolean(null, savedOverflow)
            views.clear(); views.addAll(savedViews)
        }
    }

    @Test fun completedInitialPolicyWhileRegistrationPendingStartsOnlyOnSettlement() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        fetch = { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
        val session = session(); session.enableIfConfigured()
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            val token = begin(); scheduler.drain(); assertTrue(created.isEmpty())
            release.countDown(); awaitInitial(session); scheduler.drain(); assertTrue(created.isEmpty())
            token.close(); scheduler.drain(); assertEquals(1, created.size); assertEquals(1, attempts.get())
        } finally { release.countDown() }
    }

    @Test fun noInitialDecisionAndFailedInitialDecisionCannotRecoverFromSettlement() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        fetch = { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
        body = "malformed"
        val session = session(); session.enableIfConfigured()
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            begin().close(); scheduler.drain(); assertTrue(created.isEmpty())
            val pending = begin(); release.countDown(); awaitInitial(session)
            pending.close(); scheduler.drain(); assertTrue(created.isEmpty()); assertEquals(1, attempts.get())
        } finally { release.countDown() }
    }

    @Test fun latestFailedOffUnsampledAndUnsupportedPoliciesDenyDespiteLastGoodConfig() = runBlocking {
        for (denied in listOf("malformed", ON.replace("true", "false"), ON.replace("samplingRate\":1", "samplingRate\":0"),
            ON.replace("framesPerSecond\":5", "framesPerSecond\":7"))) {
            body = ON
            val session = enabled(); val count = created.size
            val token = begin(); body = denied; session.refreshConfigNow()
            token.close(); scheduler.drain(); assertEquals(denied, count, created.size)
            assertEquals(NativeVideoRecorder.State.CLOSED, created.last().second.state)
            session.teardown()
        }
    }

    @Test fun localConsentLiveGateAndTeardownVetoSettlement() {
        for ((disabled, consent) in listOf(true to true, false to false)) {
            val session = session(disabled, consent); session.enableIfConfigured(); awaitInitial(session)
            begin().close(); scheduler.drain(); assertTrue(created.isEmpty()); session.teardown()
        }
        val session = enabled(); val token = begin(); Everframe.captureGate = false
        token.close(); scheduler.drain(); assertEquals(1, created.size)
        Everframe.captureGate = true
        val pending = begin(); session.teardown(); pending.close(); scheduler.drain(); assertEquals(1, created.size)
    }

    @Test @Config(sdk = [28]) fun unsupportedApiCannotRecover() {
        val session = session(); session.enableIfConfigured(); awaitInitial(session)
        begin().close(); scheduler.drain(); assertTrue(created.isEmpty())
    }

    @Test fun newRegistrationBeforeQueuedStartupRunsDeniesStaleAdmission() {
        val session = session(); session.enableIfConfigured(); awaitInitial(session)
        val first = begin(); first.close()
        val second = begin(); scheduler.drain(); assertTrue(created.isEmpty())
        second.close(); scheduler.drain(); assertEquals(1, created.size); assertEquals(1, attempts.get())
    }

    @Test fun nativeConstructorAndOffMainMarkerFenceRealFreshFrameAdmissionUntilDetach() {
        val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        val root = android.widget.FrameLayout(activity)
        activity.setContentView(root); root.layout(0, 0, 100, 100)
        val gate = VideoPrivacyGate({ activity }, { 0L }, { true })
        val commits = ArrayDeque<() -> Unit>()
        val platform = object : VideoCapturePlatform {
            override fun observe() = gate.observe(root)
            override fun watch(onPreDraw: () -> Unit, onExtraCommit: () -> Unit): () -> Unit = {}
            override fun commit(callback: () -> Unit): () -> Unit { commits.add(callback); return { commits.remove(callback) } }
            override fun copy(bitmap: android.graphics.Bitmap, callback: (Boolean) -> Unit) { callback(true) }
        }
        captureFactory = { PixelCopyVideoCapture(platform, scheduler, { size ->
            android.graphics.Bitmap.createBitmap(size.width, size.height, android.graphics.Bitmap.Config.ARGB_8888)
        }) }
        val session = enabled()
        try {
            val native = dev.everframe.sensitive.TXSensitiveView(activity)
            assertEquals(true, native.getTag(dev.everframe.R.id.tx_sensitive))
            root.addView(native)
            var preDraw = false
            native.viewTreeObserver.addOnPreDrawListener {
                preDraw = true; assertEquals(true, native.getTag(dev.everframe.R.id.tx_sensitive)); true
            }
            native.viewTreeObserver.dispatchOnPreDraw(); assertTrue(preDraw)
            scheduler.drain(); assertEquals(2, created.size)
            assertTrue(commits.isEmpty()); assertEquals(0L, created.last().second.acceptedFrames.get())
            assertTrue(created.last().second.privacyExclusions > 0)
            root.removeView(native); session.pause(); session.resume(); scheduler.drain()
            commits.removeFirst().invoke(); scheduler.drain()
            assertEquals(1L, created.last().second.acceptedFrames.get())
            val late = android.view.View(activity); root.addView(late)
            Thread { Everframe.markSensitive(late) }.apply { start(); join(2_000); assertFalse(isAlive) }
            assertTrue(VideoPrivacyRevocation.blocked)
            scheduler.drain(); assertEquals(2, created.size)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            assertEquals(true, late.getTag(dev.everframe.R.id.tx_sensitive))
            scheduler.drain(); assertEquals(3, created.size)
            assertTrue(commits.isEmpty()); assertEquals(0L, created.last().second.acceptedFrames.get())
            root.removeView(late); session.pause(); session.resume(); scheduler.drain()
            commits.removeFirst().invoke(); scheduler.drain()
            assertEquals(1L, created.last().second.acceptedFrames.get()); assertEquals(1, attempts.get())
        } finally { session.teardown(); scheduler.drain(); activity.finish() }
    }

    @Test fun delayedOldRevocationAndSettlementHintsCannotRestartOrBypassNewPendingToken() {
        enabled()
        val callbacks = observerCallbacks()
        val oldEpoch = VideoPrivacyRevocation.current
        begin().close(); scheduler.drain(); assertEquals(2, created.size)
        callbacks.first(oldEpoch); callbacks.second(); scheduler.drain(); assertEquals(2, created.size)
        val pending = begin()
        callbacks.second(); scheduler.drain(); assertEquals(2, created.size)
        pending.close(); scheduler.drain(); assertEquals(3, created.size)
        callbacks.first(oldEpoch); scheduler.drain(); assertEquals(3, created.size)
        assertEquals(NativeVideoRecorder.State.BUFFERING, created.last().second.state)
    }

    @Test fun settlementReconcilesMissedLatestRevocationBeforeAuthorizingFreshGeneration() {
        val session = enabled()
        val old = session.freezeOwnedCapture()
        val callbacks = observerCallbacks()
        // Hold delivery at the subscription boundary; the real global generation/pending state still advances.
        val intercepted = VideoPrivacyRevocation.subscribe { }
        try {
            begin().close()
            callbacks.second()
            old.finishConsumption(); scheduler.drain()
            assertEquals(2, created.size); assertFalse(old.replayAllowed())
            callbacks.first(VideoPrivacyRevocation.current); scheduler.drain()
            assertEquals(2, created.size)
        } finally { old.cancel(); intercepted.close() }
    }

    @Test fun tornDownObserverCannotReauthorizeAfterReplacementSessionStarts() {
        val old = enabled(); val callbacks = observerCallbacks(); val token = begin()
        old.teardown()
        val replacement = session(); replacement.enableIfConfigured(); awaitInitial(replacement)
        token.close(); scheduler.drain(); assertEquals(2, created.size)
        callbacks.second(); callbacks.first(VideoPrivacyRevocation.current); scheduler.drain()
        assertEquals("0", old.nativeVideoDiagnostics()!!["authorized"].toString())
        assertEquals("1", replacement.nativeVideoDiagnostics()!!["authorized"].toString())
        assertEquals(2, created.size); assertEquals(NativeVideoRecorder.State.BUFFERING, created.last().second.state)
    }

    @Suppress("UNCHECKED_CAST")
    private fun observerCallbacks(): Pair<(Long) -> Unit, () -> Unit> {
        val field = VideoPrivacyRevocation::class.java.getDeclaredField("observer").apply { isAccessible = true }
        val owner = (field.get(null) as java.util.concurrent.atomic.AtomicReference<*>).get()!!
        fun read(name: String) = owner.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(owner)
        return (read("callback") as (Long) -> Unit) to (read("onSettled") as () -> Unit)
    }

    @Test fun settingsAndDurationComeFromOnePublishedDecisionDuringAncillaryPublication() {
        val session = enabled(); val token = begin()
        val held = CountDownLatch(1); val release = CountDownLatch(1)
        val errors = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val locker = Thread {
            try { dev.everframe.capture.sharedBreadcrumbBuffer.__holdLockForTesting {
                held.countDown(); check(release.await(3, TimeUnit.SECONDS))
            } } catch (t: Throwable) { errors.set(t) }
        }.apply { start() }
        assertTrue(held.await(2, TimeUnit.SECONDS))
        body = ON.replace("DurationSec\":30", "DurationSec\":60")
        val refresher = Thread { try { runBlocking { session.refreshConfigNow() } } catch (t: Throwable) { errors.set(t) } }.apply { start() }
        try {
            val deadline = System.nanoTime() + 2_000_000_000L
            while (session.currentConfig.replayDurationSec != 60 && System.nanoTime() < deadline) Thread.yield()
            assertEquals(60, session.currentConfig.replayDurationSec)
            token.close(); scheduler.drain()
            assertEquals("unpublished ancillary config cannot supply startup duration", listOf(30_000_000L, 30_000_000L), durations)
        } finally { release.countDown(); locker.join(3_000); refresher.join(3_000) }
        errors.get()?.let { throw it }; assertFalse(refresher.isAlive); assertFalse(locker.isAlive)
        scheduler.drain(); assertEquals(listOf(30_000_000L, 30_000_000L, 60_000_000L), durations)
    }

    @Test fun oldStartupCompletionDeliveredLastCannotReplaceFreshPendingIdentity() {
        val session = session(); session.enableIfConfigured(); awaitInitial(session)
        val admission = session.videoStartupAdmission!!
        val pending = admission.javaClass.getDeclaredField("pending").apply { isAccessible = true }.get(admission)!!
        @Suppress("UNCHECKED_CAST")
        val complete = pending.javaClass.getDeclaredField("complete").apply { isAccessible = true }.get(pending) as (Boolean) -> Unit
        begin().close(); scheduler.drain(); assertEquals(1, created.size)
        complete(true); complete(false); scheduler.drain()
        assertEquals(1, created.size); assertEquals(NativeVideoRecorder.State.BUFFERING, created.single().second.state)
        assertEquals(1, attempts.get())
    }

    private class Scheduler : VideoCaptureScheduler {
        private val tasks = java.util.concurrent.ConcurrentLinkedQueue<() -> Unit>()
        override fun main(block: () -> Unit) { tasks.add(block) }
        private var worker = false
        override fun worker(block: () -> Unit) { tasks.add {
            worker = true
            try { block() } finally { worker = false }
        } }
        override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
        override fun isWorkerThread() = worker
        override fun nowNanos() = 0L
        fun drain() { repeat(100) { (tasks.poll() ?: return).invoke() }; error("unbounded work") }
    }
    companion object {
        private const val ON = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":5}}"""
    }
}
