// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.app.Activity
import android.content.Context
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.JavaOnlyMap
import kotlinx.coroutines.CancellationException
import com.facebook.react.bridge.BridgeReactContext
import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineStart
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

class LegacyReporterFixture {
    fun create(context: Context) { Everframe.report.__resolver = { ReportResult.Cancelled("legacy") } }
}
class ThrowingReporterFixture {
    fun create(context: Context) { Everframe.report.__resolver = { ReportResult.Cancelled("unexpected_legacy") } }
    suspend fun openForActivity(context: Context, activity: Activity?): ReportResult {
        throw IllegalStateException("private-host-value")
    }
}
class CurrentReporterFixture {
    fun create(context: Context) { check(Looper.myLooper() == Looper.getMainLooper()) }
    suspend fun openForActivity(context: Context, activity: Activity?): ReportResult {
        check(Looper.myLooper() == Looper.getMainLooper())
        return ReportResult.Cancelled(activity?.title.toString())
    }
}

class SuspendedReporterFixture {
    companion object { var gate = CompletableDeferred<ReportResult>() }
    suspend fun openForActivity(context: Context, activity: Activity?): ReportResult = gate.await()
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
@LooperMode(LooperMode.Mode.PAUSED)
class ReporterBridgeTest {
    @After fun after() { Everframe.report.__resolver = null }
    private fun context(): BridgeReactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
    private fun resumed(title: String = "current"): BridgeReactContext {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.title = title
        return context().apply { onHostResume(activity) }
    }
    @Test fun missingAdditiveMethodUsesLegacy() = runBlocking {
        assertEquals(ReportResult.Cancelled("legacy"), ReporterBridge { LegacyReporterFixture::class.java }.open(resumed()))
    }
    @Test fun presentMethodFailureNeverFallsBack() = runBlocking {
        try {
            ReporterBridge { ThrowingReporterFixture::class.java }.open(resumed())
            fail("must reject")
        } catch (e: IllegalStateException) {
            assertFalse(e.message.orEmpty().contains("private-host-value"))
            assertNull(e.cause)
        }
    }
    @Test fun backgroundHostCancels() = runBlocking {
        assertEquals(ReportResult.Cancelled("no_active_activity"), ReporterBridge { CurrentReporterFixture::class.java }.open(context()))
    }
    @Test fun openUsesLatestResumedHost() = runBlocking {
        val context = resumed("old")
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get().apply { title = "replacement" }
        context.onHostPause(); context.onHostResume(activity)
        assertEquals(ReportResult.Cancelled("replacement"), ReporterBridge { CurrentReporterFixture::class.java }.open(context))
    }
    @Test fun suspendedReflectionCompletesOnce() = runBlocking {
        SuspendedReporterFixture.gate = CompletableDeferred()
        var completions = 0
        var result: ReportResult? = null
        val context = resumed()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            result = ReporterBridge { SuspendedReporterFixture::class.java }.open(context)
            completions++
        }
        assertFalse(job.isCompleted)
        SuspendedReporterFixture.gate.complete(ReportResult.Cancelled("async"))
        job.join()
        assertEquals(ReportResult.Cancelled("async"), result)
        assertEquals(1, completions)
    }
    @Test fun missingDependencyHasActionableSanitizedError() = runBlocking {
        try {
            ReporterBridge { throw ClassNotFoundException("private-path") }.open(resumed())
            fail("must reject missing module")
        } catch (e: IllegalStateException) {
            assertTrue(e.message.orEmpty().contains("dev.everframe:reporter-ui"))
            assertFalse(e.message.orEmpty().contains("private-path"))
        }
    }
    @Test fun configureScheduleDoesNotWaitForMain() {
        val bridge = ReporterBridge { CurrentReporterFixture::class.java }
        val context = context()
        val thread = Thread { bridge.scheduleInstall(context) }
        thread.start(); thread.join(2000)
        assertFalse(thread.isAlive)
        shadowOf(Looper.getMainLooper()).idle()
    }
    @Test fun moduleSanitizesImmediateAndSuspendedCancellationAtPromiseBoundary() {
        assertEquals("http://127.0.0.1:9", dev.everframe.BuildConfig.INGEST_URL)
        val module = EverframeModule(resumed())
        module.configure(JavaOnlyMap().apply { putString("apiKey", "reporter-test-only") })
        for (suspended in listOf(false, true)) {
            val gate = CompletableDeferred<ReportResult>()
            val privateError = CancellationException("private-host-value").apply {
                initCause(IllegalStateException("private-host-cause"))
            }
            var invoked = 0
            Everframe.report.__resolver = {
                invoked++
                if (suspended) gate.await() else throw privateError
            }
            val rejections = mutableListOf<List<Any?>>()
            val promise = java.lang.reflect.Proxy.newProxyInstance(
                Promise::class.java.classLoader, arrayOf(Promise::class.java),
            ) { _, method, arguments ->
                if (method.name == "reject") rejections += arguments!!.toList()
                if (method.name == "resolve") fail("must reject")
                null
            } as Promise
            module.openReporter(promise)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(1, invoked)
            if (suspended) {
                assertTrue(rejections.isEmpty())
                gate.completeExceptionally(privateError)
                shadowOf(Looper.getMainLooper()).idle()
            }
            assertEquals(1, rejections.size)
            assertEquals("must not forward throwable/cause to JS", 2, rejections.single().size)
            assertFalse(rejections.single().toString().contains("private-host"))
        }
        Everframe.kill()
    }

}
