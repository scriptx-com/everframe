// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** Replacement-start boundaries racing a newer start, through the process runtime. */
@RunWith(RobolectricTestRunner::class)
class AndroidNativeCrashRuntimeBoundaryTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private class Platform : AndroidNativeExitPlatform {
        override val apiLevel = 31
        override val pid = 99
        override val processName = "app"
        val registrations = CopyOnWriteArrayList<ByteArray?>()
        override fun history(): List<AndroidNativeExit> = emptyList()
        override fun setStateSummary(value: ByteArray?) { registrations.add(value) }
    }
    private fun engine() = AndroidNativeRecovery(
        OutboxStore(File(folder.root, "contexts"), keys, JvmOutboxFileOps(), 8, 2 * 1024 * 1024),
        OutboxStore(File(folder.root, "prepared"), keys, JvmOutboxFileOps(), 8, 2 * 1024 * 1024))
    private fun template(): OutboxEntry {
        val id = UUID.randomUUID().toString()
        return OutboxEntry(id, 1000, """{"reportId":"$id","reporter":{},"payload":{}}""".toByteArray(), "template", emptyList(), "key", "https://example.test")
    }
    private val startEpoch = AtomicInteger(1)
    private fun gate(epoch: Int) = object : OutboxAuthorization {
        override fun isAllowed() = startEpoch.get() == epoch
    }

    @After fun reset() {
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = null
        AndroidNativeCrashRuntime.__resetForTesting()
    }

    /** Installs [controller] as the runtime's owner, as a kill boundary with journals on disk would. */
    private fun install(controller: AndroidNativeRecoveryController) {
        AndroidNativeCrashRuntime.__resetForTesting()
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = { controller }
        val context = RuntimeEnvironment.getApplication()
        File(context.noBackupFilesDir, "dev.everframe/native-exit-v1").mkdirs()
        AndroidNativeCrashRuntime.boundary(context, 0, erasePersisted = true, isCurrent = { true })
    }

    @Test fun `a delayed older start cannot clear the OS token a newer start armed`() {
        val platform = Platform()
        val controller = AndroidNativeRecoveryController(::engine, platform)
        install(controller)
        assertTrue(AndroidNativeCrashRuntime.request(1, enabled = true, diagnostics = true) >= 0)
        assertTrue(controller.enableDiagnostics(1, gate(1), 3000, ::template) { true })
        assertNotNull(platform.registrations.last())
        assertTrue("the runtime owns the controller", AndroidNativeCrashRuntime.ready(1))

        // Start 2's boundary passes its ownership checks, then stalls right before it clears the
        // token: it waits for the runtime monitor it reads the controller under, which this thread holds.
        startEpoch.set(2)
        val monitor = AndroidNativeCrashRuntime::class.java.getDeclaredField("lock").apply { isAccessible = true }.get(null)!!
        val older = Thread { AndroidNativeCrashRuntime.boundary(null, 2, false, { startEpoch.get() == 2 }) }
        synchronized(monitor) {
            older.start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (older.state != Thread.State.BLOCKED) {
                assertTrue("start 2 reached the token clear", older.isAlive && System.nanoTime() < deadline)
                Thread.sleep(1)
            }
            // Start 3 arms while start 2 is stalled.
            startEpoch.set(3)
            assertTrue(AndroidNativeCrashRuntime.request(3, enabled = true, diagnostics = true) >= 0)
            assertTrue(controller.enableDiagnostics(3, gate(3), 4000, ::template) { true })
            assertNotNull(platform.registrations.last())
        }
        older.join(5000)
        assertFalse(older.isAlive)

        assertTrue("start 3 reports ready", AndroidNativeCrashRuntime.ready(3))
        assertNotNull("so the OS must still hold start 3's token", platform.registrations.last())
    }

    @Test fun `a current replacement start clears the older start's token at once`() {
        val platform = Platform()
        val controller = AndroidNativeRecoveryController(::engine, platform)
        install(controller)
        AndroidNativeCrashRuntime.request(1, enabled = true, diagnostics = true)
        assertTrue(controller.enableDiagnostics(1, gate(1), 3000, ::template) { true })
        startEpoch.set(2)
        AndroidNativeCrashRuntime.boundary(null, 2, false, { startEpoch.get() == 2 })
        assertNull(platform.registrations.last())
        assertFalse(AndroidNativeCrashRuntime.ready(1))
    }
}
