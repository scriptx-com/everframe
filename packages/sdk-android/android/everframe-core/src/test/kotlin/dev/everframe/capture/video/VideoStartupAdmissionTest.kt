// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.*
import dev.everframe.shared.SharedData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
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
import java.io.File
import java.io.IOException
import java.nio.file.DirectoryStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VideoStartupAdmissionTest {
    private val root = Files.createTempDirectory("video-startup").toFile()
    private val sessions = java.util.concurrent.CopyOnWriteArrayList<ReplaySession>()
    private val scheduler = ManualScheduler()
    private val budget = VideoDiskBudget()
    private var clock = 0L
    private var reads = 0
    private var listings = 0
    private var beforeRead: (Path) -> Unit = {}
    private var beforeList: (Path) -> Unit = {}
    private var deletePath: (Path) -> Boolean = { AndroidVideoStartupFiles.delete(it) }
    private val files = object : VideoStartupFiles {
        override fun attributes(path: Path): BasicFileAttributes {
            assertTrue("video stat must execute on the capture worker", scheduler.isWorkerThread())
            reads++; beforeRead(path)
            return AndroidVideoStartupFiles.attributes(path)
        }
        override fun entries(path: Path): DirectoryStream<Path> {
            assertTrue("video listing must execute on the capture worker", scheduler.isWorkerThread())
            listings++; beforeList(path)
            return AndroidVideoStartupFiles.entries(path)
        }
        override fun delete(path: Path): Boolean {
            assertTrue("video deletion must execute on the capture worker", scheduler.isWorkerThread())
            return deletePath(path)
        }
    }
    private fun admission(disk: VideoDiskBudget = budget) = VideoStartupAdmission(scheduler, { clock }) { root, began ->
        VideoStartupCleaner(disk, files) { clock }.clean(root, began)
    }
    private var startup = admission()
    private val created = mutableListOf<VideoOwner>()
    private val encodedFiles = mutableListOf<File>()
    private var beforeRoot: () -> Unit = {}
    private val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Context>()) {
        override fun getNoBackupFilesDir(): File { beforeRoot(); return root }
        override fun getApplicationContext(): Context = this
    }
    @Before fun setUp() {
        Dispatchers.setMain(StandardTestDispatcher())
        SharedData.init(context)
        Everframe.captureGate = true
    }
    @After fun tearDown() {
        Everframe.__resetStartTailDelayHookForTesting()
        sessions.toList().forEach { it.teardown() }
        Everframe.kill()
        scheduler.drain()
        budget.retryCleanup()
        Everframe.__setConfigForTesting(null)
        Dispatchers.resetMain()
        root.deleteRecursively()
    }
    private var configExtras = ""
    private fun session(epoch: Int = Everframe.currentStartEpochVolatile(), consent: Boolean = true): ReplaySession {
        val provider = ReplayConfigProvider.make("https://startup.test", "key", ConfigFetcher { request ->
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("ok")
                .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":5}$configExtras}""".toResponseBody()).build()
        })
        return ReplaySession(apiKey = "key", provider = provider, context = context,
            originatingStartEpoch = epoch, captureConsent = consent).also { session ->
            sessions.add(session)
            session.videoStartupAdmission = startup
            session.recorderFactory = { _, owner, _ ->
                created.add(owner)
                NativeVideoRecorder(owner, scheduler, { block -> scheduler.worker(block); true }, { VideoSize(4, 4) }, { null }, { _, _, _ ->
                    object : RecordingVideoEncoder {
                        private var output: File? = null
                        override fun prepare(size: VideoSize, fps: Int): VideoSize {
                            assertTrue(scheduler.isWorkerThread())
                            output = artifact(owner.sessionId, owner.captureId, "gop-${UUID.randomUUID()}-0.mp4", "new")
                            encodedFiles.add(output!!)
                            return size
                        }
                        override fun offer(frame: SafeVideoFrame) = false
                        override fun finish(deadline: Long): List<VideoSegment> { close(); return emptyList() }
                        override val isTerminal = false
                        override fun close() { scheduler.worker { output?.delete() } }
                    }
                }, { _, _ -> null })
            }
        }
    }
    private fun artifact(session: String = UUID.randomUUID().toString(), capture: String = UUID.randomUUID().toString(),
        name: String = "${UUID.randomUUID()}.partial", body: String = "stale"): File =
        File(File(File(File(root, "everframe-video"), session), capture), name).apply { parentFile!!.mkdirs(); writeText(body) }

    @Test fun sessionDoesNotConstructRecorderUnderConfigurationAuthorizationBeforeWorkerCleanup() = runBlocking {
        val stale = artifact()
        val gop = artifact(name = "gop-${UUID.randomUUID()}-3.mp4")
        val session = session()
        session.refreshConfigNow()
        assertEquals("Recorder creation must wait for worker startup cleanup", 0, created.size)
        assertTrue(stale.exists()); assertTrue(gop.exists()); assertEquals(0, reads)
        scheduler.drain()
        assertFalse(stale.exists()); assertFalse(gop.exists())
        assertEquals(1, created.size); assertEquals(1, encodedFiles.size); assertTrue(encodedFiles.single().exists())
    }

    @Test fun failedDeletionRemainsChargedAndBlocksVideoButPreservesReportCapture() = runBlocking {
        val stale = artifact(body = "private")
        deletePath = { false }
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertTrue(stale.exists()); assertEquals(7L, budget.usedBytes); assertNull(budget.reserve(1))
        assertTrue(created.isEmpty()); assertTrue(Everframe.captureGate)
        val report = session.freezeOwnedCapture()
        assertNotNull(report.takeBreadcrumbs()); assertFalse(report.replayAllowed())
        assertTrue(dev.everframe.transport.ReportAuthorizationFactory.forCapture(Everframe.captureSessionSnapshot(), report).evaluate().reportAllowed)
        report.cancel()
        val scanned = reads
        deletePath = { AndroidVideoStartupFiles.delete(it) }
        session.refreshConfigNow(); scheduler.drain()
        assertEquals("blocked startup must not retry within the process", scanned, reads)
        assertTrue(created.isEmpty())
        session.teardown()
        // A fresh process has no old in-memory reservations, but must inspect the same disk.
        startup = admission(VideoDiskBudget())
        val fresh = session(); fresh.refreshConfigNow(); scheduler.drain()
        assertFalse(stale.exists()); assertEquals(1, encodedFiles.size)
    }

    @Test fun unknownAndSymlinkStructuresStayUntouchedAndDenyNewFiles() = runBlocking {
        val external = File(root, "outside").apply { mkdirs() }
        val secret = File(external, "secret").apply { writeText("keep") }
        val video = File(root, "everframe-video").apply { mkdirs() }
        val link = File(video, UUID.randomUUID().toString()).toPath()
        Files.createSymbolicLink(link, external.toPath())
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertTrue(created.isEmpty()); assertEquals("keep", secret.readText()); assertTrue(Files.isSymbolicLink(link))
    }

    @Test fun unknownArtifactIsPreservedAndDoesNotAuthorizeFreeBudget() = runBlocking {
        val unknown = artifact(name = "unknown.txt")
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertTrue(unknown.exists()); assertTrue(created.isEmpty()); assertTrue(Everframe.captureGate)
    }

    @Test fun unreadableListingOrStatDeniesRecordingInsteadOfTreatingDirectoryAsEmpty() = runBlocking {
        val stale = artifact()
        beforeList = { throw IOException("unreadable") }
        val a = session(); a.refreshConfigNow(); scheduler.drain()
        assertTrue(stale.exists()); assertTrue(created.isEmpty()); a.teardown(); scheduler.drain()
        startup = admission(); beforeList = {}; beforeRead = { throw IOException("uncertain stat") }
        val b = session(); b.refreshConfigNow(); scheduler.drain()
        assertTrue(stale.exists()); assertTrue(created.isEmpty())
    }

    @Test fun entryBudgetStopsStreamingEnumerationBeforeUnboundedMaterialization() = runBlocking {
        val video = File(root, "everframe-video").apply { mkdirs() }
        repeat(4097) { File(video, UUID.randomUUID().toString()).mkdir() }
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertEquals(4096, reads); assertTrue(created.isEmpty())
        assertTrue(video.listFiles()!!.isNotEmpty())
    }

    @Test fun observedDeadlineAfterSlowFilesystemCallBlocksAdmission() = runBlocking {
        val stale = artifact()
        beforeRead = { clock += 100_000_000L }
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertTrue(stale.exists()); assertEquals(1, reads); assertTrue(created.isEmpty())
    }

    @Test fun delayedMissingRootDoesNotBypassObservedDeadline() = runBlocking {
        beforeRead = { clock += 100_000_000L; throw java.nio.file.NoSuchFileException(it.toString()) }
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertEquals(1, reads); assertTrue(created.isEmpty())
    }

    @Test fun rootResolutionConsumesTheSameObservedWorkerDeadline() = runBlocking {
        beforeRoot = { clock += 100_000_000L }
        val session = session(); session.refreshConfigNow(); scheduler.drain()
        assertEquals(0, reads); assertTrue(created.isEmpty())
    }

    @Test fun janitorProtectsActualExportLeaseAndBlocksOnUnknownArtifacts() = runBlocking {
        val h = VideoExporterTest.Harness()
        val clip = h.exporter.export(h.owner, listOf(h.segment())) { true }!!
        val foreign = File(clip.file.parentFile, "unknown.txt").apply { writeText("keep") }
        fun clean(): Boolean {
            var result = false
            scheduler.worker { result = VideoDirectoryLeases.cleanStartup(h.root, h.budget) }
            scheduler.drain()
            return result
        }
        try {
            assertFalse(clean()); assertTrue(clip.file.exists())
            clip.close()
            val stale = File(foreign.parentFile, "${UUID.randomUUID()}.partial").apply { writeText("stale") }
            assertFalse(clean()); assertTrue(foreign.exists())
            foreign.delete()
            assertTrue(clean()); assertFalse(stale.exists()); assertEquals(0L, h.budget.usedBytes)
        } finally { clip.close(); h.root.deleteRecursively() }
    }

    @Test fun supersededKillTailPreservesReplacementRecorderRefreshJobsAndEvidence() = killTailReplacement(false)
    @Test fun cancellationCallbackCanStartReplacementWithoutOldJobSweepCancellingIt() = killTailReplacement(true)

    private fun killTailReplacement(fromCancellation: Boolean) = runBlocking {
        configExtras = """, "branding":{"watermark":false}, "companionBadge":{"enabled":false,"position":"top-left"}"""
        Everframe.__replaySessionFactoryForTesting = { _, _, epoch, consent, _ -> session(epoch, consent) }
        val config = EverframeConfig(appId = "A", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false))
        fun awaitSession(count: Int): ReplaySession {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while ((sessions.size < count || Everframe._replaySession !== sessions.last()) && System.nanoTime() < deadline) Thread.yield()
            assertEquals(count, sessions.size)
            return sessions.last()
        }
        Everframe.start(context, config)
        val a = awaitSession(1)
        a.refreshConfigNow(); scheduler.drain()
        val capturedA = Everframe.captureSessionSnapshot()
        val aFile = encodedFiles.single()
        val marker = "B-owned-evidence"
        var b: ReplaySession? = null
        var bRefreshJob: kotlinx.coroutines.Job? = null
        val refreshField = ReplaySession::class.java.getDeclaredField("refreshLoopJob").apply { isAccessible = true }
        val theme = ReporterThemeOptions(accent = "#123456")
        val startReplacement = {
                Everframe.start(context, config.copy(appId = "B", theme = theme))
                b = awaitSession(2)
                runBlocking { b!!.refreshConfigNow() }; scheduler.drain()
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
                while (refreshField.get(b) == null && System.nanoTime() < deadline) Thread.yield()
                bRefreshJob = refreshField.get(b) as? kotlinx.coroutines.Job
                assertNotNull("B must have registered its exact periodic refresh job", bRefreshJob)
                Everframe.addBreadcrumb(marker)
        }
        val oldJob = kotlinx.coroutines.Job(Everframe.sdkScope.coroutineContext[kotlinx.coroutines.Job])
        try {
            if (fromCancellation) oldJob.invokeOnCompletion { startReplacement() }
            else Everframe.__reporterTriggersTeardown = startReplacement
            Everframe.kill()
        } finally { Everframe.__reporterTriggersTeardown = null }
        assertSame("old kill must leave B installed", b, Everframe._replaySession)
        assertFalse(b!!.isTornDownForTesting)
        assertTrue("old captured job must be cancelled", oldJob.isCancelled)
        assertEquals(false, BrandingServerConfigSignal.flow.value?.watermark)
        assertEquals(false, dev.everframe.companion.CompanionBadgeServerConfigSignal.flow.value?.enabled)
        assertEquals(theme, BrandingInlineTheme.flow.value)
        assertTrue("B's exact refresh loop must remain live", bRefreshJob!!.isActive)
        b!!.refreshConfigNow(); scheduler.drain()
        assertEquals(NativeVideoRecorder.State.BUFFERING, b!!.__lifecycleStateForTesting())
        assertTrue(encodedFiles.last().exists()); assertFalse(aFile.exists())
        assertTrue(a.isTornDownForTesting); assertTrue(capturedA.isRevoked)
        assertTrue(dev.everframe.capture.sharedBreadcrumbBuffer.snapshotForReport().any { it.message == marker })
    }

    @Test fun publicStartPreservesCapturedFactoryInputsAndInstallIdentifierVeto() {
        val supplied = CountDownLatch(1)
        val config = EverframeConfig(appId = "veto", sdkKey = "txx_live_test1234567890", installIdentifierEnabled = false,
            capture = CaptureConfig(logs = false))
        val error = AtomicReference<Throwable?>()
        Everframe.__replaySessionFactoryForTesting = { app, received, epoch, consent, identifier ->
            try {
                assertSame(context, app); assertSame(config, received)
                assertEquals(Everframe.currentStartEpochVolatile(), epoch); assertTrue(consent)
                assertNull("disabled install identity must not mint or provide an ID", identifier())
            } catch (t: Throwable) { error.set(t) }
            session(epoch, consent).also { supplied.countDown() }
        }
        Everframe.start(context, config)
        assertTrue(supplied.await(3, TimeUnit.SECONDS)); error.get()?.let { throw it }
    }

    @Test fun sharedSuccessSkipsCleanupWithLiveRecorderAndExportLeasesAndDeniesAnotherRoot() = runBlocking {
        val a = session(); a.refreshConfigNow(); scheduler.drain()
        val live = encodedFiles.single(); val scanned = reads
        val exportLease = VideoDirectoryLeases.acquire()
        try {
            val b = session(); b.refreshConfigNow(); scheduler.drain()
            assertEquals(scanned, reads); assertTrue(live.exists()); assertEquals(2, encodedFiles.size)
            var otherAllowed: Boolean? = null
            startup.request(object : ContextWrapper(context) { override fun getNoBackupFilesDir() = File(root, "other") }) { otherAllowed = it }
            scheduler.drain()
            assertEquals(false, otherAllowed); assertTrue(live.exists()); assertEquals(scanned, reads)
        } finally { exportLease.close() }
    }

    @Test fun freshCleanupRefusesLiveLeaseWithoutExaminingOrDeletingItsFiles() = runBlocking {
        val stale = artifact()
        val lease = VideoDirectoryLeases.acquire()
        try {
            val session = session(); session.refreshConfigNow(); scheduler.drain()
            assertEquals(0, reads); assertTrue(stale.exists()); assertTrue(created.isEmpty())
        } finally { lease.close() }
    }

    @Test fun revokedOrFrozenSessionCannotBeResurrectedByLateCleanup() = runBlocking {
        val session = session(); session.refreshConfigNow()
        val frozen = session.freezeOwnedCapture()
        scheduler.drain(); assertTrue(created.isEmpty())
        frozen.cancel(); session.teardown(); scheduler.drain()
        assertTrue(encodedFiles.isEmpty())
    }

    @Test fun realPublicStartKillAndReplacementShareDeferredCleanupWithoutResurrectingOldSession() {
        val stale = artifact()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        beforeList = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        Everframe.__replaySessionFactoryForTesting = { _, _, epoch, consent, _ -> session(epoch, consent) }
        val config = EverframeConfig(appId = "test", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false))
        Everframe.start(context, config)
        assertTrue("first public start must reach queued admission", scheduler.posted.await(3, TimeUnit.SECONDS))
        assertTrue(stale.exists()); assertTrue(created.isEmpty())
        val error = AtomicReference<Throwable?>()
        val worker = Thread { try { scheduler.runWorker() } catch (t: Throwable) { error.set(t) } }.apply { start() }
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            Everframe.kill()
            Everframe.start(context, config.copy(sdkKey = "txx_live_test0987654321"))
            val deadline = System.nanoTime() + 3_000_000_000L
            while ((sessions.size < 2 || !sessions.last().currentConfig.replayEnabled) && System.nanoTime() < deadline) Thread.yield()
            assertEquals(2, sessions.size)
            // Serialize with B's public initial refresh; its cleanup remains behind the blocked A operation.
            runBlocking { sessions.last().refreshConfigNow() }
            assertEquals("one executing request and one retained replacement, no posted queue", 0, scheduler.workerCount())
            assertTrue(stale.exists()); assertTrue(created.isEmpty())
        } finally { release.countDown(); worker.join(3_000) }
        error.get()?.let { throw it }
        assertFalse(worker.isAlive)
        scheduler.drain()
        assertFalse(stale.exists()); assertEquals(1, created.size); assertEquals(1, encodedFiles.size)
        assertEquals("root, session, capture and stale file inspected exactly once", 4, reads)
        assertTrue(sessions.first().isTornDownForTesting); assertTrue(Everframe.captureGate)
        val report = Everframe.__replayFreeze(); assertNotNull(report.takeBreadcrumbs()); report.cancel()
    }

    @Test fun blockingFilesystemDoesNotHoldAuthorizationOrLeaseMonitorAndExportConflictOmits() = runBlocking {
        artifact()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        beforeList = { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
        val session = session(); session.refreshConfigNow()
        val error = AtomicReference<Throwable?>()
        val worker = Thread { try { scheduler.runWorker() } catch (t: Throwable) { error.set(t) } }.apply { start() }
        val responsive = CountDownLatch(1)
        var caller: Thread? = null
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            // The directory call remains blocked until finally; no operation may wait on its monitor.
            caller = Thread {
                try {
                    Everframe.__withStateLockForTesting { session.pause(); session.resume() }
                    val lease = runCatching { VideoDirectoryLeases.acquire() }
                    lease.getOrNull()?.close()
                    assertTrue(lease.isFailure)
                    runBlocking {
                        assertNull(VideoExporter(File(root, "everframe-video"), scheduler).export(
                            VideoOwner(UUID.randomUUID().toString(), UUID.randomUUID().toString()), emptyList()) { true })
                    }
                    session.teardown()
                } catch (t: Throwable) { error.set(t) }
                finally { responsive.countDown() }
            }.apply { start() }
            assertTrue("authorization and lease operations must complete before directory IO returns",
                responsive.await(1, TimeUnit.SECONDS))
        } finally { release.countDown(); worker.join(3_000); caller?.join(3_000) }

        error.get()?.let { throw it }
        assertFalse(worker.isAlive); scheduler.drain(); assertTrue(created.isEmpty())
    }

    @Test @Config(sdk = [24, 25]) fun oldApiPublicStartNeverInvokesVideoFilesystem() {
        Everframe.__replaySessionFactoryForTesting = { _, _, epoch, consent, _ -> session(epoch, consent) }
        val built = CountDownLatch(1)
        val config = EverframeConfig(appId = "old", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false))
        Everframe.__startTailDelayHookForTesting = { built.countDown() }
        Everframe.start(context, config)
        assertTrue(built.await(3, TimeUnit.SECONDS))
        runBlocking { sessions.single().refreshConfigNow() }
        scheduler.drain()
        assertEquals(0, reads); assertEquals(0, scheduler.workerCount()); assertTrue(created.isEmpty())
        assertTrue(Everframe.captureGate)
        val report = Everframe.__replayFreeze(); assertNotNull(report.takeBreadcrumbs()); report.cancel()
    }

    private class ManualScheduler : VideoCaptureScheduler {
        private val worker = ArrayDeque<() -> Unit>()
        private val main = ArrayDeque<() -> Unit>()
        private val active = ThreadLocal.withInitial { false }
        @Volatile var posted = CountDownLatch(1)
        override fun main(block: () -> Unit) { synchronized(main) { main.add(block) } }
        override fun worker(block: () -> Unit) { synchronized(worker) { worker.add(block) }; posted.countDown() }
        override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
        override fun isWorkerThread() = active.get() == true
        override fun nowNanos() = System.nanoTime()
        fun workerCount() = synchronized(worker) { worker.size }
        fun runWorker(): Boolean {
            val task = synchronized(worker) { if (worker.isEmpty()) null else worker.removeFirst() } ?: return false
            active.set(true)
            try { task() } finally { active.set(false) }
            return true
        }
        fun drain() {
            repeat(1000) {
                if (runWorker()) return@repeat
                val task = synchronized(main) { if (main.isEmpty()) null else main.removeFirst() } ?: return
                task()
            }
            error("Unbounded test work")
        }
    }
}
