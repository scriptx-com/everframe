// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.vitals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SanitizeSourceTest {
    @Test
    fun `strips query and fragment, keeps origin and path, infers protocol`() {
        assertEquals(SanitizedSource("https://cdn.example.com/live/master.m3u8", "hls"), sanitizeSource("https://cdn.example.com/live/master.m3u8?token=abc#x"))
        assertEquals(SanitizedSource("https://cdn.example.com:8443/v/m.mpd", "dash"), sanitizeSource("https://cdn.example.com:8443/v/m.mpd?sig=1"))
        assertEquals(SanitizedSource("http://h/a.mp4", "progressive"), sanitizeSource("http://h/a.mp4"))
        assertEquals(SanitizedSource("https://h/x.bin", "unknown"), sanitizeSource("https://h/x.bin"))
    }

    @Test
    fun `keepQuery retains the query but never the fragment`() {
        assertEquals("https://h/m.m3u8?token=abc", sanitizeSource("https://h/m.m3u8?token=abc#frag", keepQuery = true).src)
    }

    @Test
    fun `local schemes collapse to the scheme, junk is unknown`() {
        assertEquals(SanitizedSource("content:", "unknown"), sanitizeSource("content://media/external/video/1"))
        assertEquals(SanitizedSource("file:", "unknown"), sanitizeSource("file:///sdcard/a.mp4"))
        assertEquals(SanitizedSource("asset:", "unknown"), sanitizeSource("asset:///clip.mp4"))
        assertEquals(SanitizedSource("unknown", "unknown"), sanitizeSource("not a url"))
        assertEquals(SanitizedSource("unknown", "unknown"), sanitizeSource(null))
        assertEquals(SanitizedSource("unknown", "unknown"), sanitizeSource("rtsp://h/s"))
    }

    @Test
    fun `protocolForMime`() {
        assertEquals("hls", protocolForMime("application/x-mpegURL"))
        assertEquals("hls", protocolForMime("application/vnd.apple.mpegurl"))
        assertEquals("dash", protocolForMime("application/dash+xml"))
        assertEquals("progressive", protocolForMime("video/mp4"))
        assertNull(protocolForMime(null)); assertNull(protocolForMime("text/plain"))
    }

    @Test
    fun `userinfo must never leak`() {
        assertEquals("https://h/p", sanitizeSource("https://user:pw@h/p?token=1").src)
        assertEquals("https://h:8443/p?x=1", sanitizeSource("https://user:pw@h:8443/p?x=1#f", keepQuery = true).src)
    }

    @Test
    fun `uppercase extension inferred correctly`() {
        assertEquals("hls", sanitizeSource("https://h/M.M3U8").protocol)
    }

    @Test
    fun `protocolForPath direct calls`() {
        assertEquals("dash", protocolForPath("/a/b.mpd"))
        assertEquals("unknown", protocolForPath("/noext"))
        assertEquals("progressive", protocolForPath("/x.MP4"))
    }
}
