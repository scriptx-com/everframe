// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.media3

import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Media3IntegrationContractTest {
    @Test
    fun `attach emits nothing, detach removes every listener, snapshot never throws`() {
        val facade = FakeFacade()
        val ctx = RecordingContext { 0L }
        val i = Media3Integration(facade, { false }, { it.run(); true }, { 0L })
        assertTrue(i.attach(ctx)); assertEquals(0, ctx.emitted.size)
        assertTrue(i.library.length <= 32)
        i.detach(); assertNull(facade.listener)
        i.snapshot { assertNull(it); false }
        val throwing = object : Media3PlayerFacade by facade { override fun readState(): Media3PlayerState = error("released") }
        val j = Media3Integration(throwing, { false }, { it.run(); true }, { 0L })
        j.attach(ctx)
        // `throwing` delegates addAnalyticsListener() to `facade`, so `j`'s listener is
        // reachable as `facade.listener`. Drive a real transition so `lastSource` is non-null
        // and snapshot() actually reaches the throwing readState() below, instead of short-
        // circuiting on the null-lastSource fast path. onItem() itself calls
        // readState().isLive inside runCatching, so the transition still succeeds (live=false).
        facade.listener!!.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        j.snapshot { assertNull(it); false }
    }
}
