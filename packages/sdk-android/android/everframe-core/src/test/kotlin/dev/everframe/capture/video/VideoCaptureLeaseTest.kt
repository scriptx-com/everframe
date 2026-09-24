// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import org.junit.Assert.*
import org.junit.Test

class VideoCaptureLeaseTest {
    private val owner = VideoOwner("session", "A")
    @Test fun quarantineBlocksEveryNewManagerUntilActualCompletion() {
        val first = VideoCaptureLease().tryAcquire(owner, VideoSize(854, 480))!!
        first.quarantine()
        repeat(100) { assertNull(VideoCaptureLease().tryAcquire(owner.copy(captureId = "$it"), VideoSize(2, 2))) }
        first.complete()
        val next = VideoCaptureLease().tryAcquire(owner, VideoSize(2, 2))!!
        first.complete() // stale completion must not free successor
        assertNull(VideoCaptureLease().tryAcquire(owner, VideoSize(2, 2)))
        next.complete()
    }
    @Test fun dimensionsAreEvenAndBounded() {
        listOf(855 to 2, 2 to 855, 853 to 2, 0 to 2, -2 to 2).forEach { (w,h) ->
            try { VideoSize(w,h); fail("accepted $w x $h") } catch (_: IllegalArgumentException) { }
        }
        assertEquals(854, VideoSize(854, 854).width)
    }
}
