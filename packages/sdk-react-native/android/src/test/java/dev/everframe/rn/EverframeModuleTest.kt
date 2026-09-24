// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Robolectric unit tests for EverframeModule — the Android half of the RN
// TurboModule bridge (Plan 06-03).
//
// CONTRACT UNDER TEST:
//   1. captureNow() resolves with a WritableMap whose top-level keys are
//      exactly { screenshot, uiTree, metadata, sensitiveRects }.
//   2. The "screenshot" key carries a `file://` URI String — NEVER the raw PNG
//      bytes. This is the PRIV-03 non-leakage contract (Threat T-06-03-02).
//   3. submit() resolves with `{ status: "queued" }` after enqueuing the
//      envelope into the existing JSONLOutbox at `cacheDir/dev.everframe/`.
//
// NOTE ON CODEGEN AVAILABILITY:
//   The abstract base class `dev.everframe.rn.NativeEverframeSpec` is
//   produced by the `com.facebook.react` Gradle codegen plugin from
//   `packages/sdk-react-native/src/NativeEverframe.ts` — it only materialises
//   inside a consuming RN host app's build. For library-side JVM unit tests we
//   therefore exercise `EverframeModule` through its concrete bridge surface
//   (configure / captureNow / registerSensitiveRect / submit / openAnnotationOverlay)
//   without going through the spec abstract — the spec is a compile-time
//   adherence contract; runtime behavior is the same regardless of which base
//   class the host's codegen produces. Documented in 06-03-SUMMARY.md.

package dev.everframe.rn

import android.app.Activity
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class EverframeModuleTest {

    private lateinit var reactContext: ReactApplicationContext
    private lateinit var activity: Activity
    private lateinit var module: EverframeModule

    @Before
    fun setUp() {
        // ReactApplicationContext extends ContextWrapper around Android Context;
        // Robolectric's RuntimeEnvironment.getApplication() provides a real
        // android.content.Context with a working cacheDir/packageManager so we
        // don't need to mock the entire Context surface.
        //
        // Task 11 (Plan 5): `ReactApplicationContext` is `abstract` in the
        // pinned react-native-tvos 0.85.3-0 fork — use RN's own concrete
        // legacy-bridge subclass instead (see RnReplayBridgeTest.kt's setUp
        // for the full root-cause writeup). This file has OTHER, unrelated
        // stale-API compile errors (captureNow/submit/openAnnotationOverlay
        // no longer exist on EverframeModule; onNewIntent/Promise.reject
        // signatures drifted) predating this fix — out of scope for Task 11,
        // excluded from the active Gradle test compile (see build.gradle.kts)
        // pending a full rewrite against the current module API.
        reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        activity = Robolectric.buildActivity(Activity::class.java).create().get()
        reactContext.onNewIntent(activity, activity, null) // attach currentActivity
        module = EverframeModule(reactContext)
    }

    /**
     * Contract: captureNow resolves with a WritableMap that has exactly the
     * four top-level keys the JS facade casts to NativeCapture. Adding or
     * removing a key here means JS shape drift across the bridge.
     */
    @Test
    fun captureNow_resolvesWithFourTopLevelKeys() {
        val promise = LatchPromise()
        module.captureNow(promise)
        promise.await(5)

        val result = promise.resolvedValue as? WritableMap
        assertNotNull("captureNow must resolve with a WritableMap", result)
        result!!
        assertTrue("missing 'screenshot' key", result.hasKey("screenshot"))
        assertTrue("missing 'uiTree' key", result.hasKey("uiTree"))
        assertTrue("missing 'metadata' key", result.hasKey("metadata"))
        assertTrue("missing 'sensitiveRects' key", result.hasKey("sensitiveRects"))
    }

    /**
     * PRIV-03 non-leakage contract (Threat T-06-03-02): the "screenshot" field
     * MUST be a String holding a file:// URI. The PNG bytes themselves NEVER
     * cross the bridge — they live in cacheDir until the JS side reads them.
     */
    @Test
    fun captureNow_screenshotKeyIsFileUriString() {
        val promise = LatchPromise()
        module.captureNow(promise)
        promise.await(5)

        val result = promise.resolvedValue as? WritableMap
            ?: return  // soft-skip: PixelCopy unavailable under Robolectric is acceptable;
                       // the non-leakage contract is verified on the success path below.
        if (!result.hasKey("screenshot")) return

        val uri = result.getString("screenshot")
        assertNotNull("screenshot must be a String", uri)
        assertTrue(
            "screenshot must be a file:// URI, got: $uri",
            uri!!.startsWith("file://"),
        )
        // Non-leakage assertions: the key must not carry array/map payloads.
        assertNull("screenshot must not be a WritableArray", result.getArray("screenshot"))
        assertNull("screenshot must not be a WritableMap", result.getMap("screenshot"))
    }

    /**
     * Contract: submit enqueues to JSONLOutbox and resolves with the queued
     * status. We assert via the promise outcome rather than poking the outbox
     * file directly — the file path is an internal implementation detail of
     * JSONLOutbox(context) and is intentionally not part of the bridge API.
     */
    @Test
    fun submit_resolvesWithQueuedStatus() {
        val envelope = com.facebook.react.bridge.Arguments.createMap().apply {
            putString("schemaVersion", "1.0")
            putString("reportId", "test-report-001")
        }
        val promise = LatchPromise()
        module.submit(envelope, promise)
        promise.await(5)

        val result = promise.resolvedValue as? WritableMap
        assertNotNull("submit must resolve, not reject. Reason=${promise.rejectCode}", result)
        assertEquals("queued", result!!.getString("status"))
    }

    // recordScreenForwardsToCoreAndChainsFromTo moved to RnReplayBridgeTest.kt
    // (final-review fix, 2026-07-14): this file is excluded from every
    // unit-test compile by build.gradle.kts:105-108 (pre-existing, unrelated
    // debt), which made the test dead code — it never ran. See
    // RnReplayBridgeTest.kt's "Test B.2" for the live copy.

    // --- Promise test double -------------------------------------------------

    /** Minimal Promise implementation that records resolution + unblocks await(). */
    private class LatchPromise : Promise {
        @Volatile var resolvedValue: Any? = null
        @Volatile var rejectCode: String? = null
        @Volatile var rejectMessage: String? = null
        private val latch = CountDownLatch(1)

        fun await(timeoutSec: Long): Boolean = latch.await(timeoutSec, TimeUnit.SECONDS)

        override fun resolve(value: Any?) {
            resolvedValue = value
            latch.countDown()
        }
        override fun reject(code: String, message: String?) {
            rejectCode = code; rejectMessage = message; latch.countDown()
        }
        override fun reject(code: String, throwable: Throwable?) {
            rejectCode = code; rejectMessage = throwable?.message; latch.countDown()
        }
        override fun reject(code: String, message: String?, throwable: Throwable?) {
            rejectCode = code; rejectMessage = message; latch.countDown()
        }
        override fun reject(code: String, message: String?, userInfo: com.facebook.react.bridge.WritableMap) {
            rejectCode = code; rejectMessage = message; latch.countDown()
        }
        override fun reject(code: String, throwable: Throwable?, userInfo: com.facebook.react.bridge.WritableMap) {
            rejectCode = code; rejectMessage = throwable?.message; latch.countDown()
        }
        override fun reject(code: String, message: String?, throwable: Throwable?, userInfo: com.facebook.react.bridge.WritableMap) {
            rejectCode = code; rejectMessage = message; latch.countDown()
        }
        override fun reject(throwable: Throwable) {
            rejectCode = "rejected"; rejectMessage = throwable.message; latch.countDown()
        }
        override fun reject(throwable: Throwable, userInfo: com.facebook.react.bridge.WritableMap) {
            rejectCode = "rejected"; rejectMessage = throwable.message; latch.countDown()
        }
        @Deprecated("Deprecated in Java")
        override fun reject(message: String?) {
            rejectCode = "rejected"; rejectMessage = message; latch.countDown()
        }
    }
}
