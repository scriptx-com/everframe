// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The mode rule (wire contract, "Device behavior summary"), one row per test,
// and the gesture entry point.

package dev.everframe.quickcapture

import dev.everframe.devicelink.DeviceLink
import dev.everframe.devicelink.DeviceLinkOwner
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureGestureTest {
    private fun input(
        qc: Boolean = true,
        linking: Boolean = true,
        link: DeviceLinkOwner? = null,
        debug: Boolean = false,
        tv: Boolean = false,
        reporter: Boolean = true,
    ) = GestureInput(qc, linking, link, debug, tv, reporter)

    @After
    fun tearDown() {
        CaptureGesture.__resetForTesting()
        DeviceLink.__resetForTesting()
    }

    @Test
    fun linkedUserCapturesOnly() = assertEquals(
        GestureDecision(capture = true, sendHello = false, openReporter = false, swallowKeys = true),
        CaptureGesture.decide(input(link = DeviceLinkOwner.User("A"))),
    )

    @Test
    fun linkedTeamCapturesOnly() =
        assertEquals(GestureDecision(true, false, false, true), CaptureGesture.decide(input(link = DeviceLinkOwner.Team)))

    @Test
    fun linkedWithLinkingDisabledStillCaptures() =
        assertEquals(GestureDecision(true, false, false, true), CaptureGesture.decide(input(linking = false, link = DeviceLinkOwner.Team)))

    @Test
    fun unlinkedDebugCapturesSharedAndHellos() =
        assertEquals(GestureDecision(true, true, false, false), CaptureGesture.decide(input(debug = true)))

    @Test
    fun unlinkedDebugWithoutLinkingCapturesOnly() =
        assertEquals(GestureDecision(true, false, false, false), CaptureGesture.decide(input(debug = true, linking = false)))

    @Test
    fun unlinkedReleasePhoneOpensReporterAndHellos() =
        assertEquals(GestureDecision(false, true, true, false), CaptureGesture.decide(input()))

    @Test
    fun unlinkedReleasePhoneReporterOffHellosSilently() =
        assertEquals(GestureDecision(false, true, false, false), CaptureGesture.decide(input(reporter = false)))

    @Test
    fun unlinkedReleaseTvHellosOnly() =
        assertEquals(GestureDecision(false, true, false, false), CaptureGesture.decide(input(tv = true)))

    @Test
    fun quickCaptureOffBehavesAsToday() {
        assertEquals(GestureDecision(false, false, true, false), CaptureGesture.decide(input(qc = false, link = DeviceLinkOwner.Team)))
        assertEquals(GestureDecision(false, false, false, false), CaptureGesture.decide(input(qc = false, tv = true)))
        assertEquals(GestureDecision(false, false, true, false), CaptureGesture.decide(input(qc = false, debug = true)))
        assertEquals(GestureDecision(false, false, false, false), CaptureGesture.decide(input(qc = false, reporter = false)))
    }

    @Test
    fun armedRule() {
        assertFalse("release unlinked, linking off", CaptureGesture.isArmed(input(linking = false)))
        assertTrue("release unlinked, linking on", CaptureGesture.isArmed(input()))
        assertTrue("debug", CaptureGesture.isArmed(input(linking = false, debug = true)))
        assertTrue("linked", CaptureGesture.isArmed(input(linking = false, link = DeviceLinkOwner.Team)))
        assertFalse("quick capture off", CaptureGesture.isArmed(input(qc = false, debug = true, link = DeviceLinkOwner.Team)))
    }

    @Test
    fun gestureBeforeLinkStateLoadsDoesNothing() {
        var captures = 0
        var hellos = 0
        CaptureGesture.captureTrigger = { captures++ }
        CaptureGesture.helloSender = { hellos++ }
        CaptureGesture.inputProvider = { input(debug = true, reporter = false) }
        assertFalse(DeviceLink.isLoaded)
        assertEquals(GestureDecision(false, false, false, false), CaptureGesture.onGesture(GestureSource.Shake))
        // Shake-to-report keeps working while the link state loads: the gesture behaves as today.
        CaptureGesture.inputProvider = { input(debug = true, reporter = true) }
        assertEquals(GestureDecision(false, false, true, false), CaptureGesture.onGesture(GestureSource.Shake))
        assertEquals(0, captures)
        assertEquals(0, hellos)
    }

    @Test
    fun gestureRunsTheDecision() {
        var captures = 0
        var hellos = 0
        CaptureGesture.captureTrigger = { captures++ }
        CaptureGesture.helloSender = { hellos++ }
        DeviceLink.__setCurrentForTesting(null, enabled = true)

        CaptureGesture.inputProvider = { input(debug = true) }
        assertEquals(GestureDecision(true, true, false, false), CaptureGesture.onGesture(GestureSource.Shake))
        assertEquals(1, captures)
        assertEquals(1, hellos)

        CaptureGesture.inputProvider = { input(link = DeviceLinkOwner.Team) }
        CaptureGesture.onGesture(GestureSource.Shake)
        assertEquals(2, captures)
        assertEquals(1, hellos)

        CaptureGesture.inputProvider = { input() }
        assertTrue(CaptureGesture.onGesture(GestureSource.Shake).openReporter)
        assertEquals(2, captures)
        assertEquals(2, hellos)
    }
}
