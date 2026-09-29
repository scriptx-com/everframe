// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import dev.everframe.protocol.generated.Attachment
import dev.everframe.protocol.generated.AttachmentKind
import dev.everframe.protocol.generated.Format
import dev.everframe.protocol.generated.VOpAdd
import dev.everframe.protocol.generated.VOpSet
import dev.everframe.protocol.generated.VTreeTimeline
import dev.everframe.protocol.generated.VTreeVersion
import dev.everframe.transport.ReportSubmitter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.security.MessageDigest
import java.util.Base64

/** Narrow wire adapter for Flutter's already-masked image-only VTree export. */
internal object FlutterVTreeAttachment {
    private const val MAX_BYTES = 8 * 1024 * 1024
    private val json = Json { ignoreUnknownKeys = false }

    fun build(bytes: ByteArray): Pair<Attachment, ReportSubmitter.Attachment>? = runCatching {
        require(bytes.size in 1..MAX_BYTES)
        val root = json.parseToJsonElement(bytes.decodeToString()).jsonObject
        require(root.keys == setOf("version", "viewport", "frames", "originEpochMs", "assets"))
        require(root.getValue("viewport").jsonObject.keys == setOf("width", "height", "scale"))
        root.getValue("frames").jsonArray.forEachIndexed { index, frame ->
            val entry = frame.jsonObject
            require(entry.keys == setOf("timestamp", "ops"))
            entry.getValue("ops").jsonArray.forEach { op ->
                val fields = op.jsonObject
                if (index == 0) {
                    require(fields.keys == setOf("op", "parent", "index", "node"))
                    val node = fields.getValue("node").jsonObject
                    require(node.keys == setOf("id", "role", "frame", "imageRef", "children"))
                    require(node.getValue("frame").jsonObject.keys == setOf("x", "y", "w", "h"))
                } else {
                    require(fields.keys == setOf("op", "id", "imageRef"))
                }
            }
        }
        root.getValue("assets").jsonObject.values.forEach { asset ->
            require(asset.jsonObject.keys == setOf("mime", "w", "h", "b64"))
        }
        val timeline = json.decodeFromString(VTreeTimeline.serializer(), bytes.decodeToString())
        require(timeline.version == VTreeVersion.EverframeV1)
        val originEpochMs = timeline.originEpochMs
        require(originEpochMs == null || (originEpochMs.isFinite() && originEpochMs >= 0))
        require(timeline.frames.size in 1..151)
        require(timeline.viewport.scale == 1.0)
        require(timeline.viewport.width > 0 && timeline.viewport.height > 0)
        val assets = requireNotNull(timeline.assets)
        require(assets.isNotEmpty())
        val used = mutableSetOf<String>()
        var lastTime = -1.0
        timeline.frames.forEachIndexed { index, frame ->
            require(frame.timestamp.isFinite() && frame.timestamp >= lastTime && frame.timestamp <= 30_000.0)
            lastTime = frame.timestamp
            if (index == 0) {
                require(frame.timestamp == 0.0 && frame.ops.size == 1)
                val op = frame.ops.single() as VOpAdd
                require(op.parent == "" && op.index == 0L)
                require(op.node.id == "flutter-root" && op.node.role == "image" && op.node.children.isEmpty())
                require(op.node.text == null && op.node.frame.w == timeline.viewport.width &&
                    op.node.frame.h == timeline.viewport.height &&
                    op.node.frame.x == 0.0 && op.node.frame.y == 0.0)
                used += requireNotNull(op.node.imageRef)
            } else {
                require(frame.ops.size <= 1)
                frame.ops.forEach { op ->
                    require(op is VOpSet && op.id == "flutter-root")
                    used += requireNotNull(op.imageRef)
                    require(op.text == null && op.bg == null && op.frame == null)
                }
            }
        }
        require(used == assets.keys)
        assets.forEach { (key, asset) ->
            require(key.matches(Regex("[0-9a-f]{16}")) && asset.mime == "image/png")
            val png = Base64.getDecoder().decode(asset.b64)
            require(png.size >= 24 && png.take(8) == listOf(137.toByte(), 80.toByte(), 78.toByte(),
                71.toByte(), 13.toByte(), 10.toByte(), 26.toByte(), 10.toByte()))
            val width = java.nio.ByteBuffer.wrap(png, 16, 4).int
            val height = java.nio.ByteBuffer.wrap(png, 20, 4).int
            require(width in 1..2048 && height in 1..2048)
            require(asset.w == width.toDouble() && asset.h == height.toDouble())
            require(width.toDouble() == timeline.viewport.width && height.toDouble() == timeline.viewport.height)
            require(sha256(png).take(16) == key)
        }
        val hash = sha256(bytes)
        Pair(Attachment(
            byteLength = bytes.size.toDouble(), contentType = "application/octet-stream",
            durationMS = lastTime, format = Format.EverframeVtreeV1,
            kind = AttachmentKind.SessionReplay, partName = "replay", sha256 = hash,
            replayStartEpochMS = timeline.originEpochMs,
        ), ReportSubmitter.Attachment("replay", "replay.json", "application/octet-stream", bytes, hash))
    }.getOrNull()

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
