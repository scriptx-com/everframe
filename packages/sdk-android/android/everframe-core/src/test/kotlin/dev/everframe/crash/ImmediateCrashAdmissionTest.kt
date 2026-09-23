// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.CrashSidecar
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class ImmediateCrashAdmissionTest {
    @Test
    fun `start admits immediate handled capture before detached initialization`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val storage = createTempDirectory("everframe-immediate-capture").toFile()
        val keys = JceTestOutboxKeyProvider()
        var accepted = false

        CrashReporter.__resetForTesting()
        CrashReporter.sidecarFactory = {
            CrashSidecar(File(storage, "crash-outbox.jsonl"), keys, JvmOutboxFileOps())
        }
        Everframe.__beforeDrainLaunchForTesting = {
            accepted = CrashReporter.captureHandledFactsWithDetails(
                "ImmediateError",
                "captured as soon as start publishes",
                listOf("at immediate (index.android.bundle:1:1)"),
                "2026-09-15T00:00:00Z",
                null,
                null,
            )
            // Keep detached initialization causally out of this test. The
            // captured value above is the synchronous startup contract under
            // test; kill invalidates the captured launch before dispatch.
            Everframe.kill()
        }

        try {
            Everframe.start(
                context,
                EverframeConfig(
                    appId = "immediate-capture",
                    sdkKey = "txx_live_immediate_capture_test",
                    capture = CaptureConfig(logs = false),
                ),
            )
            assertTrue("start must admit an immediate handled capture", accepted)
        } finally {
            Everframe.__resetStartTailDelayHookForTesting()
            Everframe.kill()
            CrashReporter.__resetForTesting()
            storage.deleteRecursively()
        }
    }
}
