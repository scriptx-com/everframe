// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import org.junit.Assert.*
import org.junit.Test

class VideoPrivacyRevocationTest {
    @Test fun settlementUsesSameObserverOwnerOnlyAfterFinalIdempotentClose() {
        var oldSettled = 0; var settled = 0; var revoked = 0
        val first = VideoPrivacyRevocation.subscribe({}, { oldSettled++ })
        val second = VideoPrivacyRevocation.subscribe({ revoked++ }, { settled++ })
        first.close()
        val a = VideoPrivacyRevocation.begin(); val b = VideoPrivacyRevocation.begin()
        try {
            a.close(); a.close(); assertEquals(0, settled)
            b.close(); b.close(); assertEquals(1, settled)
            assertEquals(2, revoked); assertEquals(0, oldSettled)
            second.close(); VideoPrivacyRevocation.begin().close(); assertEquals(1, settled)
        } finally { a.close(); b.close(); first.close(); second.close() }
    }

    @Test fun replacingWithSameCallbackStillOwnsDistinctSubscription() {
        var observed = 0
        val callback: (Long) -> Unit = { observed++ }
        val first = VideoPrivacyRevocation.subscribe(callback)
        val second = VideoPrivacyRevocation.subscribe(callback)
        first.close()
        try { VideoPrivacyRevocation.begin().close(); assertEquals(1, observed) }
        finally { second.close() }
    }
    @Test fun oneObserverReplacementSurvivesStaleUnsubscribeAndTokensAreIdempotent() {
        val old = mutableListOf<Long>(); val current = mutableListOf<Long>()
        val first = VideoPrivacyRevocation.subscribe { old.add(it) }
        val second = VideoPrivacyRevocation.subscribe { current.add(it) }
        first.close()
        val before = VideoPrivacyRevocation.current
        val token = VideoPrivacyRevocation.begin()
        try {
            assertTrue(VideoPrivacyRevocation.blocked)
            assertFalse(VideoPrivacyRevocation.permits(before))
            assertEquals(listOf(VideoPrivacyRevocation.current), current)
            assertTrue(old.isEmpty())
        } finally { token.close(); token.close(); second.close() }
        assertFalse(VideoPrivacyRevocation.blocked)
        assertFalse(VideoPrivacyRevocation.permits(before))
    }
}
