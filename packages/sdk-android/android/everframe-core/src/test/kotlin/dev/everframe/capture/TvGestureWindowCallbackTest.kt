// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The TV capture gesture in `TXWindowCallbackWrapper.dispatchKeyEvent`: armed only on TVs with quick capture
// on, keys swallowed only on linked devices and only after detection, and an unlinked device's events
// delivered as the very same instances. Tokens are never printed.
package dev.everframe.capture

import android.app.Activity
import android.app.Application
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.Window
import android.widget.EditText
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureGestureConfigWire
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.devicelink.DeviceLink
import dev.everframe.devicelink.DeviceLinkOwner
import dev.everframe.devicelink.StoredDeviceLink
import dev.everframe.quickcapture.CaptureGesture
import dev.everframe.quickcapture.QuickCapture
import dev.everframe.quickcapture.TvGestureBinding
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "television")
class TvGestureWindowCallbackTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private lateinit var activity: Activity
    private var captures = 0
    private var hellos = 0
    private var priorCaptureGate = false
    private val token = "evf_dev_" + "Tv9g".repeat(8)
    private val playPause = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
    private val longPress = TvGestureBinding.LongPress("MEDIA_PLAY_PAUSE", 1500)
    private val upUpDownDown = TvGestureBinding.Sequence(listOf("DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"), 1000)

    /** The Activity's own callback, recording every key event that reaches it. */
    private class Recording(private val inner: Window.Callback) : Window.Callback by inner {
        val keys = mutableListOf<KeyEvent>()
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            keys += event
            return false
        }
    }

    @Before
    fun setUp() {
        dev.everframe.shared.SharedData.init(app)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        priorCaptureGate = Everframe.captureGate
        Everframe.captureGate = true
        QuickCapture.isEmulator = { false }
        QuickCapture.screenshotter = { _, _ -> null }
        CaptureGesture.captureTrigger = { captures++ }
        CaptureGesture.helloSender = { hellos++ }
        DeviceLink.refreshConfig = {}
        DeviceLink.toaster = {}
    }

    @After
    fun tearDown() {
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        CaptureGesture.__resetForTesting()
        DeviceLink.__resetForTesting()
        Everframe.captureGate = priorCaptureGate
    }

    private fun arm(
        binding: TvGestureBinding?,
        linked: Boolean,
        debug: Boolean = false,
        captureEnabled: Boolean = true,
        linkingEnabled: Boolean = true,
        chord: String? = null,
    ) {
        QuickCapture.install(app, localEnabled = true, debug = debug)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = captureEnabled, binding = chord))
        DeviceLink.__setCurrentForTesting(
            if (linked) StoredDeviceLink(token, DeviceLinkOwner.User("Aurimas"), "scope") else null,
            enabled = linkingEnabled,
        )
        QuickCapture.publishGesture(CaptureGestureConfigWire(binding))
    }

    private fun wrap(): Pair<TXWindowCallbackWrapper, Recording> {
        val recording = Recording(activity)
        return TXWindowCallbackWrapper(recording, activity) to recording
    }

    private fun key(action: Int, code: Int, downTime: Long, eventTime: Long = downTime, repeat: Int = 0, meta: Int = 0) =
        KeyEvent(downTime, eventTime, action, code, repeat, meta)

    private fun idle(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    @Test
    fun disarmedPassesEveryEventThroughUntouched() {
        arm(binding = null, linked = true)
        assertNull(QuickCapture.armedTvBinding)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val events = listOf(
            key(KeyEvent.ACTION_DOWN, playPause, t),
            key(KeyEvent.ACTION_DOWN, playPause, t, t + 400, repeat = 1),
            key(KeyEvent.ACTION_DOWN, playPause, t, t + 1600, repeat = 2),
            key(KeyEvent.ACTION_UP, playPause, t, t + 1700),
        )
        events.forEach { wrapper.dispatchKeyEvent(it) }
        assertEquals(events.size, delegate.keys.size)
        events.indices.forEach { assertSame(events[it], delegate.keys[it]) }
        assertTrue("no timer posted", shadowOf(Looper.getMainLooper()).isIdle)
        assertEquals(0, captures)
    }

    @Test
    fun linkedLongPressCapturesSwallowsRepeatsAndCancelsUp() {
        arm(longPress, linked = true)
        assertEquals(longPress, QuickCapture.armedTvBinding)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val down = key(KeyEvent.ACTION_DOWN, playPause, t)
        assertFalse(wrapper.dispatchKeyEvent(down))
        assertSame("the first DOWN always reaches the app", down, delegate.keys.single())
        val early = key(KeyEvent.ACTION_DOWN, playPause, t, t + 400, repeat = 1)
        wrapper.dispatchKeyEvent(early)
        assertSame("repeats before detection are delivered", early, delegate.keys.last())
        idle(1500)
        assertEquals(1, captures)
        assertTrue("a repeat after detection is swallowed", wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, playPause, t, t + 1550, repeat = 5)))
        assertEquals(2, delegate.keys.size)
        wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_UP, playPause, t, t + 1600))
        assertEquals(3, delegate.keys.size)
        val up = delegate.keys.last()
        assertEquals(KeyEvent.ACTION_UP, up.action)
        assertTrue("the UP arrives canceled", up.isCanceled)
        assertEquals(1, captures)
        assertEquals(0, hellos)
    }

    @Test
    fun unlinkedReleaseTvSendsHelloAndNeverAltersEvents() {
        arm(longPress, linked = false, debug = false)
        assertNotNull("armed for the hello", QuickCapture.armedTvBinding)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val events = mutableListOf(key(KeyEvent.ACTION_DOWN, playPause, t))
        wrapper.dispatchKeyEvent(events[0])
        for (i in 1..30) {
            val e = key(KeyEvent.ACTION_DOWN, playPause, t, t + 350 + i * 50L, repeat = i)
            events += e
            if (i == 23) idle(1500)
            assertFalse(wrapper.dispatchKeyEvent(e))
        }
        events += key(KeyEvent.ACTION_UP, playPause, t, t + 2000)
        assertFalse(wrapper.dispatchKeyEvent(events.last()))
        assertEquals(events.size, delegate.keys.size)
        events.indices.forEach { assertSame(events[it], delegate.keys[it]) }
        assertFalse(delegate.keys.last().isCanceled)
        assertEquals(1, hellos)
        assertEquals(0, captures)
    }

    @Test
    fun unlinkedDebugTvCapturesWithoutSwallowing() {
        arm(longPress, linked = false, debug = true)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val events = listOf(
            key(KeyEvent.ACTION_DOWN, playPause, t),
            key(KeyEvent.ACTION_DOWN, playPause, t, t + 400, repeat = 1),
            key(KeyEvent.ACTION_DOWN, playPause, t, t + 1500, repeat = 23),
            key(KeyEvent.ACTION_DOWN, playPause, t, t + 1550, repeat = 24),
            key(KeyEvent.ACTION_UP, playPause, t, t + 1600),
        )
        events.forEach { assertFalse(wrapper.dispatchKeyEvent(it)) }
        assertEquals(1, captures)
        events.indices.forEach { assertSame(events[it], delegate.keys[it]) }
        assertFalse(delegate.keys.last().isCanceled)
    }

    @Test
    fun linkedSequenceSwallowsOnlyTheCompletingKey() {
        arm(upUpDownDown, linked = true)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val delivered = mutableListOf<KeyEvent>()
        fun tap(code: Int, at: Long) {
            val d = key(KeyEvent.ACTION_DOWN, code, at)
            val u = key(KeyEvent.ACTION_UP, code, at, at + 60)
            wrapper.dispatchKeyEvent(d)
            wrapper.dispatchKeyEvent(u)
            delivered += d
            delivered += u
        }
        tap(KeyEvent.KEYCODE_DPAD_UP, t)
        tap(KeyEvent.KEYCODE_DPAD_UP, t + 150)
        tap(KeyEvent.KEYCODE_DPAD_DOWN, t + 300)
        assertTrue(wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN, t + 450)))
        assertTrue(wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_DOWN, t + 450, t + 510)))
        assertEquals(1, captures)
        assertEquals(delivered.size, delegate.keys.size)
        delivered.indices.forEach { assertSame(delivered[it], delegate.keys[it]) }
        // The next press is the app's again.
        val next = key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN, t + 700)
        assertFalse(wrapper.dispatchKeyEvent(next))
        assertSame(next, delegate.keys.last())
    }

    @Test
    fun quickCaptureOffDisarms() {
        arm(longPress, linked = true, captureEnabled = false)
        assertNull(QuickCapture.armedTvBinding)
        arm(longPress, linked = true)
        assertNotNull(QuickCapture.armedTvBinding)
        Everframe.captureGate = false
        assertNull("kill switch", QuickCapture.armedTvBinding)
    }

    @Test
    @Config(qualifiers = "en") // replaces the class-level "television": a phone
    fun phonesNeverArmTheTvBinding() {
        arm(longPress, linked = true)
        assertNull(QuickCapture.armedTvBinding)
        arm(longPress, linked = false, debug = true)
        assertNull(QuickCapture.armedTvBinding)
    }

    @Test
    fun emulatorShiftBStillWinsOnTvEmulator() {
        QuickCapture.isEmulator = { true }
        arm(TvGestureBinding.Chord(setOf("SHIFT", "B")), linked = false, debug = true, chord = "Shift+B")
        assertNotNull(QuickCapture.armedChord)
        assertNotNull(QuickCapture.armedTvBinding)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val shift = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT, t, meta = shift))
        assertTrue(wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_B, t + 40, meta = shift)))
        assertTrue(wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_B, t + 40, t + 100, meta = shift)))
        wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SHIFT_LEFT, t, t + 150))
        assertNotNull("the emulator chord triggered", QuickCapture.__lastTrigger)
        assertEquals("the TV binding did not trigger a second capture", 0, captures)
        assertEquals(2, delegate.keys.size)
    }

    @Test
    fun bindingChangeMidPressResetsWithoutFiring() {
        arm(longPress, linked = true)
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, playPause, t))
        QuickCapture.publishGesture(CaptureGestureConfigWire(TvGestureBinding.LongPress("MEDIA_PLAY_PAUSE", 2000)))
        val repeat = key(KeyEvent.ACTION_DOWN, playPause, t, t + 400, repeat = 1)
        assertFalse(wrapper.dispatchKeyEvent(repeat))
        idle(2500)
        val late = key(KeyEvent.ACTION_DOWN, playPause, t, t + 2500, repeat = 40)
        assertFalse(wrapper.dispatchKeyEvent(late))
        val up = key(KeyEvent.ACTION_UP, playPause, t, t + 2600)
        assertFalse(wrapper.dispatchKeyEvent(up))
        assertEquals(0, captures)
        assertSame(late, delegate.keys[2])
        assertSame(up, delegate.keys[3])
        assertFalse(up.isCanceled)
    }

    @Test
    fun detachCancelsThePendingHold() {
        arm(longPress, linked = true)
        val (wrapper, _) = wrap()
        wrapper.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, playPause, SystemClock.uptimeMillis()))
        wrapper.onDetachedFromWindow()
        idle(2000)
        assertEquals(0, captures)
    }

    @Test
    fun typedChordStandsAsideWhileEditingText() {
        arm(TvGestureBinding.Chord(setOf("SHIFT", "B")), linked = true)
        val field = EditText(activity)
        activity.setContentView(field)
        field.requestFocus()
        val (wrapper, delegate) = wrap()
        val t = SystemClock.uptimeMillis()
        val b = key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_B, t, meta = KeyEvent.META_SHIFT_ON)
        assertFalse(wrapper.dispatchKeyEvent(b))
        assertSame(b, delegate.keys.single())
        assertEquals(0, captures)
    }
}
