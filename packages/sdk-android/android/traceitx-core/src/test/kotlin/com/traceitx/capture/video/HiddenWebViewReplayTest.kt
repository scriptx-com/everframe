// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.app.Activity
import android.graphics.Matrix
import android.view.View
import android.view.ViewGroup
import android.view.animation.AlphaAnimation
import android.webkit.WebView
import android.widget.FrameLayout
import com.traceitx.TraceItX
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class HiddenWebViewReplayTest {
    // Robolectric's WebView provider does not implement setFrame; use real View bounds
    // directly. Native PixelCopy tests below cover the actual WebView layout/render path.
    private fun WebView.bounds(l: Int, t: Int, r: Int, b: Int) {
        left = l; top = t; right = r; bottom = b
    }

    private fun fixture(test: (FrameLayout, FrameLayout, WebView, VideoPrivacyGate) -> Unit) {
        val controller = Robolectric.buildActivity(Activity::class.java).setup().visible()
        val activity = controller.get()
        val root = FrameLayout(activity)
        val parent = FrameLayout(activity)
        val web = WebView(activity)
        activity.setContentView(root)
        root.addView(parent, FrameLayout.LayoutParams(100,100)); parent.addView(web, FrameLayout.LayoutParams(50,50))
        val size = View.MeasureSpec.makeMeasureSpec(500, View.MeasureSpec.EXACTLY)
        activity.window.decorView.measure(size, size)
        activity.window.decorView.layout(0, 0, 500, 500)
        root.layout(0, 0, 100, 100)
        parent.layout(0, 0, 100, 100); web.bounds(0, 0, 50, 50)
        try { test(root, parent, web, VideoPrivacyGate({ activity }, { 0L }, { true })) }
        finally { root.removeAllViews(); web.destroy(); controller.pause().stop().destroy() }
    }

    @Test fun transparentSpeedTestContainerDoesNotBlockReplay() = fixture { root, parent, web, gate ->
        parent.layout(-3, -3, 0, 0); web.bounds(0, 0, 3, 3); parent.alpha = 0f
        assertTrue("background speed-test WebView must not suppress the screen", gate.observe(root).allowed)
    }

    @Test fun rememberedVisibleWebViewCanBecomeHiddenAndVisibleAgain() = fixture { root, parent, _, gate ->
        assertFalse(gate.observe(root).allowed)
        parent.alpha = 0f
        val hidden = gate.observe(root)
        assertTrue("weak history must recheck visibility", hidden.allowed)
        parent.alpha = 1f
        val visible = gate.observe(root)
        assertFalse(visible.allowed)
        assertTrue("visibility change invalidates an in-flight capture", visible.epoch > hidden.epoch)
        parent.visibility = View.GONE
        assertTrue(gate.observe(root).allowed)
    }

    @Test fun zeroAreaAndClippedWebViewDoNotBlock() = fixture { root, _, web, gate ->
        web.bounds(0, 0, 0, 0)
        assertTrue(gate.observe(root).allowed)
        web.bounds(101, 0, 151, 50)
        assertTrue("fully clipped WebView", gate.observe(root).allowed)
        web.bounds(99, 0, 149, 50)
        assertFalse("even one visible pixel remains protected", gate.observe(root).allowed)
    }

    @Test fun invisibleOrTransitionHiddenAncestorCannotUseAlphaOrClippingAsFallback() = fixture { root, parent, web, gate ->
        parent.alpha = 0f
        parent.layout(-3, -3, 0, 0); web.bounds(0, 0, 3, 3)
        assertTrue(gate.observe(root).allowed)
        parent.visibility = View.INVISIBLE
        assertFalse("an overlay ghost may render an invisible original", gate.observe(root).allowed)
        parent.visibility = View.VISIBLE
        parent.transitionAlpha = 0f
        assertFalse("transition suppression is not proof of absent window pixels", gate.observe(root).allowed)
        parent.transitionAlpha = 1f
        assertTrue("ordinary background visibility recovers", gate.observe(root).allowed)
    }

    @Test fun transparentDoesNotMeanNearlyTransparent() = fixture { root, parent, _, gate ->
        parent.alpha = 0.01f
        assertFalse(gate.observe(root).allowed)
    }

    @Test fun explicitSensitivityStillBlocksHiddenWebViewIncludingAfterAutomaticObservation() = fixture { root, parent, web, gate ->
        assertFalse(gate.observe(root).allowed)
        parent.alpha = 0f
        TraceItX.markSensitive(web)
        assertFalse("explicit sensitivity takes precedence over automatic WebView classification", gate.observe(root).allowed)
    }

    @Test fun animationOnHiddenAncestorRemainsUncertain() = fixture { root, parent, _, gate ->
        parent.alpha = 0f
        parent.startAnimation(AlphaAnimation(0f, 1f).apply { duration = 1000 })
        assertFalse("legacy animations can override visibility/alpha", gate.observe(root).allowed)
    }

    @Test fun overlayWithUninspectableAncestryRemainsExcluded() = fixture { root, parent, web, gate ->
        assertFalse(gate.observe(root).allowed)
        parent.removeView(web); root.overlay.add(web)
        assertTrue(web.isAttachedToWindow)
        assertFalse("visible overlay remains protected", gate.observe(root).allowed)
        web.alpha = 0f
        assertFalse("overlay ancestry cannot prove the rendering state", gate.observe(root).allowed)
        web.alpha = 1f
        assertFalse(gate.observe(root).allowed)
        root.overlay.remove(web)
    }

    @Test fun initiallyHiddenWebViewMovedIntoVisibleOverlayRemainsProtected() = fixture { root, parent, web, gate ->
        parent.alpha = 0f
        assertTrue(gate.observe(root).allowed)
        parent.removeView(web); root.overlay.add(web)
        assertTrue(web.isAttachedToWindow)
        assertFalse("an initially hidden WebView must enter overlay history too", gate.observe(root).allowed)
        root.overlay.remove(web)
    }

    @Test fun childDrawingOutsideNonClippingParentRemainsProtected() = fixture { root, parent, web, gate ->
        parent.layout(0,0,10,10)
        parent.clipChildren = false; parent.clipToPadding = false
        web.bounds(20,0,70,50)
        assertFalse("WebView can draw outside its parent but inside the window", gate.observe(root).allowed)
    }

    @Test fun repeatedHiddenObservationsDoNotExhaustWeakHistory() = fixture { root, parent, _, gate ->
        parent.alpha = 0f
        repeat(2050) { assertTrue("hidden frame $it must remain admissible", gate.observe(root).allowed) }
    }

    @Test fun ghostedWebViewSubtreeRemainsExcluded() = fixture { root, parent, _, gate ->
        assertFalse(gate.observe(root).allowed)
        // The platform's actual shared-element ghost, not a mocked visibility flag.
        val ghostType = Class.forName("android.view.GhostView")
        try {
            val ghost = ghostType.getDeclaredMethod("addGhost", View::class.java, ViewGroup::class.java, Matrix::class.java)
                .invoke(null, parent, root.rootView, Matrix()) as View
            assertEquals(View.INVISIBLE, parent.visibility)
            assertEquals(View.VISIBLE, ghost.visibility)
            assertTrue(ghost.isAttachedToWindow)
            assertNull(parent.animation)
            assertNull(parent.animationMatrix)
            assertFalse("visible overlay ghost must not pass the hidden proof", gate.observe(root).allowed)
        } finally {
            ghostType.getDeclaredMethod("removeGhost", View::class.java).invoke(null, parent)
        }
    }

    @Test fun disappearingHiddenWebViewSubtreeRemainsExcluded() = fixture { root, parent, web, gate ->
        assertFalse(gate.observe(root).allowed)
        try {
            root.startViewTransition(parent)
            parent.visibility = View.GONE
            root.removeView(parent)
            assertTrue(web.isAttachedToWindow)
            assertSame(root, parent.parent)
            assertEquals(-1, root.indexOfChild(parent))
            assertNull(parent.animation)
            assertNull(parent.animationMatrix)
            assertFalse("disappearing child can draw despite GONE", gate.observe(root).allowed)
        } finally {
            root.endViewTransition(parent)
        }
    }

    @Test fun membershipScanSharesTheVisibilityProofBudget() = fixture { root, parent, web, _ ->
        parent.alpha = 0f
        repeat(40) { root.addView(View(root.context), 0) }
        assertNotNull(HiddenVideoWebView.inspect(web, Long.MAX_VALUE, 2048) { 0L })
        assertNull("sibling scans cannot exceed remaining visits", HiddenVideoWebView.inspect(web, Long.MAX_VALUE, 32) { 0L })
    }
}
