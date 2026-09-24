// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.rn

import android.view.View
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.uimanager.ThemedReactContext
import dev.everframe.Everframe
import dev.everframe.capture.video.VideoPrivacyAdapter.Classification
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
            val field = Class.forName("dev.everframe.rn.RnVideoPrivacyUncertainty")
                .getDeclaredField("retained").apply { isAccessible = true }
            (field.get(null) as? AutoCloseable)?.close()
            field.set(null, null)
        }
    }
    @Test fun installedSessionRecoversAfterConstructorAndFinalRnRegistrationWithoutAnotherFetch() = kotlinx.coroutines.runBlocking {
        val app = RuntimeEnvironment.getApplication()
        dev.everframe.shared.SharedData.init(app)
        val captureGate = Everframe::class.java.getDeclaredField("captureGate").apply { isAccessible = true }
        val previousGate = Everframe.captureGate
        captureGate.setBoolean(null, true)
        var fetches = 0
        val provider = dev.everframe.config.ReplayConfigProvider.make("https://rn-settlement.test", "key",
            dev.everframe.config.ConfigFetcher { request ->
                fetches++
                okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("ok")
                    .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":5}}""".toResponseBody()).build()
            })
        val session = dev.everframe.capture.replay.ReplaySession(apiKey = "key", provider = provider)
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
            val host = EverframeSensitiveViewManager().createViewInstance(ThemedReactContext(BridgeReactContext(app), app))
            assertEquals(true, host.getTag(dev.everframe.R.id.tx_sensitive))
            assertTrue("constructor completion reauthorizes the installed session", authorized())
            registry.register(1.0); registry.register(2.0)
            assertFalse(authorized())
            queue.removeFirst().invoke(); assertFalse(authorized())
            queue.removeFirst().invoke()
            assertEquals(true, view.getTag(dev.everframe.R.id.tx_sensitive))
            assertTrue(authorized()); assertEquals(1, fetches)
            registry.register(Double.NaN)
            Everframe.__beginSensitiveRegistration().close()
            assertFalse("unrelated settlement cannot clear retained RN uncertainty", authorized())
        } finally { session.teardown(); registry.close(); captureGate.setBoolean(null, previousGate) }
    }

    @Test fun overlappingInstancesCannotClearOldUnresolvedContentOnTeardown() {
        val app = RuntimeEnvironment.getApplication()
        val old = EverframeModule(BridgeReactContext(app))
        val replacement = EverframeModule(BridgeReactContext(app))
        old.registerSensitiveRect(Double.NaN, com.facebook.react.bridge.JavaOnlyMap())
        old.invalidate()
        assertFalse("replacement adapter must not reauthorize old pixels", Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        replacement.invalidate()
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
    }
    @Test fun invalidTagCannotBeClearedByLaterSuccessOrModuleTeardown() {
        val queue = ArrayDeque<() -> Unit>()
        val view = View(RuntimeEnvironment.getApplication())
        val registry = RnSensitiveRegistration({ view }) { queue.add(it) }
        registry.register(Double.NaN); registry.register(5.0); queue.removeFirst()()
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        registry.close(); registry.close()
        val module = EverframeModule(BridgeReactContext(RuntimeEnvironment.getApplication()))
        module.registerSensitiveRect(-1.0, com.facebook.react.bridge.JavaOnlyMap())
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        module.invalidate()
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
    }
    @Test fun dispatchExceptionSurvivesTeardown() {
        val registry = RnSensitiveRegistration({ null }) { throw IllegalStateException() }
        registry.register(8.0)
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        registry.close()
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
    }
    @Test fun mountTimeNativeIdExcludesButCallerNativeIdNeverAuthorizes() {
        val view = View(RuntimeEnvironment.getApplication())
        assertEquals(Classification.ORDINARY_VIEW, RnVideoPrivacyAdapter.classify(view))
        view.setTag(com.facebook.react.R.id.view_tag_native_id, "everframe-sensitive")
        assertEquals(Classification.EXCLUDE, RnVideoPrivacyAdapter.classify(view))
    }
    @Test fun unresolvedFabricTagAndRegistryExceptionSurviveUnprovenTeardown() {
        for (resolve in listOf<(Int) -> View?>({ null }, { throw IllegalStateException() })) {
            val queue = ArrayDeque<() -> Unit>()
            val registry = RnSensitiveRegistration(resolve) { queue.add(it) }
            val before = Everframe.__videoPrivacyGeneration()
            registry.register(17.0)
            assertFalse(Everframe.__isVideoPrivacyGenerationValid(before))
            queue.removeFirst()()
            assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
            registry.close()
            assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        }
    }
    @Test fun concurrentRegistrationsTagBeforeUnblockingAndTeardownIgnoresQueuedWork() {
        val view = View(RuntimeEnvironment.getApplication())
        val queue = ArrayDeque<() -> Unit>()
        val registry = RnSensitiveRegistration({ view }) { queue.add(it) }
        registry.register(1.0); registry.register(2.0)
        queue.removeFirst()()
        assertFalse(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        queue.removeFirst()()
        assertEquals(true, view.getTag(dev.everframe.R.id.tx_sensitive))
        assertTrue(Everframe.__isVideoPrivacyGenerationValid(Everframe.__videoPrivacyGeneration()))
        view.setTag(dev.everframe.R.id.tx_sensitive, null)
        registry.register(3.0); registry.close(); queue.removeFirst()()
        assertNull(view.getTag(dev.everframe.R.id.tx_sensitive))
    }
    @Test fun dedicatedHostIsSensitiveAtConstructionBeforeAnyLayoutAndPreservesNativeId() {
        val app = RuntimeEnvironment.getApplication()
        val context = ThemedReactContext(BridgeReactContext(app), app)
        val manager = EverframeSensitiveViewManager()
        val view = manager.createViewInstance(context)
        manager.setNativeId(view, "caller")
        assertEquals("caller", view.getTag(com.facebook.react.R.id.view_tag_native_id))
        assertEquals(true, view.getTag(dev.everframe.R.id.tx_sensitive))
        val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        activity.setContentView(view)
        var firstPreDraw = false
        view.viewTreeObserver.addOnPreDrawListener {
            firstPreDraw = true
            assertTrue(dev.everframe.capture.SensitiveRectRegistry.isSensitive(view))
            true
        }
        view.viewTreeObserver.dispatchOnPreDraw()
        assertTrue("native marker precedes any JS onLayout", firstPreDraw)
        activity.finish()
    }
}
