// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.semantics.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.everframe.sensitive.txSensitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Controller-owned device run. Adapter is injected only here pending bounded-work evidence. */
class ComposeVideoPrivacyInstrumentedTest {
    @get:Rule val rule = createAndroidComposeRule<VideoPrivacyFixtureActivity>()
    private val mode = mutableStateOf("clean")

    @Composable private fun Deep(depth: Int) {
        if (depth == 0) BasicText("leaf") else Box { Deep(depth - 1) }
    }
    @Composable private fun Fixture() {
        if (mode.value == "empty") return
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            BasicText("public")
            Image(ColorPainter(Color.Blue), "public image", Modifier.size(20.dp))
            when (mode.value) {
                "editable" -> BasicTextField("private", {})
                "password" -> BasicText("private", Modifier.semantics { password() })
                "sensitive" -> BasicText("private", Modifier.txSensitive())
                "clearing" -> BasicText("private", Modifier.clearAndSetSemantics {})
                "merged-password" -> Box(Modifier.semantics(mergeDescendants = true) {}) { BasicText("private", Modifier.semantics { password() }) }
                "merged-sensitive" -> Box(Modifier.semantics(mergeDescendants = true) {}) { BasicText("private", Modifier.txSensitive()) }
                "offscreen" -> BasicText("private", Modifier.offset(y = 10000.dp).txSensitive())
                "surface" -> AndroidView(factory = { WebView(it) })
                "wide" -> repeat(2200) { Box(Modifier.size(1.dp)) }
                "semantic-wide" -> repeat(2050) { BasicText("public") }
                "deep" -> Deep(120)
                "draw" -> Canvas(Modifier.size(40.dp)) { repeat(100) { drawCircle(Color.Green, it.toFloat()) } }
            }
        }
    }
    private fun host(): View {
        val queue = ArrayDeque<View>(); queue.add(rule.activity.window.decorView)
        while (queue.isNotEmpty()) {
            val view = queue.removeFirst()
            if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView") return view
            if (view is ViewGroup) repeat(view.childCount) { queue.add(view.getChildAt(it)) }
        }
        error("Compose host absent")
    }
    @Test fun observedComposeHostMovedToOverlayStaysExcludedWithoutRevokingHistory() {
        mode.value = "editable"
        rule.setContent { Fixture() }; rule.waitForIdle()
        rule.runOnIdle {
            val host = host()
            var container: View = host
            while (container.parent is View && container !is ComposeView) container = container.parent as View
            assertTrue("fixture must move the ComposeView container", container is ComposeView)
            val decor = rule.activity.window.decorView as ViewGroup
            val originalParent = container.parent as ViewGroup
            val originalIndex = originalParent.indexOfChild(container)
            val layoutParams = container.layoutParams
            val gate = VideoPrivacyGate({ rule.activity }, { 0L }, { true })
            val retainedGeneration = VideoPrivacyRevocation.current
            assertFalse("production observes and excludes Compose before reparenting", gate.observe(decor).allowed)
            assertEquals(retainedGeneration, VideoPrivacyRevocation.current)
            try {
                decor.overlay.add(container)
                assertTrue("host still owns rendered pixels", host.isAttachedToWindow)
                assertSame(decor.windowToken, host.windowToken)
                assertEquals(-1, originalParent.indexOfChild(container))
                assertFalse("observed host stays excluded outside public children", gate.observe(decor).allowed)
                assertEquals("ordinary exclusion preserves retained history", retainedGeneration, VideoPrivacyRevocation.current)
                decor.overlay.remove(container)
                assertFalse(host.isAttachedToWindow)
                assertTrue("actual detach releases window exclusion", gate.observe(decor).allowed)
            } finally {
                decor.overlay.remove(container)
                if (container.parent == null) originalParent.addView(container, originalIndex, layoutParams)
            }
        }
    }
    @Test fun typedSemanticsAndSharedNativeTraversalExcludeAllSensitiveFixtures() {
        rule.setContent { Fixture() }
        val adapter = ComposeVideoPrivacyAdapter { 0L }
        for (fixture in listOf("clean", "empty", "editable", "password", "sensitive", "clearing", "merged-password", "merged-sensitive", "offscreen", "surface", "semantic-wide")) {
            rule.runOnIdle { mode.value = fixture }; rule.waitForIdle()
            rule.runOnIdle {
                val gate = VideoPrivacyGate({ rule.activity }, { 0L }, { true }, adapter::inspectForGate)
                val observed = gate.observe(rule.activity.window.decorView)
                assertEquals("fixture=$fixture", fixture == "clean", observed.allowed)
            }
        }
    }
    @Test fun measureFrameworkTraversalAcrossWideDeepAndCustomDrawFixtures() {
        rule.setContent { Fixture() }
        val adapter = ComposeVideoPrivacyAdapter()
        for (fixture in listOf("clean", "wide", "deep", "draw", "semantic-wide")) {
            rule.runOnIdle { mode.value = fixture }; rule.waitForIdle()
            rule.runOnIdle {
                val view = host()
                var max = 0L
                repeat(30) {
                    val start = SystemClock.elapsedRealtimeNanos()
                    val result = adapter.inspectBudgeted(view, Long.MAX_VALUE, 2048)
                    val elapsed = SystemClock.elapsedRealtimeNanos() - start
                    max = maxOf(max, elapsed)
                    android.util.Log.i("EverframeComposeBudget", "$fixture sample=$it ns=$elapsed nodes=${result.visited} classification=${result.classification}")
                }
                android.util.Log.i("EverframeComposeBudget", "$fixture maxNs=$max budgetNs=2000000")
                // Measurements are evidence, not an assertion that framework work is preemptible.
                assertEquals(VideoPrivacyAdapter.Classification.EXCLUDE, adapter.inspect(view, 0, 2048))
                assertEquals(VideoPrivacyAdapter.Classification.EXCLUDE, adapter.inspect(view, Long.MAX_VALUE, 0))
            }
        }
    }
    @Test fun cleanComposeFixtureAdmitsRealPixelCopyWithInjectedAdapter() {
        rule.setContent { Fixture() }; rule.waitForIdle()
        val accepted = CountDownLatch(1)
        val capture = PixelCopyVideoCapture(
            AndroidVideoCapturePlatform({ rule.activity }, VideoPrivacyGate({ rule.activity }, composeInspector = ComposeVideoPrivacyAdapter()::inspectForGate)),
            AndroidVideoCaptureScheduler,
        )
        try {
            repeat(12) { attempt ->
                if (accepted.count != 0L) {
                    capture.request(VideoOwner("compose-device", "$attempt"), VideoSize(100,100)) { frame ->
                        if (frame.withPixels { assertFalse(it.isRecycled) }) accepted.countDown()
                        frame.close()
                    }
                    rule.runOnIdle { rule.activity.window.decorView.invalidate() }
                    accepted.await(250, TimeUnit.MILLISECONDS)
                }
            }
            assertEquals("clean Compose never admitted real pixels", 0L, accepted.count)
        } finally { capture.cancel() }
    }
}
