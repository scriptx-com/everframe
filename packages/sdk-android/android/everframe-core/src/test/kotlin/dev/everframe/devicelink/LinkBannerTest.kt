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

    @Test
    fun theBannerRidesAboveAnSdkWindowAndComesBackWhenItCloses() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        LinkBanner.install(ApplicationProvider.getApplicationContext())
        LinkBanner.activityProvider = { activity }
        LinkBanner.show(47)
        shadowOf(Looper.getMainLooper()).idle()
        val activityToken = activity.window.decorView.windowToken
        assertEquals(activityToken, LinkBanner.attachedToken)

        // The reporter opens over the Activity (a full-screen app window of its own).
        val dialog = android.app.Dialog(activity).apply { show() }
        shadowOf(Looper.getMainLooper()).idle()
        val handle = SdkOverlayWindows.shown(dialog.window!!)
        shadowOf(Looper.getMainLooper()).idle()
        val dialogToken = dialog.window!!.decorView.windowToken
        assertEquals("the banner stayed below the reporter", dialogToken, LinkBanner.attachedToken)
        assertEquals(true, LinkBanner.attachedText?.startsWith("Linking to Everframe · 47"))
        assertEquals(true, dialog.isShowing)

        // The reporter closes: the banner is back on the Activity, still showing.
        handle.close()
        dialog.dismiss()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(activityToken, LinkBanner.attachedToken)
        assertEquals(47, LinkBanner.visibleNumber)
        assertEquals(true, SdkOverlayWindows.current.isEmpty())
    }

    @Test
    fun aBannerShownWhileAnSdkWindowIsOpenStartsAboveIt() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        LinkBanner.install(ApplicationProvider.getApplicationContext())
        LinkBanner.activityProvider = { activity }
        val dialog = android.app.Dialog(activity).apply { show() }
        shadowOf(Looper.getMainLooper()).idle()
        val handle = SdkOverlayWindows.shown(dialog.window!!)
        LinkBanner.show(12)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(dialog.window!!.decorView.windowToken, LinkBanner.attachedToken)
        handle.close()
        dialog.dismiss()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun anSdkWindowOfAPausedActivityNeverHostsTheBanner() {
        LinkBanner.install(ApplicationProvider.getApplicationContext())
        val first = Robolectric.buildActivity(Activity::class.java).setup()
        val dialog = android.app.Dialog(first.get()).apply { show() }
        shadowOf(Looper.getMainLooper()).idle()
        // The reporter stays mounted in the first Activity while a second one comes to the foreground.
        val handle = SdkOverlayWindows.shown(dialog.window!!)
        first.pause()
        val second = Robolectric.buildActivity(Activity::class.java).setup().get()
        LinkBanner.activityProvider = { second }
        LinkBanner.show(47)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("the banner attached to the hidden reporter", second.window.decorView.windowToken, LinkBanner.attachedToken)
        handle.close()
        dialog.dismiss()
        shadowOf(Looper.getMainLooper()).idle()
    }
}
