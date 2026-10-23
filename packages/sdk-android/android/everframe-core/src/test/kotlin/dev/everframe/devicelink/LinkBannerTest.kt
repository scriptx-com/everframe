// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.devicelink

import android.app.Activity
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class LinkBannerTest {
    @After
    fun tearDown() {
        LinkBanner.__resetForTesting()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun showsBothLinesOnTheForegroundActivityAndHides() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        LinkBanner.install(ApplicationProvider.getApplicationContext())
        LinkBanner.activityProvider = { activity }
        LinkBanner.show(47)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(47, LinkBanner.visibleNumber)
        assertEquals(
            "Linking to Everframe · 47\nA teammate is linking a device. If that's not you, ignore this.",
            LinkBanner.attachedText?.toString(),
        )

        // Paused: detached, still wanted; resumed: back.
        controller.pause()
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(LinkBanner.attachedText)
        assertEquals(47, LinkBanner.visibleNumber)
        controller.resume()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(true, LinkBanner.attachedText?.startsWith("Linking to Everframe · 47"))

        LinkBanner.hide()
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(LinkBanner.visibleNumber)
        assertNull(LinkBanner.attachedText)
    }

    @Test
    fun showWithoutAnActivityAttachesOnTheNextResume() {
        LinkBanner.install(ApplicationProvider.getApplicationContext())
        LinkBanner.activityProvider = { null }
        LinkBanner.show(5)
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(LinkBanner.attachedText)
        Robolectric.buildActivity(Activity::class.java).setup()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(true, LinkBanner.attachedText?.startsWith("Linking to Everframe · 5"))
    }
}
