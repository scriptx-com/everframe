// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 5 Task 1 (hygiene carry-over) — proves `TraceItX.start()` actually
// wires `LogCapture.install()` (gated on `config.capture.logs`) and that
// `kill()` symmetrically calls `LogCapture.uninstall()`. Before this task
// `LogCapture.install()`/`uninstall()` existed but were never called from
// `TraceItX.kt` — the whole Android log pipeline (and the Task-11 console
// breadcrumb dual-write, `ConsoleBreadcrumbAdapter.dualWrite`, fired from
// `LogCapture.kt`'s tee/tree push sites) was inert in real hosts. Mirrors
// iOS `TraceItX.swift:167-168` (`if config.capture.logs { LogCapture.install() }`)
// and `:349` (`kill()` -> `LogCapture.uninstall()`).
//
// Test-hygiene notes (the exact lesson from iOS Task 7 / mirrored here):
//   • The stdout/stderr tee LogCapture installs is PROCESS-WIDE (a single
//     JVM-level System.out/err swap) — every assertion below uses a
//     UUID-suffixed unique probe string + `.contains(...)`, never an exact
//     count or `.first()`, so concurrently-running suites' own console
//     output can never cause a false pass/fail here.
//   • `start()`'s `LogCapture.install()` call lives inside the detached
//     `sdkScope.launch { ... }` heavy-init coroutine (Dispatchers.IO) — it is
//     NOT synchronous with `start()` returning. `awaitHeavyInit()` below
//     polls (bounded ~2s) on `TraceItX._replaySession` becoming non-null,
//     which is the LAST statement in that coroutine's sequential body, so
//     its assignment happens-after every earlier step (including
//     `start.logCapture`) has already run. There is no injectable test
//     dispatcher for `sdkScope` in this codebase (checked: no other
//     start()-flow test overrides it), so a bounded poll is the documented
//     fallback per the task brief.
//   • `@After` uninstalls LogCapture, kills TraceItX, and resets the shared
//     breadcrumb buffer unconditionally so this suite's live tee can never
//     leak console output into another suite's assertions (mirrors
//     `LogCaptureTest`'s + `BreadcrumbRingBufferTest`'s teardown style). No
//     Android analogue of an iOS `BreadcrumbSharedStateTestLock` exists in
//     this module (checked) — none is invented here; teardown is kept
//     airtight instead.
package com.traceitx

import android.content.Context
import android.content.ContextWrapper
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import androidx.test.core.app.ApplicationProvider
import com.traceitx.capture.LogCapture
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedLogBuffer
import com.traceitx.config.CaptureConfig
import com.traceitx.config.TraceItXConfig
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.shared.SharedData
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class TraceItXLogWiringTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun configWith(logs: Boolean): TraceItXConfig = TraceItXConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        capture = CaptureConfig(logs = logs),
    )

    /**
     * Bounded poll for `start()`'s detached heavy-init coroutine to finish.
     * `_replaySession` is assigned as the LAST statement in that coroutine's
     * sequential body (see file header) — non-null is a reliable "everything
     * upstream, including the `start.logCapture` step, already ran" signal
     * regardless of whether logs capture itself was gated on/off.
     */
    private fun awaitHeavyInit(timeoutMs: Long = 2_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (TraceItX._replaySession == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertNotNull("heavy init did not publish its replay session", TraceItX._replaySession)
    }

    @Before
    fun setUp() {
        SharedData.init(context)
        // Defensive: a previous suite's failure could have left LogCapture
        // installed against a stale PrintStream snapshot.
        LogCapture.uninstall()
    }

    @After
    fun tearDown() {
        LogCapture.uninstall()
        TraceItX.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedLogBuffer.clear()
    }

    @Test
    fun `start with capture logs wires LogCapture and console crumbs flow end-to-end`() {
        TraceItX.start(context, configWith(logs = true))
        awaitHeavyInit()
        assertTrue("LogCapture must be installed when config.capture.logs is true", LogCapture.isInstalledForTest())

        val probe = "plan5-log-wiring-probe-${UUID.randomUUID()}"
        println(probe)

        // Sink 1 — the raw log ring buffer (System.out tee push site).
        assertTrue(
            "probe line must land in sharedLogBuffer",
            sharedLogBuffer.snapshot().any { it.message.contains(probe) },
        )

        // Sink 2 — the Task-11 dual-write console breadcrumb, live end-to-end
        // for the first time now that install() is actually wired.
        sharedBreadcrumbBuffer.freeze()
        val frozen = sharedBreadcrumbBuffer.takeFrozen().orEmpty()
        assertTrue(
            "probe line must also land as a .console breadcrumb; got: ${frozen.map { it.kind to it.message }}",
            frozen.any { it.kind == BreadcrumbKind.Console && it.message.contains(probe) },
        )
    }

    @Test
    fun `start with capture logs disabled installs nothing`() {
        TraceItX.start(context, configWith(logs = false))
        awaitHeavyInit()
        assertFalse("LogCapture must stay uninstalled when config.capture.logs is false", LogCapture.isInstalledForTest())

        val probe = "plan5-should-not-be-captured-${UUID.randomUUID()}"
        println(probe)

        assertFalse(
            "probe line must NOT be captured — no tee was installed",
            sharedLogBuffer.snapshot().any { it.message.contains(probe) },
        )
    }

    @Test
    fun `kill uninstalls LogCapture and restores System out`() {
        TraceItX.start(context, configWith(logs = true))
        awaitHeavyInit()
        assertTrue(LogCapture.isInstalledForTest())
        val wrapped = System.out

        TraceItX.kill()

        assertFalse("kill() must uninstall LogCapture", LogCapture.isInstalledForTest())
        assertNotSame("kill() must restore the original System.out, not leave the tee installed", wrapped, System.out)

        // Symmetric with the disabled-capture case above: once uninstalled, a
        // fresh probe must not be captured either.
        val probe = "plan5-post-kill-probe-${UUID.randomUUID()}"
        println(probe)
        assertFalse(
            "probe line must NOT be captured after kill() uninstalled the tee",
            sharedLogBuffer.snapshot().any { it.message.contains(probe) },
        )
    }
    @Test
    fun `start tail released after kill cannot reinstall log capture`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val firstBackgroundRead = AtomicBoolean(true)
        val caller = Thread.currentThread()
        val delayedContext = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context {
                // CrashReporter.configure reads this in the breadcrumb stage,
                // immediately before the detached start.logCapture stage.
                if (Thread.currentThread() !== caller &&
                    Thread.currentThread().stackTrace.any { it.className == "com.traceitx.crash.CrashReporter" && it.methodName == "configure" } &&
                    firstBackgroundRead.compareAndSet(true, false)) {
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS)) { "start tail was not released" }
                }
                return baseContext.applicationContext
            }
        }
        val previousChildren = TraceItX.sdkScope.coroutineContext[Job]!!.children.toSet()
        TraceItX.start(delayedContext, configWith(logs = true))
        val children = TraceItX.sdkScope.coroutineContext[Job]!!.children.filterNot { it in previousChildren }.toList()
        try {
            assertTrue("heavy init must reach the pre-log boundary", entered.await(5, TimeUnit.SECONDS))
            TraceItX.kill()
        } finally {
            release.countDown()
            runBlocking { withTimeout(5_000) { children.joinAll() } }
        }
        val probe = "late-start-after-kill-${UUID.randomUUID()}"
        println(probe)
        assertFalse("obsolete start must not capture a fresh post-kill probe",
            sharedLogBuffer.snapshot().any { it.message.contains(probe) })
        assertFalse(LogCapture.isInstalledForTest())
    }

    @Test
    fun `restarting with logs disabled stops the preceding enabled capture`() {
        TraceItX.start(context, configWith(logs = true))
        awaitHeavyInit()
        TraceItX.start(context, configWith(logs = false))
        awaitHeavyInit()
        val probe = "disabled-restart-${UUID.randomUUID()}"
        println(probe)
        assertFalse("disabled replacement config must stop earlier log capture",
            sharedLogBuffer.snapshot().any { it.message.contains(probe) })
        assertFalse(LogCapture.isInstalledForTest())
    }

    @Test
    fun `older kill cannot uninstall the newer starts log capture`() {
        TraceItX.start(context, configWith(logs = true))
        awaitHeavyInit()
        try {
            TraceItX.__reporterTriggersTeardown = {
                TraceItX.start(context, configWith(logs = true))
                awaitHeavyInit()
            }
            TraceItX.kill()
            val probe = "new-start-after-old-kill-${UUID.randomUUID()}"
            println(probe)
            assertTrue("superseded kill must preserve the newer starts capture",
                sharedLogBuffer.snapshot().any { it.message.contains(probe) })
        } finally {
            TraceItX.__reporterTriggersTeardown = null
        }
    }

    @Test
    fun `admitted old callback cannot insert logs or console crumbs after kill and start`() {
        TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
        val tree = timber.log.Timber.forest().last()
        val probe = "admitted-old-${UUID.randomUUID()}"
        val field = sharedLogBuffer.javaClass.getDeclaredField("lock").apply { isAccessible = true }
        val lock = field.get(sharedLogBuffer) as java.util.concurrent.locks.ReentrantLock
        val producer = Thread { tree.i(probe) }
        lock.lock()
        try {
            producer.start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (!lock.hasQueuedThread(producer) && System.nanoTime() < deadline) Thread.yield()
            assertTrue("callback has passed admission and waits at destination insertion", lock.hasQueuedThread(producer))
            TraceItX.kill()
            TraceItX.start(context, configWith(logs = true).copy(appId = "project-b")); awaitHeavyInit()
        } finally { lock.unlock(); producer.join(3_000) }
        assertFalse(producer.isAlive)
        assertFalse("old admitted log cannot enter B", sharedLogBuffer.snapshot().any { it.message.contains(probe) })
        assertFalse("old admitted dualwrite cannot enter B", sharedBreadcrumbBuffer.snapshotForReport().any { it.message.contains(probe) })
        val fresh = "new-B-${UUID.randomUUID()}"
        println(fresh)
        assertTrue(sharedLogBuffer.snapshot().any { it.message.contains(fresh) })
        assertTrue(sharedBreadcrumbBuffer.snapshotForReport().any { it.message.contains(fresh) })
    }

    @Test
    fun `enabled replacement clears completed old logs and replaces old producer authority`() {
        TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
        val tree = timber.log.Timber.forest().last()
        val old = "completed-old-${UUID.randomUUID()}"
        tree.i(old)
        assertTrue(sharedLogBuffer.snapshot().any { it.message.contains(old) })
        TraceItX.start(context, configWith(logs = true).copy(appId = "project-b")); awaitHeavyInit()
        tree.i(old)
        assertFalse("B must not inherit completed A logs or old producer authority", sharedLogBuffer.snapshot().any { it.message.contains(old) })
    }

    @Test
    fun `old console dualwrite blocked after log insertion is rejected by breadcrumb destination`() {
        TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
        val tree = timber.log.Timber.forest().last()
        val probe = "admitted-console-${UUID.randomUUID()}"
        val field = sharedBreadcrumbBuffer.javaClass.getDeclaredField("lock").apply { isAccessible = true }
        val lock = field.get(sharedBreadcrumbBuffer) as java.util.concurrent.locks.ReentrantLock
        val producer = Thread { tree.i(probe) }
        lock.lock()
        try {
            producer.start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (!lock.hasQueuedThread(producer) && System.nanoTime() < deadline) Thread.yield()
            assertTrue(lock.hasQueuedThread(producer))
            assertTrue("old callback really inserted its log before dualwrite", sharedLogBuffer.snapshot().any { it.message == probe })
            TraceItX.kill()
            TraceItX.start(context, configWith(logs = true).copy(appId = "project-b")); awaitHeavyInit()
        } finally { lock.unlock(); producer.join(3_000) }
        assertFalse(producer.isAlive)
        assertFalse("breadcrumb destination must reject old authority independently", sharedBreadcrumbBuffer.snapshotForReport().any { it.message == probe })
    }

    @Test
    fun `signal collector reentrant start preserves the newer inline theme and capture`() {
        TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
        val signal = com.traceitx.config.BrandingServerConfigSignal.flow
        signal.value = com.traceitx.config.BrandingConfigWire(watermark = false)
        val theme = com.traceitx.config.ReporterThemeOptions(accent = "#123456")
        val replaceOnce = AtomicBoolean(true)
        val collector = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined).launch {
            signal.collect { value ->
                if (value == null && replaceOnce.compareAndSet(true, false)) {
                    TraceItX.start(context, configWith(logs = true).copy(appId = "B", theme = theme))
                }
            }
        }
        try {
            TraceItX.kill(); awaitHeavyInit()
            assertFalse("collector must have reentered public start", replaceOnce.get())
            org.junit.Assert.assertEquals(theme, com.traceitx.config.BrandingInlineTheme.flow.value)
            val marker = "reentrant-B-${UUID.randomUUID()}"
            println(marker)
            assertTrue(sharedLogBuffer.snapshot().any { it.message == marker })
        } finally { collector.cancel() }
    }

    @Test
    fun `repeated enabled starts retain one SDK Timber tree and preserve host output`() {
        val hostLines = java.util.concurrent.CopyOnWriteArrayList<String>()
        val host = object : timber.log.Timber.Tree() {
            override fun log(priority: Int, tag: String?, message: String, t: Throwable?) { hostLines.add(message) }
        }
        timber.log.Timber.plant(host)
        val before = timber.log.Timber.forest().size
        try {
            repeat(8) { index ->
                TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
                org.junit.Assert.assertEquals("enabled renewal must not accumulate SDK trees", before + 1, timber.log.Timber.forest().size)
                val marker = "host-and-sdk-$index-${UUID.randomUUID()}"
                timber.log.Timber.i(marker)
                org.junit.Assert.assertEquals(1, hostLines.count { it == marker })
                org.junit.Assert.assertEquals(1, sharedLogBuffer.snapshot().count { it.message == marker })
            }
            TraceItX.kill()
            org.junit.Assert.assertEquals(before, timber.log.Timber.forest().size)
            assertTrue(timber.log.Timber.forest().contains(host))
        } finally { timber.log.Timber.uproot(host) }
    }

    @Test
    fun `uncertain Timber removal retains one inactive handle while new stdout capture works`() {
        TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
        val field = LogCapture.javaClass.getDeclaredField("ownedTimberTree").apply { isAccessible = true }
        val tree = field.get(LogCapture) as timber.log.Timber.Tree
        val forestSize = timber.log.Timber.forest().size
        // Fault injection models an incompatible optional Timber handle: the real detector
        // cannot remove it. No new production test hook or replacement backend is needed.
        val uncertain = Any()
        field.set(LogCapture, uncertain)
        try {
            repeat(3) {
                TraceItX.start(context, configWith(logs = true)); awaitHeavyInit()
                org.junit.Assert.assertSame(uncertain, field.get(LogCapture))
                org.junit.Assert.assertEquals(forestSize, timber.log.Timber.forest().size)
                val marker = "uncertain-tree-$it-${UUID.randomUUID()}"
                tree.i(marker)
                assertFalse("uncertain old producer stays revoked", sharedLogBuffer.snapshot().any { it.message == marker })
                println(marker)
                assertTrue("new stdout remains available", sharedLogBuffer.snapshot().any { it.message == marker })
            }
        } finally {
            // Restore the real owned handle so ordinary teardown settles its physical tree.
            field.set(LogCapture, tree)
            LogCapture.uninstall()
        }
    }

}
