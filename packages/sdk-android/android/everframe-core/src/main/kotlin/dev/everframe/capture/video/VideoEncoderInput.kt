// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat

/** All lifecycle calls and accepted pixel access run exclusively on the capture worker. */
internal interface VideoEncoderInput : AutoCloseable {
    fun configure(format: MediaFormat, size: VideoSize): Boolean
    fun onCodecConfigured(codec: MediaCodec): Boolean
    fun submit(codec: MediaCodec, frame: SafeVideoFrame, ptsUs: Long): Boolean
    fun signalEndOfInput(codec: MediaCodec)
}

/** Constant-space rolling diagnostic samples, never pixels or frame references. */
internal class VideoEncoderTimings {
    class Counter {
        private val values = LongArray(256)
        private var count = 0L
        @Synchronized fun add(ns: Long) { values[(count % values.size).toInt()] = ns.coerceAtLeast(0); count++ }
        @Synchronized fun snapshot(): LongArray = values.copyOf(minOf(count,values.size.toLong()).toInt())
    }
    val rgbReadNs = Counter()
    val yuvConversionNs = Counter()
    val textureUploadNs = Counter()
    val inputSubmissionNs = Counter()
    val outputDrainNs = Counter()
}

/** A dequeued slot must be released by terminating the codec, without queuing rejected pixels. */
internal class VideoInputRejected : RuntimeException()

/** Narrow platform boundary for deterministic input-slot ownership checks. */
internal interface VideoYuvInputPort {
    fun dequeue(): Int
    fun image(index: Int): android.media.Image?
    fun queue(index: Int, size: Int, ptsUs: Long)
}
private class AndroidYuvInputPort(private val codec: MediaCodec): VideoYuvInputPort {
    override fun dequeue() = codec.dequeueInputBuffer(0)
    override fun image(index: Int) = codec.getInputImage(index)
    override fun queue(index: Int, size: Int, ptsUs: Long) = codec.queueInputBuffer(index,0,size,ptsUs,0)
}

internal class FlexibleYuvVideoEncoderInput(private val timings: VideoEncoderTimings) : VideoEncoderInput {
    private var size: VideoSize? = null
    private var rgb: IntArray? = null
    override fun configure(format: MediaFormat, size: VideoSize): Boolean {
        this.size = size
        rgb = IntArray(size.width * size.height)
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        return true
    }
    override fun onCodecConfigured(codec: MediaCodec) = true
    override fun submit(codec: MediaCodec, frame: SafeVideoFrame, ptsUs: Long) = submit(AndroidYuvInputPort(codec),frame,ptsUs)
    internal fun submit(input: VideoYuvInputPort, frame: SafeVideoFrame, ptsUs: Long): Boolean {
        if (!frame.isAuthorized()) return false
        var submissionNs = -System.nanoTime()
        val index = input.dequeue()
        submissionNs += System.nanoTime()
        if (index < 0) { timings.inputSubmissionNs.add(submissionNs); return false }
        // A dequeued unusable image is fatal: continuing would silently consume codec slots.
        val target = checkNotNull(size)
        val image = input.image(index)
        val planes = Yuv420Converter.planes(image,target) ?: error("Encoder has no writable flexible YUV image")
        val scratch = checkNotNull(rgb)
        var readNs = -System.nanoTime()
        if(!frame.withPixels { bitmap ->
            check(bitmap.width == target.width && bitmap.height == target.height)
            bitmap.getPixels(scratch,0,target.width,0,0,target.width,target.height)
        }) throw VideoInputRejected()
        readNs += System.nanoTime(); timings.rgbReadNs.add(readNs)
        val conversionStart = System.nanoTime()
        check(Yuv420Converter.convert(scratch,target,planes))
        timings.yuvConversionNs.add(System.nanoTime()-conversionStart)
        if(!frame.isAuthorized()) throw VideoInputRejected() // Never queue rejected image pixels.
        val queueStart = System.nanoTime()
        input.queue(index,target.width*target.height*3/2,ptsUs)
        timings.inputSubmissionNs.add(submissionNs+System.nanoTime()-queueStart)
        return true
    }
    override fun signalEndOfInput(codec: MediaCodec) {
        val index = codec.dequeueInputBuffer(0)
        if (index < 0) throw InputNotReady()
        codec.queueInputBuffer(index,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM)
    }
    override fun close() { rgb?.fill(0); rgb = null; size = null }
    class InputNotReady : RuntimeException()
}
