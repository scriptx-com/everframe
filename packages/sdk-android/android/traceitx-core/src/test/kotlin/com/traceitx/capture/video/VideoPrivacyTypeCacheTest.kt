// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.view.View
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class VideoPrivacyTypeCacheTest {
    @Test fun repeatedQueriesDoNotWalkAncestryAgain() {
        var reads = 0
        val cache = VideoPrivacyTypeCache { reads++; it.superclass }
        val first = cache.classify(View::class.java)!!
        assertFalse(first.reactNative)
        assertFalse(first.composeHost)
        assertTrue(reads > 0)
        reads = 0
        repeat(10_000) { cache.classify(View::class.java) }
        assertEquals("warm queries must avoid all superclass reads", 0, reads)
    }

    @Test fun retentionStopsAt64ClassesAndOverflowStillClassifies() {
        var reads = 0
        val cache = VideoPrivacyTypeCache { reads++; it.superclass }
        // Distinct real JVM Classes without generating 64 artificial View subclasses.
        val types = (1..64).map { java.lang.reflect.Array.newInstance(View::class.java, *IntArray(it)).javaClass }
        types.forEach { cache.classify(it) }
        repeat(2) {
            reads = 0
            val overflow = cache.classify(View::class.java)!!
            assertFalse(overflow.reactNative)
            assertFalse(overflow.composeHost)
            assertTrue("overflow must be classified without retaining it", reads > 0)
        }
        reads = 0
        types.forEach { cache.classify(it) }
        assertEquals("overflow must not churn retained metadata", 0, reads)
        val rn = cache.classify(com.facebook.react.VideoPrivacyFixtureView::class.java)!!
        assertTrue("saturation must not default unknown classes to ordinary", rn.reactNative)
        assertFalse(rn.composeHost)
        assertTrue(cache.classify(Class.forName("androidx.compose.ui.platform.AndroidComposeView"))!!.composeHost)
    }

    @Test fun failedAncestryReadIsUnknownAndIsNotRetained() {
        var fail = true
        val cache = VideoPrivacyTypeCache { if (fail) error("unavailable ancestry") else it.superclass }
        assertNull(cache.classify(View::class.java))
        fail = false
        assertFalse(cache.classify(View::class.java)!!.reactNative)
    }
}
