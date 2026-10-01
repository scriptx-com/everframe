// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.graphics.Bitmap
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class HostImageVTreeAttachmentTest {
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun png(color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(4, 2, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun timeline(secretText: String? = null, rootId: String = "flutter-root"): ByteArray {
        val first = png(0xff00ff00.toInt())
        val second = png(0xff0000ff.toInt())
        val a = sha(first).take(16)
        val b = sha(second).take(16)
        return """{"version":"everframe-vtree-v1","originEpochMs":12345,"viewport":{"width":4,"height":2,"scale":1},
          "frames":[{"timestamp":0,"ops":[{"op":"add","parent":"","index":0,
          "node":{"id":"$rootId","role":"image","frame":{"x":0,"y":0,"w":4,"h":2},
          "imageRef":"$a","children":[]${secretText?.let { ",\"text\":\"$it\"" } ?: ""}}}]},
          {"timestamp":200,"ops":[{"op":"set","id":"$rootId","imageRef":"$b"}]}],
          "assets":{"$a":{"mime":"image/png","w":4,"h":2,"b64":"${Base64.getEncoder().encodeToString(first)}"},
          "$b":{"mime":"image/png","w":4,"h":2,"b64":"${Base64.getEncoder().encodeToString(second)}"}}}""".toByteArray()
    }

    @Test fun `accepts image-only masked timeline as replay attachment`() {
        val bytes = timeline()
        val pair = HostImageVTreeAttachment.build(bytes)
        assertNotNull(pair)
        assertEquals("replay", pair!!.first.partName)
        assertEquals("application/octet-stream", pair.first.contentType)
        assertEquals(12345.0, pair.first.replayStartEpochMS)
        assertEquals(bytes.toList(), pair.second.data.toList())
        assertEquals(sha(bytes), pair.first.sha256)
    }

    @Test fun `rejects text payload and corruption`() {
        assertNull(HostImageVTreeAttachment.build(timeline(secretText = "private")))
        val corrupt = timeline().decodeToString().replace("everframe-vtree-v1", "unknown-v1").toByteArray()
        assertNull(HostImageVTreeAttachment.build(corrupt))
    }

    @Test fun `accepts KMP root but rejects unknown root`() {
        assertNotNull(HostImageVTreeAttachment.build(timeline(rootId = "kmp-root")))
        assertNull(HostImageVTreeAttachment.build(timeline(rootId = "unknown-root")))
    }
}
