// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// LogCaptureTest — exercises the production tap paths against the real Timber
// library (testImplementation only — see :everframe-core/build.gradle.kts).
// We verify:
//   • install() is idempotent — the second call plants no extra Tree.
//   • uninstall() is host-preserving — a host-installed Tree planted before our
//     install() survives uninstall(). This is the runtime complement to the
//     source-level `grep -c uprootAll` gate.
//   • System.out.println after install() lands a line in sharedLogBuffer.
//   • System.out.println after uninstall() does NOT push to sharedLogBuffer.
//
// Robolectric isn't required — LogCapture only touches Timber and the JVM
// PrintStream APIs. We run as a plain JUnit test so it works on the JVM
// without an Android runtime.
package dev.everframe.capture

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import timber.log.Timber
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class LogCaptureTest {

    /** A tiny no-op Tree used to represent a host's pre-existing logger. */
    private class HostTree : Timber.Tree() {
        override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
            // intentionally no-op
        }
    }

    @Before
    fun setUp() {
        // Defensive: previous tests may have left state. Forest is process-wide.
        Timber.uprootAll()
        sharedLogBuffer.clear()
        // Make sure LogCapture is uninstalled at start of each test.
        LogCapture.uninstall()
    }

    @After
    fun tearDown() {
        LogCapture.uninstall()
        Timber.uprootAll()
        sharedLogBuffer.clear()
    }

    @Test
    fun `install_is_idempotent_does_not_double_plant`() {
        val before = Timber.treeCount
        LogCapture.install()
        val afterFirst = Timber.treeCount
        LogCapture.install()
        val afterSecond = Timber.treeCount

        // Exactly one Tree planted; second install() is a no-op.
        assertEquals("first install plants exactly one tree", before + 1, afterFirst)
        assertEquals("second install plants nothing", afterFirst, afterSecond)
        assertTrue(LogCapture.isInstalledForTest())
    }

    @Test
    fun `uninstall_removes_only_sdk_tree_and_host_trees_survive`() {
        // Host plants their tree FIRST.
        val hostTree = HostTree()
        Timber.plant(hostTree)
        val countBefore = Timber.treeCount

        // We install (adds our tree), then uninstall.
        LogCapture.install()
        assertEquals(countBefore + 1, Timber.treeCount)
        LogCapture.uninstall()

        // After uninstall, the host's tree is STILL planted. Any teardown that
        // calls Timber.uprootAll() would fail this assertion (host tree gone).
        // This is the runtime mirror of the `grep -c uprootAll` source gate.
        val forestAfter = Timber.forest()
        assertTrue(
            "host tree must survive LogCapture.uninstall — host-preserving contract",
            forestAfter.contains(hostTree),
        )
    }

    @Test
    fun `uninstall_is_idempotent`() {
        LogCapture.install()
        LogCapture.uninstall()
        LogCapture.uninstall()  // must not throw
        assertFalse(LogCapture.isInstalledForTest())
    }

    @Test
    fun `system_out_println_after_install_pushes_to_log_buffer`() {
        sharedLogBuffer.clear()
        LogCapture.install()
        try {
            println("hello-everframe-line")
            // PrintStream.println flushes via newline; the tap fires synchronously.
            val snap = sharedLogBuffer.snapshot()
            val match = snap.firstOrNull { it.message == "hello-everframe-line" }
            assertNotNull("expected captured System.out line in buffer; got: $snap", match)
            assertEquals("INFO", match!!.level)
        } finally {
            LogCapture.uninstall()
        }
    }

    @Test
    fun `system_err_println_after_install_pushes_with_error_level`() {
        sharedLogBuffer.clear()
        LogCapture.install()
        try {
            System.err.println("err-everframe-line")
            val snap = sharedLogBuffer.snapshot()
            val match = snap.firstOrNull { it.message == "err-everframe-line" }
            assertNotNull("expected captured System.err line in buffer; got: $snap", match)
            assertEquals("ERROR", match!!.level)
        } finally {
            LogCapture.uninstall()
        }
    }

    @Test
    fun `system_out_after_uninstall_does_not_push`() {
        sharedLogBuffer.clear()
        LogCapture.install()
        LogCapture.uninstall()
        sharedLogBuffer.clear() // discard anything emitted during install/teardown noise
        println("after-uninstall-line")
        val snap = sharedLogBuffer.snapshot()
        assertFalse(
            "no System.out line should be captured after uninstall",
            snap.any { it.message == "after-uninstall-line" },
        )
    }

    @Test
    fun `timber_plant_after_install_routes_to_log_buffer`() {
        sharedLogBuffer.clear()
        LogCapture.install()
        try {
            Timber.tag("UnitTest").i("timber-everframe-msg")
            val snap = sharedLogBuffer.snapshot()
            val match = snap.firstOrNull { it.message == "timber-everframe-msg" }
            assertNotNull("expected Timber-routed line in buffer; got: $snap", match)
            assertEquals("UnitTest", match!!.tag)
            assertEquals("INFO", match.level)
        } finally {
            LogCapture.uninstall()
        }
    }

    @Test
    fun `uninstall overlapping a paused install restores streams and excludes fresh probes`() {
        val originalOut = System.out
        val originalErr = System.err
        val failure = AtomicReference<Throwable?>()
        // Timber 5.0.1 plants under this monitor. Holding the real dependency's
        // lock pauses install AFTER it claims ownership but BEFORE stream swaps.
        val forestLock = Timber::class.java.getDeclaredField("trees").apply { isAccessible = true }.get(null)!!
        var installer: Thread? = null
        var uninstaller: Thread? = null
        fun awaitState(worker: Thread, allowed: Set<Thread.State>) {
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
            while (worker.state !in allowed && System.nanoTime() < deadline) Thread.yield()
            assertTrue("worker did not reach interleaving: ${worker.state}", worker.state in allowed)
        }
        try {
            synchronized(forestLock) {
                installer = thread(name = "log-install") {
                    try { LogCapture.install() } catch (t: Throwable) { failure.set(t) }
                }
                awaitState(installer!!, setOf(Thread.State.BLOCKED))
                uninstaller = thread(name = "log-uninstall") {
                    try { LogCapture.uninstall() } catch (t: Throwable) { failure.set(t) }
                }
                // Before the fix uninstall finishes here; with serialization it
                // waits for install. Release Timber in either case, without sleeps.
                awaitState(uninstaller!!, setOf(Thread.State.BLOCKED, Thread.State.TERMINATED))
            }
            installer!!.join(5_000)
            uninstaller!!.join(5_000)
            assertFalse(installer!!.isAlive || uninstaller!!.isAlive)
            failure.get()?.let { throw AssertionError("log worker failed", it) }
            assertFalse(LogCapture.isInstalledForTest())
            val probe = "overlapping-uninstall-${UUID.randomUUID()}"
            println(probe)
            assertFalse("paused install must not leave an orphan tee after uninstall",
                sharedLogBuffer.snapshot().any { it.message.contains(probe) })
            assertSame(originalOut, System.out)
            assertSame(originalErr, System.err)
        } finally {
            installer?.join(5_000)
            uninstaller?.join(5_000)
            LogCapture.uninstall()
            // Also contain the RED implementation's orphan tee between tests.
            System.setOut(originalOut)
            System.setErr(originalErr)
        }
    }

    @Test
    fun `retained tee and Timber tree stop capturing after uninstall and stay inactive on restart`() {
        LogCapture.install()
        val oldOut = System.out
        LogCapture.uninstall()
        val stopped = "stopped-producer-${UUID.randomUUID()}"
        oldOut.println(stopped)
        Timber.i(stopped)
        assertFalse("retained producers must stop after uninstall",
            sharedLogBuffer.snapshot().any { it.message.contains(stopped) })

        LogCapture.install()
        val restarted = "restart-producer-${UUID.randomUUID()}"
        oldOut.println(restarted)
        Timber.i(restarted)
        assertEquals("only the current Timber tree captures the restarted probe", 1,
            sharedLogBuffer.snapshot().count { it.message.contains(restarted) })
    }

    @Test
    fun `timber_detector_reports_classpath_present_in_test`() {
        // Sanity check — testImplementation pulls Timber in, so detection MUST be true.
        assertTrue(TimberDetector.timberOnClasspath())
    }
}
