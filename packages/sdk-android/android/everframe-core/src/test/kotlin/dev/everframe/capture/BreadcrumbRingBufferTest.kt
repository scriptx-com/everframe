// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BreadcrumbRingBuffer + Everframe.addBreadcrumb + live config gating.
// Mirrors packages/sdk-core/__tests__/breadcrumb-buffer.spec.ts's matrix and
// the reviewer-approved sdk-ios twin (BreadcrumbRingBufferTests.swift) — same
// t/seq semantics, same redact-before-buffer / depth-cap / message-cap
// doctrine (MASK-BEFORE-BYTES), same freeze/discardAndResume/takeFrozen/
// clear lifecycle.
//
// Buffer-level cases construct a private instance via the test-only
// `honorsKillGate = false` seam so they don't need a live Everframe.start().
// Gate + addBreadcrumb cases drive the real `Everframe` singleton through
// start()/kill() against the process-wide `sharedBreadcrumbBuffer` and reset
// it before/after (mirrors LogCaptureTest / EverframeTest teardown style).
package dev.everframe.capture

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.protocol.generated.Breadcrumb
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.protocol.generated.Level
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class BreadcrumbRingBufferTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    // 3-segment JWT-shaped string — same pattern id ("jwt") RedactionEngineTest
    // exercises. Android's RedactionEngine uses the pattern's own JSON
    // `replacement` field verbatim ("[REDACTED:JWT]", uppercase) — NOT the
    // lowercased-id convention the iOS twin's RedactionEngine uses.
    private val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"

    private fun noLogCaptureConfig(): EverframeConfig = EverframeConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        capture = CaptureConfig(logs = false),
    )

    /** Resets the process-global shared buffer between addBreadcrumb-level cases. */
    private fun resetBreadcrumbState() {
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
    }

    @Before
    fun setUp() {
        // RedactionEngine (invoked by every buf.add()) reads SharedData, which
        // requires an explicit init with a Context outside of Everframe.start()
        // (mirrors RedactionEngineTest's setUp — Robolectric gives a fresh
        // Application per test, so this can't be assumed to already be done).
        SharedData.init(context)
    }

    @After
    fun tearDown() {
        Everframe.kill()
        resetBreadcrumbState()
    }

    // MARK: - t / seq stamping

    @Test
    fun `stamps epoch ms and monotonic seq`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        val before = System.currentTimeMillis().toDouble()
        buf.add(kind = BreadcrumbKind.Tap, message = "a")
        buf.add(kind = BreadcrumbKind.Tap, message = "b")
        val after = System.currentTimeMillis().toDouble()
        buf.freeze()
        val frozen = buf.takeFrozen()!!
        assertEquals(2, frozen.size)
        assertEquals(0L, frozen[0].seq)
        assertEquals(1L, frozen[1].seq)
        assertTrue(frozen[0].t >= before && frozen[0].t <= after)
        assertTrue(frozen[1].t >= before && frozen[1].t <= after)
    }

    // MARK: - cap / evict-oldest

    @Test
    fun `caps at maxCount evicting oldest, default 100`() {
        val buf = BreadcrumbRingBuffer(maxCount = 3, honorsKillGate = false)
        for (i in 0 until 5) buf.add(kind = BreadcrumbKind.Console, message = "m$i")
        assertEquals(3, buf.size)
        buf.freeze()
        assertEquals(listOf("m2", "m3", "m4"), buf.takeFrozen()!!.map { it.message })
        assertEquals(100, BreadcrumbRingBuffer.defaultMaxCount)
        assertEquals(100, BreadcrumbRingBuffer().maxCount)
    }

    @Test
    fun `setMaxCount shrinks and evicts oldest immediately`() {
        val buf = BreadcrumbRingBuffer(maxCount = 5, honorsKillGate = false)
        for (i in 0 until 5) buf.add(kind = BreadcrumbKind.Tap, message = "m$i")
        buf.setMaxCount(2)
        assertEquals(2, buf.size)
        buf.freeze()
        assertEquals(listOf("m3", "m4"), buf.takeFrozen()!!.map { it.message })
    }

    @Test
    fun `setMaxCount grows for future adds`() {
        val buf = BreadcrumbRingBuffer(maxCount = 2, honorsKillGate = false)
        buf.setMaxCount(4)
        for (i in 0 until 4) buf.add(kind = BreadcrumbKind.Tap, message = "m$i")
        assertEquals(4, buf.size)
    }

    @Test
    fun `setMaxCount ignores invalid values`() {
        val buf = BreadcrumbRingBuffer(maxCount = 3, honorsKillGate = false)
        for (i in 0 until 3) buf.add(kind = BreadcrumbKind.Tap, message = "m$i")
        buf.setMaxCount(0)
        buf.setMaxCount(-1)
        assertEquals(3, buf.size)
        assertEquals(3, buf.maxCount)
    }

    // MARK: - redaction (mask-before-bytes)

    @Test
    fun `redacts message and data string before buffering`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        val data: JsonObject = buildJsonObject {
            put("nested", buildJsonObject { put("v", JsonPrimitive(jwt)) })
        }
        buf.add(kind = BreadcrumbKind.Console, message = "token $jwt", data = data)
        buf.freeze()
        val crumb = buf.takeFrozen()!!.first()
        assertEquals("token [REDACTED:JWT]", crumb.message)
        val nested = crumb.data?.get("nested") as? JsonObject
        assertEquals("[REDACTED:JWT]", (nested?.get("v") as? JsonPrimitive)?.content)
    }

    @Test
    fun `depth cap replaces subtree at depth 4 and never leaks raw value`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        val data: JsonObject = buildJsonObject {
            put(
                "a",
                buildJsonObject {
                    put(
                        "b",
                        buildJsonObject {
                            put("c", buildJsonObject { put("d", buildJsonObject { put("e", JsonPrimitive(jwt)) }) })
                        },
                    )
                },
            )
        }
        buf.add(kind = BreadcrumbKind.Custom, message = "deep", data = data)
        buf.freeze()
        val crumb = buf.takeFrozen()!!.first()
        val a = crumb.data?.get("a") as? JsonObject
        val b = a?.get("b") as? JsonObject
        val c = b?.get("c") as? JsonObject
        val d = c?.get("d") as? JsonPrimitive
        assertEquals("[TRUNCATED:DEPTH]", d?.content)
        // Sanity: the raw secret never survives anywhere in the tree.
        assertFalse(crumb.data.toString().contains(jwt))
    }

    // MARK: - message cap

    @Test
    fun `caps message at 2048 UTF-16 units and marks truncated`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Custom, message = "x".repeat(5000))
        buf.freeze()
        val crumb = buf.takeFrozen()!!.first()
        assertEquals(2048, crumb.message.length)
        assertEquals(true, crumb.truncated)
    }

    @Test
    fun `does not set truncated when message is at or under the cap`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Custom, message = "x".repeat(2048))
        buf.freeze()
        val crumb = buf.takeFrozen()!!.first()
        assertEquals(2048, crumb.message.length)
        assertNull(crumb.truncated)
    }

    // MARK: - freeze / discardAndResume / takeFrozen / clear lifecycle

    @Test
    fun `freeze snapshots chain, later adds do not pollute`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "before")
        buf.freeze()
        buf.add(kind = BreadcrumbKind.Tap, message = "reporter-own-tap")
        assertEquals(listOf("before"), buf.takeFrozen()!!.map { it.message })
        assertEquals(2, buf.size) // live capture was never interrupted
    }

    @Test
    fun `freeze while frozen keeps first snapshot`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "one")
        buf.freeze()
        buf.add(kind = BreadcrumbKind.Tap, message = "two")
        buf.freeze()
        assertEquals(1, buf.takeFrozen()!!.size)
    }

    @Test
    fun `discardAndResume drops snapshot`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "a")
        buf.freeze()
        buf.discardAndResume()
        assertNull(buf.takeFrozen())
    }

    @Test
    fun `takeFrozen returns null without prior freeze and clears after use`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "a")
        assertNull(buf.takeFrozen())
        buf.freeze()
        assertEquals(1, buf.takeFrozen()!!.size)
        assertNull(buf.takeFrozen())
    }

    @Test
    fun `clear zeroizes entries and snapshot`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "a")
        buf.freeze()
        buf.clear()
        assertEquals(0, buf.size)
        assertNull(buf.takeFrozen())
    }

    // MARK: - kill-gate wiring (mirrors LogRingBuffer's shared-instance gate test)

    @Test
    fun `kill gate blocks shared buffer add`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        Everframe.kill()
        sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Tap, message = "blocked")
        assertEquals(0, sharedBreadcrumbBuffer.size)
        Everframe.start(context, noLogCaptureConfig())
        resetBreadcrumbState()
    }

    // MARK: - config gating (Task 1's wire, evaluated live at add-time)

    @Test
    fun `applyConfig disabled clears and gates all adds`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "a")
        assertEquals(1, buf.size)
        buf.applyConfig(
            dev.everframe.config.BreadcrumbsConfigWire(
                enabled = false, kinds = listOf("tap"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        assertEquals(0, buf.size) // clear() fires on the enabled:false transition
        buf.add(kind = BreadcrumbKind.Tap, message = "b")
        assertEquals(0, buf.size) // still gated
    }

    @Test
    fun `disabled kind add is a no-op`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.applyConfig(
            dev.everframe.config.BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("tap"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        buf.add(kind = BreadcrumbKind.Console, message = "not enabled")
        assertEquals(0, buf.size)
        assertFalse(buf.isKindEnabled(BreadcrumbKind.Console))
        buf.add(kind = BreadcrumbKind.Tap, message = "enabled")
        assertEquals(1, buf.size)
        assertTrue(buf.isKindEnabled(BreadcrumbKind.Tap))
    }

    @Test
    fun `applyConfig null restores defaults`() {
        val buf = BreadcrumbRingBuffer(maxCount = 3, honorsKillGate = false)
        buf.applyConfig(
            dev.everframe.config.BreadcrumbsConfigWire(
                enabled = false, kinds = emptyList(), maxCount = 1, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        buf.applyConfig(null)
        assertEquals(BreadcrumbRingBuffer.defaultMaxCount, buf.maxCount)
        assertTrue(buf.isKindEnabled(BreadcrumbKind.Console))
        buf.add(kind = BreadcrumbKind.Console, message = "back to defaults")
        assertEquals(1, buf.size)
    }

    // MARK: - Everframe.addBreadcrumb coercions
    //
    // Each case below uses a UUID-suffixed, unique `message` and filters the
    // frozen chain for it rather than assuming the first crumb is "the" one
    // this test added — ReplaySession.enableIfConfigured() kicks off an
    // async config refresh on Everframe.start() that (harmlessly) calls
    // sharedBreadcrumbBuffer.applyConfig() in the background; filtering by a
    // unique marker keeps these assertions robust to that race.

    private fun matchingCrumb(message: String): Breadcrumb? {
        sharedBreadcrumbBuffer.freeze()
        return sharedBreadcrumbBuffer.takeFrozen()?.firstOrNull { it.message == message }
    }

    @Test
    fun `addBreadcrumb coerces unknown kind to Custom`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        val marker = "hi-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(message = marker, kind = "totally-unknown-kind")
        assertEquals(BreadcrumbKind.Custom, matchingCrumb(marker)?.kind)
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb drops invalid level rather than defaulting`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        val marker = "hi-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(message = marker, level = "not-a-real-level")
        val crumb = matchingCrumb(marker)
        assertNotNull(crumb)
        assertNull(crumb?.level)
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb accepts known kind and level`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        val marker = "hi-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(message = marker, kind = "navigation", level = "warn")
        val crumb = matchingCrumb(marker)
        assertEquals(BreadcrumbKind.Navigation, crumb?.kind)
        assertEquals(Level.Warn, crumb?.level)
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb coerces data dropping non-encodable entries`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        val marker = "with-data-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(
            message = marker,
            data = mapOf("keep" to "value", "alsoKeep" to 42, "drop" to Any()),
        )
        val crumb = matchingCrumb(marker)
        assertEquals("value", (crumb?.data?.get("keep") as? JsonPrimitive)?.content)
        assertNull(crumb?.data?.get("drop"))
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb coerces nested Map and List round-trip correctly`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        val marker = "nested-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(
            message = marker,
            data = mapOf(
                "outer" to mapOf("inner" to "value", "count" to 3),
                "list" to listOf(1, "two", true),
            ),
        )
        val crumb = matchingCrumb(marker)
        val outer = crumb?.data?.get("outer") as? JsonObject
        assertEquals("value", (outer?.get("inner") as? JsonPrimitive)?.content)
        assertEquals("3", (outer?.get("count") as? JsonPrimitive)?.content)
        val list = crumb?.data?.get("list") as? kotlinx.serialization.json.JsonArray
        assertEquals(3, list?.size)
        assertEquals("1", (list?.get(0) as? JsonPrimitive)?.content)
        assertEquals("two", (list?.get(1) as? JsonPrimitive)?.content)
        assertEquals("true", (list?.get(2) as? JsonPrimitive)?.content)
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb drops the whole top-level entry when a nested value is non-coercible`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        val marker = "nested-drop-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(
            message = marker,
            data = mapOf(
                "outer" to mapOf("good" to "value", "bad" to Any()),
                "keep" to "still here",
            ),
        )
        val crumb = matchingCrumb(marker)
        // All-or-nothing: one non-coercible value nested inside "outer" drops the
        // ENTIRE "outer" entry — including the sibling "good" key that would have
        // coerced fine on its own — not just the offending "bad" key.
        assertNull(crumb?.data?.get("outer"))
        assertEquals("still here", (crumb?.data?.get("keep") as? JsonPrimitive)?.content)
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb survives pathologically deep data without crashing`() {
        resetBreadcrumbState()
        Everframe.start(context, noLogCaptureConfig())
        var deep: Map<String, Any?> = mapOf("k" to "bottom")
        repeat(10_000) { deep = mapOf("k" to deep) }
        val marker = "deep-${UUID.randomUUID()}"
        // Must return normally — no StackOverflowError — thanks to the
        // maxCoerceDepth=64 guard in coerceValue.
        Everframe.addBreadcrumb(message = marker, data = deep)
        assertNotNull(matchingCrumb(marker))
        // SDK still usable afterward: a subsequent normal addBreadcrumb lands.
        val marker2 = "after-deep-${UUID.randomUUID()}"
        Everframe.addBreadcrumb(message = marker2, data = mapOf("ok" to "yes"))
        val crumb2 = matchingCrumb(marker2)
        assertEquals("yes", (crumb2?.data?.get("ok") as? JsonPrimitive)?.content)
        resetBreadcrumbState()
    }

    @Test
    fun `addBreadcrumb is no-op pre-start or when killed`() {
        resetBreadcrumbState()
        Everframe.kill()
        Everframe.addBreadcrumb(message = "should not land")
        assertEquals(0, sharedBreadcrumbBuffer.size)
        Everframe.start(context, noLogCaptureConfig())
        resetBreadcrumbState()
    }

    // MARK: - crash-safe snapshot (spec 2026-07-18)

    @Test
    fun `snapshotForCrash returns copy without disturbing freeze lifecycle`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Console, message = "one")
        buf.add(kind = BreadcrumbKind.Error, message = "two")
        val snap = buf.snapshotForCrash()
        assertEquals(listOf("one", "two"), snap.map { it.message })
        assertEquals(2, buf.size)
        buf.freeze()
        assertEquals(2, buf.takeFrozen()?.size)
    }

    @Test
    fun `snapshotForCrash returns empty when lock is held past timeout`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Console, message = "one")
        val latch = java.util.concurrent.CountDownLatch(1)
        val holder = Thread {
            buf.__holdLockForTesting { latch.countDown(); Thread.sleep(150) }
        }
        holder.start()
        latch.await()
        assertTrue(buf.snapshotForCrash(timeoutMs = 30).isEmpty())
        holder.join()
    }

    @Test
    fun `snapshotForCrash swallows interrupt, restores flag, returns empty`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Console, message = "one")
        val latch = java.util.concurrent.CountDownLatch(1)
        val holder = Thread {
            buf.__holdLockForTesting { latch.countDown(); Thread.sleep(150) }
        }
        holder.start()
        latch.await()
        try {
            // Lock is contended, so the timed tryLock parks — and a pending
            // interrupt makes it throw InterruptedException, which must NOT
            // escape the crash path.
            Thread.currentThread().interrupt()
            val snap = buf.snapshotForCrash(timeoutMs = 50) // must not throw
            assertTrue(snap.isEmpty())
            // Interrupt flag restored for callers up-stack (and cleared here
            // by Thread.interrupted() so it can't leak into other tests).
            assertTrue(Thread.interrupted())
        } finally {
            Thread.interrupted() // belt-and-braces: never leak the flag
            holder.join()
        }
    }
}
