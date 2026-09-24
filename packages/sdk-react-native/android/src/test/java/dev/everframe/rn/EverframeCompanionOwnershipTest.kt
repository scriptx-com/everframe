@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review (naming-native branch), finding NN1 — the companion client
// used to have TWO independent owners: `Everframe` (this SDK's core facade,
// `:everframe-core`) and this module's own `companionClient` field. A hybrid
// host embedding both a plain-native companion integration AND this RN
// bridge in the same process could therefore construct and START two live
// `RelayWSClient`s racing over the same process-global `Companion` StateFlow
// object, and this module's `stopCompanion()` cleared its OWN provider seams
// (`CompanionCaptureBridge.__*Provider`, `CompanionBadge.__activityProvider`)
// unconditionally — even when the client actually live belonged to the
// native facade, not to this module.
//
// `Everframe.__registerCompanionClient` / `__unregisterCompanionClient` are
// the fix: a single `@Synchronized` slot on the core facade that BOTH sides
// route through — first caller wins. This file proves the RN-bridge half of
// that contract, from THIS module (the only place that can construct a
// `EverframeModule`). The pure bookkeeping semantics of the two seams
// themselves, plus `Everframe`'s own `startCompanionInternal`'s use of them,
// are covered from the OTHER side, in `:everframe-core`'s own
// `EverframeCompanionOwnershipTest.kt` — that module cannot reach
// `EverframeModule` (dependency runs the other way), so the two halves cannot
// live in one file.
//
// No real network anywhere here: the "native facade already started"
// scenario is simulated by registering a plain, never-`start()`-ed
// `RelayWSClient` directly through the public slot, and this module's own
// `startCompanion()` never reaches `client.start()` when its registration
// attempt loses.
package dev.everframe.rn

import android.content.res.AssetManager
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.NativeArray
import com.facebook.react.bridge.NativeArrayInterface
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.NativeModuleRegistry
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.RuntimeExecutor
import com.facebook.react.bridge.RuntimeScheduler
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.queue.MessageQueueThread
import com.facebook.react.bridge.queue.ReactQueueConfiguration
import com.facebook.react.internal.turbomodule.core.interfaces.TurboModuleRegistry
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder
import com.facebook.react.turbomodule.core.interfaces.NativeMethodCallInvokerHolder
import dev.everframe.Everframe
import dev.everframe.companion.CompanionBadge
import dev.everframe.companion.RelayWSClient
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
class EverframeCompanionOwnershipTest {

    private lateinit var reactContext: ReactApplicationContext
    private lateinit var module: EverframeModule

    /** The stand-in for a native host's own `Everframe.startCompanion()` client —
     *  never `.start()`-ed, since these tests only need it to occupy the slot. */
    private var nativeFacadeClient: RelayWSClient? = null

    @Before
    fun setUp() {
        // Same setup as RnReplayBridgeTest.kt — see that file's own doc
        // comment for why `BridgeReactContext` (RN's concrete legacy-bridge
        // subclass) is required instead of the now-abstract
        // `ReactApplicationContext`.
        //
        // `startCompanion()` (unlike every other method RnReplayBridgeTest
        // drives) unconditionally calls `getJSModule(RCTDeviceEventEmitter)`
        // to install its StateFlow -> device-event collectors — real RN would
        // have a live catalyst instance backing this by the time JS ever
        // calls startCompanion(); a bare `BridgeReactContext` under
        // Robolectric does not. `initializeWithInstance` wires a minimal fake
        // `CatalystInstance` whose only real method is `getJSModule`, so that
        // call resolves to a no-op emitter instead of throwing
        // "Tried to access a JS module before the React instance was fully
        // set up." — every OTHER `CatalystInstance` member is unused by the
        // code paths these tests exercise.
        //
        // `BridgeReactContext.getJSModule` ALSO routes every call through
        // `InteropModuleRegistry.getInteropModule`, which consults
        // `ReactNativeFeatureFlags.enableFabricRenderer()` — the DEFAULT
        // (Cxx-backed) accessor for that flag loads a native JNI library
        // that plain JVM/Robolectric unit tests never have on their library
        // path, throwing `UnsatisfiedLinkError` before `getJSModule` ever
        // reaches our fake `CatalystInstance`. `ReactNativeFeatureFlagsForTests
        // .setUp()` is RN's own supplied swap to a pure-JVM accessor for
        // exactly this situation — without it, EVERY test in this class
        // would silently no-op (the whole `startCompanion()` body throws and
        // is swallowed by `txGuardVoid` before reaching any of the
        // ownership logic under test), passing vacuously rather than for
        // the right reason.
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        val bridgeReactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        bridgeReactContext.initializeWithInstance(FakeCatalystInstance())
        reactContext = bridgeReactContext
        module = EverframeModule(reactContext)
        ShadowLog.clear()
    }

    @After
    fun tearDown() {
        module.stopCompanion()
        CompanionBadge.__activityProvider = null
        // Release whatever this test registered to stand in for the native
        // facade — `__unregisterCompanionClient`'s identity check makes this
        // safe even if the field is null or already released.
        nativeFacadeClient?.let { Everframe.__unregisterCompanionClient(it) }
        nativeFacadeClient = null
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlags.dangerouslyReset()
    }

    @Test
    fun receivedReportOwnsRnStashBeforeStopAndRestart() = kotlinx.coroutines.runBlocking {
        val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        reactContext.onHostResume(activity)
        Everframe.start(activity, dev.everframe.config.EverframeConfig(appId = "original", sdkKey = "txx_live_test1234567890"))
        val capture = Everframe.__replayFreeze()
        val session = Everframe.captureSessionSnapshot()
        EverframeModule::class.java.getDeclaredMethod("installCompanionBridgeProviders").apply { isAccessible = true }.invoke(module)
        val client = RelayWSClient(client = OkHttpClient())
        assertTrue(Everframe.__registerCompanionClient(client))
        EverframeModule::class.java.getDeclaredField("companionClient").apply { isAccessible = true }.set(module, client)
        val bitmap = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888)
        val bytes = java.io.ByteArrayOutputStream().also { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        val screenshot = dev.everframe.capture.ScreenshotCapture.CaptureResult(bitmap, 2, 2, bytes)
        val stashType = EverframeModule::class.java.declaredClasses.single { it.simpleName == "CompanionCapture" }
        val stash = stashType.declaredConstructors.single().apply { isAccessible = true }
            .newInstance(screenshot, capture, "original-extra", null)
        @Suppress("UNCHECKED_CAST")
        val stashes = EverframeModule::class.java.getDeclaredField("companionCaptureStash").apply { isAccessible = true }.get(module) as MutableMap<String, Any>
        stashes["original"] = stash
        val submit = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString(
            dev.everframe.protocol.generated.ReportSubmit.serializer(),
            """{"annotations":[],"correlation_id":"original","title":"original title","description":{"text":"original text","redactions":[]},"includes":{"logs":false,"metadata":false,"network":false,"screenshot":true,"uiTree":false}}""")
        val prepared = dev.everframe.companion.CompanionCaptureBridge.__submitProvider!!(submit, bytes, emptyList(), "original-attribution", capture, session)
        assertTrue("RN must transfer the stash synchronously", stashes.isEmpty())
        module.stopCompanion()
        capture.cancel()
        Everframe.start(activity, dev.everframe.config.EverframeConfig(appId = "replacement", sdkKey = "txx_live_replacement123456"))
        val server = okhttp3.mockwebserver.MockWebServer().apply { start(); enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(200)) }
        dev.everframe.companion.CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, outbox ->
            dev.everframe.transport.ReportSubmitter(cfg, outbox, dev.everframe.transport.MultipartUploader(OkHttpClient()), server.url("/").toString())
        }
        try {
            val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { prepared() }
            assertTrue("$result", result is dev.everframe.companion.CompanionCaptureBridge.SubmitResult.Ok)
            val request = server.takeRequest(3, java.util.concurrent.TimeUnit.SECONDS)!!
            val body = request.body.readUtf8()
            assertTrue(body.contains("original title"))
            assertTrue(body.contains("name=\"screenshot\""))
            assertFalse(body.contains("video/mp4"))
            assertFalse(body.contains("everframe-video-v1"))
            org.junit.Assert.assertEquals("Bearer txx_live_test1234567890", request.getHeader("Authorization"))
            org.junit.Assert.assertEquals("original-attribution", request.getHeader("X-TX-Companion-Attribution"))
        } finally {
            dev.everframe.companion.CompanionSubmissionComposer.__submitterFactoryForTesting = null
            capture.cancel(); Everframe.kill(); server.shutdown()
        }
    }

    /** Claims the shared slot exactly like a native host's own
     *  `Everframe.startCompanion()` would have, without any real socket I/O. */
    private fun registerNativeFacadeClient(): RelayWSClient {
        val client = RelayWSClient(client = OkHttpClient())
        assertTrue("test setup: the stand-in native client must win the slot", Everframe.__registerCompanionClient(client))
        nativeFacadeClient = client
        return client
    }

    @Test
    fun startCompanion_whenNativeFacadeAlreadyRegistered_discardsItsOwnClientAndWarns() {
        registerNativeFacadeClient()

        module.startCompanion()

        assertFalse(
            "RN must not believe it owns a client when its registration attempt lost the race",
            module.hasCompanionClientForTesting(),
        )
        val warned = ShadowLog.getLogs().any { item ->
            item.tag == "Everframe.rn" &&
                item.msg?.contains("companion already started by the native facade") == true
        }
        assertTrue("a warning must be logged when RN's start is discarded", warned)
    }

    @Test
    fun startCompanion_whenNativeFacadeAlreadyRegistered_neverInstallsBridgeProviders() {
        registerNativeFacadeClient()

        module.startCompanion()

        assertFalse(
            "a discarded RN start must never install capture/submit providers " +
                "against a socket it does not own",
            module.hasCompanionProvidersInstalledForTesting(),
        )
    }

    @Test
    fun stopCompanion_afterNativeFacadeStart_doesNotTouchTheNativeFacadesClientOrProviders() {
        val native = registerNativeFacadeClient()
        val nativeProvider: () -> android.app.Activity? = { null }
        CompanionBadge.__activityProvider = nativeProvider

        // RN's own `startCompanion()` was never even called in this test —
        // mirrors the ordinary "RN screen mounts, but a native host already
        // owns companion" shape. `companionClient` is null, so this must be
        // a complete no-op.
        module.stopCompanion()

        assertSame(
            "RN's stopCompanion must never clear a provider it did not install",
            nativeProvider,
            CompanionBadge.__activityProvider,
        )
        assertFalse(
            "the native facade's client must still hold the slot",
            Everframe.__registerCompanionClient(RelayWSClient(client = OkHttpClient())),
        )
        // Prove it's still specifically `native` holding the slot (not some
        // OTHER client) by releasing it and confirming the slot goes empty.
        Everframe.__unregisterCompanionClient(native)
        val replacement = RelayWSClient(client = OkHttpClient())
        assertTrue(
            "releasing the native facade's own client must now succeed",
            Everframe.__registerCompanionClient(replacement),
        )
        Everframe.__unregisterCompanionClient(replacement)
    }
}

/**
 * Minimal `CatalystInstance` stand-in — see [EverframeCompanionOwnershipTest.setUp]'s
 * doc comment for why this exists. Only [getJSModule] does real work (it
 * always hands back the no-op [FakeRCTDeviceEventEmitter], regardless of
 * which `JavaScriptModule` class is requested — the only one these tests
 * ever ask for is `RCTDeviceEventEmitter`); every other member is dead code
 * for these tests' purposes and just satisfies the interface.
 */
private class FakeCatalystInstance : CatalystInstance {
    private val emitter = FakeRCTDeviceEventEmitter()

    override fun runJSBundle() = Unit
    override fun hasRunJSBundle(): Boolean = true
    override val sourceURL: String? = null
    override fun invokeCallback(callbackID: Int, arguments: NativeArrayInterface) = Unit
    override fun callFunction(module: String, method: String, arguments: NativeArray?) = Unit
    override fun destroy() = Unit
    override val isDestroyed: Boolean = false
    override fun initialize() = Unit
    // `BridgeReactContext.initializeWithInstance` reads this EAGERLY (to
    // stand up its message-queue threads), so — unlike every other member
    // here — this one must be a real, working configuration, not a stub.
    // `ReactQueueConfigurationImpl` (the production factory) is `internal`
    // to RN's own compiled module and unreachable from here, so this is a
    // minimal hand-rolled one instead: every queue just runs its work
    // synchronously on the calling thread, which is fine since nothing in
    // these tests ever posts work through them.
    override val reactQueueConfiguration: ReactQueueConfiguration = FakeReactQueueConfiguration()

    @Suppress("UNCHECKED_CAST")
    override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T = emitter as T
    override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean = false
    override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T? = null
    override fun getNativeModule(name: String): NativeModule? = null
    override val nativeModules: Collection<NativeModule> = emptyList()
    override fun extendNativeModules(modules: NativeModuleRegistry) = Unit
    override fun registerSegment(segmentId: Int, path: String) = Unit
    override fun setGlobalVariable(propName: String, jsonValue: String) = Unit
    override val javaScriptContextHolder: JavaScriptContextHolder
        get() = throw UnsupportedOperationException("not needed by these tests")
    override val runtimeExecutor: RuntimeExecutor? = null
    override val runtimeScheduler: RuntimeScheduler? = null
    override val jsCallInvokerHolder: CallInvokerHolder
        get() = throw UnsupportedOperationException("not needed by these tests")
    override val nativeMethodCallInvokerHolder: NativeMethodCallInvokerHolder
        get() = throw UnsupportedOperationException("not needed by these tests")
    override fun setTurboModuleRegistry(turboModuleRegistry: TurboModuleRegistry) = Unit
    override fun setFabricUIManager(fabricUIManager: UIManager) = Unit
    override fun getFabricUIManager(): UIManager? = null
    override fun handleMemoryPressure(level: Int) = Unit
    override fun loadScriptFromAssets(assetManager: AssetManager, assetURL: String, loadSynchronously: Boolean) = Unit
    override fun loadScriptFromFile(fileName: String, sourceURL: String, loadSynchronously: Boolean) = Unit
    override fun loadSplitBundleFromFile(fileName: String, sourceURL: String) = Unit
    override fun setSourceURLs(deviceURL: String, remoteURL: String) = Unit
}

/** Runs everything synchronously on the calling thread — see
 *  [FakeCatalystInstance.reactQueueConfiguration]'s doc comment. */
private class FakeMessageQueueThread : MessageQueueThread {
    override fun runOnQueue(runnable: Runnable): Boolean {
        runnable.run()
        return true
    }

    override fun <T> callOnQueue(callable: java.util.concurrent.Callable<T>): java.util.concurrent.Future<T> {
        val result = callable.call()
        return java.util.concurrent.CompletableFuture.completedFuture(result)
    }

    override fun isOnThread(): Boolean = true
    override fun assertIsOnThread() = Unit
    override fun assertIsOnThread(message: String) = Unit
    override fun quitSynchronous() = Unit
    override fun isIdle(): Boolean = true
}

private class FakeReactQueueConfiguration : ReactQueueConfiguration {
    private val thread = FakeMessageQueueThread()
    override fun getUIQueueThread(): MessageQueueThread = thread
    override fun getNativeModulesQueueThread(): MessageQueueThread = thread
    override fun getJSQueueThread(): MessageQueueThread = thread
    override fun destroy() = Unit
}

/** No-op emitter — these tests only need `getJSModule` to resolve to SOMETHING;
 *  nobody asserts on what gets emitted here (that would need a real bridge —
 *  see the file header's cross-reference to the excluded, stale
 *  `EverframeCompanionModuleTest.kt` for why that's out of scope). */
private class FakeRCTDeviceEventEmitter : DeviceEventManagerModule.RCTDeviceEventEmitter {
    override fun emit(eventName: String, data: Any?) = Unit
}
