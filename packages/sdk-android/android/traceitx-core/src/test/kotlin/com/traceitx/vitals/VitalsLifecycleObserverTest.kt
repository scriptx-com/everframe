// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.vitals

import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.testing.TestLifecycleOwner
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VitalsLifecycleObserverTest {
    @Test
    fun `forwards start and stop`() {
        val log = ArrayList<String>()
        val o = VitalsLifecycleObserver(onForeground = { log.add("fg") }, onBackground = { log.add("bg") })
        val owner: LifecycleOwner = TestLifecycleOwner()
        o.onStart(owner); o.onStop(owner)
        assertEquals(listOf("fg", "bg"), log)
    }

    @Test
    fun `a throwing callback is contained`() {
        val o = VitalsLifecycleObserver(onForeground = { error("x") }, onBackground = {})
        o.onStart(TestLifecycleOwner())
    }

    @Test
    fun `an install and uninstall from a background thread leave no observer registered`() {
        // Final review, I3. install() used to post when off-main while
        // uninstall() ran INLINE when it happened to be on main, so the
        // removeObserver could execute before the queued addObserver and the
        // observer leaked onto the lifecycle for the rest of the process.
        // Both always post now, so the main queue preserves call order.
        val owner = TestLifecycleOwner()
        val o = VitalsLifecycleObserver(onForeground = {}, onBackground = {}, owner = { owner })

        val worker = Thread { o.install(); o.uninstall() }
        worker.start()
        worker.join(TimeUnit.SECONDS.toMillis(5))

        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0, owner.observerCount)
    }

    @Test
    fun `installing while the process is already stopped takes the background path`() {
        // Codex round-3, Important 10. `addObserver` brings a new observer UP
        // to the owner's current state but never replays an `ON_STOP` that has
        // already happened, so enablement arriving in the background installed
        // an observer that heard nothing — and the sampler the controller's
        // tail had just started kept sampling, and uploading, for the whole
        // background interval.
        val log = ArrayList<String>()
        val owner = TestLifecycleOwner(Lifecycle.State.CREATED)
        val o = VitalsLifecycleObserver(onForeground = { log.add("fg") }, onBackground = { log.add("bg") }, owner = { owner })

        o.install()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("a background install must pause immediately", listOf("bg"), log)

        owner.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertEquals("...and the next real onStart resumes", listOf("bg", "fg"), log)
    }

    @Test
    fun `installing while the process is started does not pause`() {
        val log = ArrayList<String>()
        val owner = TestLifecycleOwner(Lifecycle.State.STARTED)
        val o = VitalsLifecycleObserver(onForeground = { log.add("fg") }, onBackground = { log.add("bg") }, owner = { owner })

        o.install()
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals("addObserver replays ON_START itself; nothing may pause here", listOf("fg"), log)
    }

    @Test
    fun `install registers exactly once and a second uninstall is a no-op`() {
        val owner = TestLifecycleOwner()
        val o = VitalsLifecycleObserver(onForeground = {}, onBackground = {}, owner = { owner })

        o.install(); o.install()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, owner.observerCount)

        o.uninstall(); o.uninstall()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0, owner.observerCount)
    }
}
