// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.rn

import android.view.View
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.uimanager.ThemedReactContext
import com.traceitx.TraceItX
import com.traceitx.capture.video.VideoPrivacyAdapter.Classification
import org.junit.Assert.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class RnVideoPrivacyAdapterTest {
    // RN ships a JVM-local accessor for its own tests; avoid loading device-only JNI here.
    @org.junit.Before fun installLocalFeatureFlags() {
        val local = Class.forName("com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsLocalAccessor")
            .getDeclaredConstructor().apply { isAccessible = true }.newInstance()
        Class.forName("com.facebook.react.internal.featureflags.ReactNativeFeatureFlags")
            .getDeclaredField("accessor").apply { isAccessible = true }.set(null, local)
    }

    // Model process restart after each test; no production reset API exists.
    @org.junit.After fun releaseLatchedProcessForTest() {
        runCatching {
            val field = Class.forName("com.traceitx.rn.RnVideoPrivacyUncertainty")
                .getDeclaredField("retained").apply { isAccessible = true }
            (field.get(null) as? AutoCloseable)?.close()
            field.set(null, null)
        }
    }
    @Test fun installedSessionRecoversAfterConstructorAndFinalRnRegistrationWithoutAnotherFetch() = kotlinx.coroutines.runBlocking {
        val app = RuntimeEnvironment.getApplication()
        com.traceitx.shared.SharedData.init(app)
        val captureGate = TraceItX::class.java.getDeclaredField("captureGate").apply { isAccessible = true }
        val previousGate = TraceItX.captureGate
        captureGate.setBoolean(null, true)
        var fetches = 0
        val provider = com.traceitx.config.ReplayConfigProvider.make("https://rn-settlement.test", "key",
            com.traceitx.config.ConfigFetcher { request ->
                fetches++
                okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("ok")
                    .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":5}}""".toResponseBody()).build()
            })
        val session = com.traceitx.capture.replay.ReplaySession(apiKey = "key", provider = provider)
        val queue = ArrayDeque<() -> Unit>()
        val view = View(app)
        val registry = RnSensitiveRegistration({ view }) { queue.add(it) }
        // The bridge module cannot access core-internal diagnostics or coroutine jobs at Kotlin source level.
        val diagnostics = session.javaClass.declaredMethods.single { it.name.startsWith("nativeVideoDiagnostics") }
        fun authorized(): Boolean {
            val value = diagnostics.invoke(session) as kotlinx.serialization.json.JsonObject
            return value["authorized"].toString() == "1"
        }
        try {
            session.enableIfConfigured()
            val job = session.javaClass.getDeclaredField("initialRefreshJob").apply { isAccessible = true }.get(session) as kotlinx.coroutines.Job
            kotlinx.coroutines.withTimeout(3_000) { job.join() }
            assertTrue(authorized())
            val host = TraceItXSensitiveViewManager().createViewInstance(ThemedReactContext(BridgeReactContext(app), app))
            assertEquals(true, host.getTag(com.traceitx.R.id.tx_sensitive))
            assertTrue("constructor completion reauthorizes the installed session", authorized())
            registry.register(1.0); registry.register(2.0)
            assertFalse(authorized())
            queue.removeFirst().invoke(); assertFalse(authorized())
            queue.removeFirst().invoke()
            assertEquals(true, view.getTag(com.traceitx.R.id.tx_sensitive))
            assertTrue(authorized()); assertEquals(1, fetches)
            registry.register(Double.NaN)
            TraceItX.__beginSensitiveRegistration().close()
            assertFalse("unrelated settlement cannot clear retained RN uncertainty", authorized())
        } finally { session.teardown(); registry.close(); captureGate.setBoolean(null, previousGate) }
    }

    @Test fun overlappingInstancesCannotClearOldUnresolvedContentOnTeardown() {
        val app = RuntimeEnvironment.getApplication()
        val old = TraceItXModule(BridgeReactContext(app))
        val replacement = TraceItXModule(BridgeReactContext(app))
        old.registerSensitiveRect(Double.NaN, com.facebook.react.bridge.JavaOnlyMap())
        old.invalidate()
        assertFalse("replacement adapter must not reauthorize old pixels", TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        replacement.invalidate()
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
    }
    @Test fun invalidTagCannotBeClearedByLaterSuccessOrModuleTeardown() {
        val queue = ArrayDeque<() -> Unit>()
        val view = View(RuntimeEnvironment.getApplication())
        val registry = RnSensitiveRegistration({ view }) { queue.add(it) }
        registry.register(Double.NaN); registry.register(5.0); queue.removeFirst()()
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        registry.close(); registry.close()
        val module = TraceItXModule(BridgeReactContext(RuntimeEnvironment.getApplication()))
        module.registerSensitiveRect(-1.0, com.facebook.react.bridge.JavaOnlyMap())
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        module.invalidate()
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
    }
    @Test fun dispatchExceptionSurvivesTeardown() {
        val registry = RnSensitiveRegistration({ null }) { throw IllegalStateException() }
        registry.register(8.0)
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        registry.close()
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
    }
    @Test fun mountTimeNativeIdExcludesButCallerNativeIdNeverAuthorizes() {
        val view = View(RuntimeEnvironment.getApplication())
        assertEquals(Classification.ORDINARY_VIEW, RnVideoPrivacyAdapter.classify(view))
        view.setTag(com.facebook.react.R.id.view_tag_native_id, "traceitx-sensitive")
        assertEquals(Classification.EXCLUDE, RnVideoPrivacyAdapter.classify(view))
    }
    @Test fun unresolvedFabricTagAndRegistryExceptionSurviveUnprovenTeardown() {
        for (resolve in listOf<(Int) -> View?>({ null }, { throw IllegalStateException() })) {
            val queue = ArrayDeque<() -> Unit>()
            val registry = RnSensitiveRegistration(resolve) { queue.add(it) }
            val before = TraceItX.__videoPrivacyGeneration()
            registry.register(17.0)
            assertFalse(TraceItX.__isVideoPrivacyGenerationValid(before))
            queue.removeFirst()()
            assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
            registry.close()
            assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        }
    }
    @Test fun concurrentRegistrationsTagBeforeUnblockingAndTeardownIgnoresQueuedWork() {
        val view = View(RuntimeEnvironment.getApplication())
        val queue = ArrayDeque<() -> Unit>()
        val registry = RnSensitiveRegistration({ view }) { queue.add(it) }
        registry.register(1.0); registry.register(2.0)
        queue.removeFirst()()
        assertFalse(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        queue.removeFirst()()
        assertEquals(true, view.getTag(com.traceitx.R.id.tx_sensitive))
        assertTrue(TraceItX.__isVideoPrivacyGenerationValid(TraceItX.__videoPrivacyGeneration()))
        view.setTag(com.traceitx.R.id.tx_sensitive, null)
        registry.register(3.0); registry.close(); queue.removeFirst()()
        assertNull(view.getTag(com.traceitx.R.id.tx_sensitive))
    }
    @Test fun dedicatedHostIsSensitiveAtConstructionBeforeAnyLayoutAndPreservesNativeId() {
        val app = RuntimeEnvironment.getApplication()
        val context = ThemedReactContext(BridgeReactContext(app), app)
        val manager = TraceItXSensitiveViewManager()
        val view = manager.createViewInstance(context)
        manager.setNativeId(view, "caller")
        assertEquals("caller", view.getTag(com.facebook.react.R.id.view_tag_native_id))
        assertEquals(true, view.getTag(com.traceitx.R.id.tx_sensitive))
        val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        activity.setContentView(view)
        var firstPreDraw = false
        view.viewTreeObserver.addOnPreDrawListener {
            firstPreDraw = true
            assertTrue(com.traceitx.capture.SensitiveRectRegistry.isSensitive(view))
            true
        }
        view.viewTreeObserver.dispatchOnPreDraw()
        assertTrue("native marker precedes any JS onLayout", firstPreDraw)
        activity.finish()
    }
}
