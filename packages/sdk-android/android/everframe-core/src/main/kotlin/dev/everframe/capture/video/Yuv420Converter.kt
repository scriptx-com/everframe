// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.ImageFormat
import android.media.Image
import java.nio.ByteBuffer
import kotlin.math.roundToInt

/** BT.709 limited SDR. Validates every destination before touching codec memory. */
internal object Yuv420Converter {
    data class Plane(val buffer: ByteBuffer, val rowStride: Int, val pixelStride: Int)

    fun planes(image: Image?, size: VideoSize): List<Plane>? {
        if (image == null || image.format != ImageFormat.YUV_420_888 || image.planes.size != 3) return null
        val crop = image.cropRect
        if (crop.left != 0 || crop.top != 0 || crop.width() != size.width || crop.height() != size.height ||
            image.width < size.width || image.height < size.height) return null
        return image.planes.map { Plane(it.buffer, it.rowStride, it.pixelStride) }.takeIf { valid(size,it) }
    }

    private fun valid(size: VideoSize, planes: List<Plane>): Boolean = planes.size == 3 && planes.withIndex().all { (i,p) ->
        val width = if (i == 0) size.width else size.width / 2
        val height = if (i == 0) size.height else size.height / 2
        !p.buffer.isReadOnly && p.pixelStride in 1..2 && (i != 0 || p.pixelStride == 1) &&
            p.rowStride >= (width - 1) * p.pixelStride + 1 &&
            p.buffer.position().toLong() + (height - 1L) * p.rowStride + (width - 1L) * p.pixelStride < p.buffer.limit()
    }

    fun convert(rgb: IntArray, size: VideoSize, planes: List<Plane>): Boolean {
        if (rgb.size < size.width * size.height || !valid(size, planes)) return false
        fun put(p: Plane, x: Int, y: Int, value: Int) {
            p.buffer.put(p.buffer.position() + y * p.rowStride + x * p.pixelStride, value.toByte())
        }
        for (y in 0 until size.height step 2) for (x in 0 until size.width step 2) {
            var cb = 0.0; var cr = 0.0
            for (dy in 0..1) for (dx in 0..1) {
                val pixel = rgb[(y + dy) * size.width + x + dx]
                val r = (pixel ushr 16 and 255).toDouble()
                val g = (pixel ushr 8 and 255).toDouble()
                val b = (pixel and 255).toDouble()
                val luma = .2126 * r + .7152 * g + .0722 * b
                put(planes[0],x+dx,y+dy,(16 + 219 * luma / 255).roundToInt().coerceIn(16,235))
                cb += (b-luma) / (2 * (1-.0722))
                cr += (r-luma) / (2 * (1-.2126))
            }
            put(planes[1],x/2,y/2,(128 + 224 * cb / (4*255)).roundToInt().coerceIn(16,240))
            put(planes[2],x/2,y/2,(128 + 224 * cr / (4*255)).roundToInt().coerceIn(16,240))
        }
        return true
    }
}
