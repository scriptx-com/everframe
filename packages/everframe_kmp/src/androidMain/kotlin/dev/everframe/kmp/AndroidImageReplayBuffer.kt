// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Bounded ring of PNGs already masked by the Android SDK's screenshot capture. */
internal class AndroidImageReplayBuffer(
    private val maxAgeMs: Long = 30_000,
    private val maxRawBytes: Int = 5 * 1024 * 1024,
) {
    private companion object { const val MAX_FRAMES = 151 }
    private data class Frame(val elapsedMs: Long, val width: Int, val height: Int, val png: ByteArray)

    private val startedAtEpochMs = System.currentTimeMillis()
    private val startedAtTickMs = SystemClock.elapsedRealtime()
    private val frames = ArrayDeque<Frame>()
    private var rawBytes = 0

    fun add(width: Int, height: Int, png: ByteArray): Boolean {
        if (width !in 1..2048 || height !in 1..2048 || png.size !in 24..maxRawBytes) return false
        val elapsed = SystemClock.elapsedRealtime() - startedAtTickMs
        if (elapsed < 0) return false
        val copy = png.copyOf()
        frames.addLast(Frame(elapsed, width, height, copy))
        rawBytes += copy.size
        while (frames.isNotEmpty() &&
            (frames.size > MAX_FRAMES || rawBytes > maxRawBytes || elapsed - frames.first().elapsedMs > maxAgeMs)) {
            rawBytes -= frames.removeFirst().png.size
        }
        return true
    }

    fun export(): ByteArray? = runCatching {
        require(frames.isNotEmpty())
        val first = frames.first()
        val assets = JSONObject()
        val assetBytes = mutableMapOf<String, ByteArray>()
        val timelineFrames = JSONArray()
        var previousRef: String? = null
        frames.forEachIndexed { index, frame ->
            require(frame.width == first.width && frame.height == first.height)
            val time = frame.elapsedMs - first.elapsedMs
            require(time in 0..30_000)
            val ref = sha256(frame.png).take(16)
            val prior = assetBytes[ref]
            require(prior == null || prior.contentEquals(frame.png))
            if (prior == null) {
                assetBytes[ref] = frame.png
                assets.put(ref, JSONObject()
                    .put("mime", "image/png")
                    .put("w", frame.width)
                    .put("h", frame.height)
                    .put("b64", Base64.encodeToString(frame.png, Base64.NO_WRAP)))
            }
            val ops = JSONArray()
            if (index == 0) {
                val rect = JSONObject().put("x", 0).put("y", 0)
                    .put("w", frame.width).put("h", frame.height)
                val node = JSONObject().put("id", "kmp-root").put("role", "image")
                    .put("frame", rect).put("imageRef", ref).put("children", JSONArray())
                ops.put(JSONObject().put("op", "add").put("parent", "")
                    .put("index", 0).put("node", node))
            } else if (ref != previousRef) {
                ops.put(JSONObject().put("op", "set").put("id", "kmp-root")
                    .put("imageRef", ref))
            }
            timelineFrames.put(JSONObject().put("timestamp", time).put("ops", ops))
            previousRef = ref
        }
        val viewport = JSONObject().put("width", first.width).put("height", first.height)
            .put("scale", 1)
        val encoded = JSONObject().put("version", "everframe-vtree-v1")
            .put("viewport", viewport).put("frames", timelineFrames)
            .put("originEpochMs", startedAtEpochMs + first.elapsedMs)
            .put("assets", assets).toString().toByteArray(Charsets.UTF_8)
        require(encoded.size <= 8 * 1024 * 1024)
        encoded
    }.getOrNull()

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
