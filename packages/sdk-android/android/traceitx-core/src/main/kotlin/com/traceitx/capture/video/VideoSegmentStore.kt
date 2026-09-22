// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID

/** Value identity owns bounded immutable strings, never mutable codec ByteBuffers. */
internal data class VideoCodecFormat(val mime: String, val width: Int, val height: Int, val identity: String) {
    companion object {
        fun from(format: MediaFormat): VideoCodecFormat {
            val mime = format.getString(MediaFormat.KEY_MIME) ?: error("Missing mime")
            require(mime == "video/avc")
            val width = format.getInteger(MediaFormat.KEY_WIDTH); val height = format.getInteger(MediaFormat.KEY_HEIGHT)
            VideoSize(width,height)
            val values = listOf("profile","level","color-standard","color-range","color-transfer","rotation-degrees")
                .joinToString { "$it=${if(format.containsKey(it)) format.getInteger(it) else "absent"}" }
            var bytes = 0
            val csd = (0..2).joinToString { index ->
                val source = format.getByteBuffer("csd-$index")?.duplicate()
                if(source == null) "absent" else {
                    bytes += source.remaining(); require(bytes <= 64*1024)
                    buildString { while(source.hasRemaining()) append((source.get().toInt() and 255).toString(16).padStart(2,'0')) }
                }
            }
            return VideoCodecFormat(mime,width,height,"$values;$csd")
        }
    }
}

/** Shared with future export allocations. Failed cleanup blocks new process allocations. */
internal class VideoDiskBudget(private val limit: Long = 24L*1024*1024) {
    var usedBytes = 0L; private set
    private val pendingCleanup = LinkedHashSet<VideoOwnedFile>()
    @Synchronized fun reserve(bytes: Long): Reservation? {
        require(bytes >= 0)
        if(pendingCleanup.isNotEmpty() || bytes > limit-usedBytes) return null
        usedBytes += bytes
        return Reservation(bytes)
    }
    @Synchronized internal fun retainCleanup(file: VideoOwnedFile) {
        file.reservation.accountActual(file.physicalBytes)
        pendingCleanup.add(file)
    }
    @Synchronized internal fun forgetCleanup(file: VideoOwnedFile) { pendingCleanup.remove(file) }
    /** Worker-only, bounded by already-owned files: allocation stops on the first failure. */
    fun retryCleanup() {
        val pending = synchronized(this) { pendingCleanup.toList() }
        pending.forEach { it.delete() }
    }
    inner class Reservation internal constructor(private var bytes: Long) : AutoCloseable {
        private var closed = false
        fun shrink(actual: Long) = synchronized(this@VideoDiskBudget) {
            require(!closed && actual in 0..bytes)
            usedBytes -= bytes-actual; bytes = actual
        }
        /** Account observed overrun honestly, even beyond the limit; subsequent admission fails. */
        fun accountActual(actual: Long) = synchronized(this@VideoDiskBudget) {
            require(!closed && actual >= 0)
            usedBytes += actual-bytes;bytes=actual
        }
        override fun close() = synchronized(this@VideoDiskBudget) {
            if(!closed) { closed=true; usedBytes-=bytes }
        }
    }
    companion object { val process = VideoDiskBudget() }
}

/** An undeleted artifact remains owned here and in the process retry set, including after freeze. */
internal class VideoOwnedFile(
    val path: File, val reservation: VideoDiskBudget.Reservation,
    private val budget: VideoDiskBudget, private val deleteFile: (File)->Boolean,
) {
    val physicalBytes: Long get() = path.length()
    @Synchronized fun delete(): Boolean {
        val deleted = try { !path.exists() || deleteFile(path) } catch(_:Throwable) { false }
        if(deleted) {
            reservation.close();budget.forgetCleanup(this)
        } else {
            budget.retainCleanup(this)
        }
        return deleted
    }
}

internal class VideoSegment internal constructor(
    val owner: VideoOwner, val path: File, val byteLength: Long,
    val firstPtsUs: Long, val lastPtsUs: Long, val format: VideoCodecFormat,
    val privacyGeneration: Long, val timeAnchor: VideoTimeAnchor, internal val ownedFile: VideoOwnedFile,
) : AutoCloseable {
    /** Failed deletion transfers retry ownership to the process budget, never just a leaked charge. */
    override fun close() { ownedFile.delete() }
}

/** release() failed: native ownership is uncertain even if the file can be deleted. */
internal class VideoMuxerReleaseFailure(cause: Throwable) : RuntimeException(cause)

internal interface VideoSegmentMuxer : AutoCloseable {
    fun write(sample: ByteBuffer, info: MediaCodec.BufferInfo)
}

/** Worker-confined ring. Never exports the active file or mixes incompatible formats. */
internal class VideoSegmentStore(
    private val directory: File,
    private val owner: VideoOwner,
    retentionUs: Long,
    private val timeAnchor: VideoTimeAnchor,
    private val privacyGeneration: Long = VideoPrivacyRevocation.current,
    private val budget: VideoDiskBudget = VideoDiskBudget.process,
    private val deleteFile: (File)->Boolean = { it.delete() },
    private val storageObserver: (Long, Int) -> Unit = { _, _ -> },
    private val recordingAdmission: (Long, Long, Int) -> Boolean = { _, _, _ -> true },
    private val muxerFactory: (File,MediaFormat)->VideoSegmentMuxer = { file,format -> AndroidSegmentMuxer(file,format) },
) : AutoCloseable {
    init { require(retentionUs > 0) }
    private val retentionUs = retentionUs.coerceAtMost(60_000_000L)
    private val closed = ArrayDeque<VideoSegment>()
    private val cleanup = LinkedHashSet<VideoOwnedFile>()
    private var allocationStopped = false
    private var releaseFailure: VideoMuxerReleaseFailure? = null
    private var active: Active? = null
    private var formatIdentity: VideoCodecFormat? = null
    private var lastPts = Long.MIN_VALUE
    private var frozen = false
    private class Active(val file: VideoOwnedFile,val muxer: VideoSegmentMuxer,
        val first:Long,val format:VideoCodecFormat) { var last=first;var sampleBytes=0L }
    val totalBytes: Long get() = closed.sumOf{it.ownedFile.physicalBytes} + cleanup.sumOf{it.physicalBytes} +
        (active?.let { maxOf(it.file.physicalBytes,it.sampleBytes)+CLOSE_RESERVE } ?: 0)
    val openSegments: Int get() = if(active == null) 0 else 1
    val exportableSegments: Int get() = closed.size
    fun needsSync(ptsUs: Long): Boolean = active?.let{ptsUs-it.first >= 2_000_000} ?: true

    fun append(sample: ByteBuffer, info: MediaCodec.BufferInfo, format: MediaFormat) {
        try { appendInternal(sample,info,format) } finally { observeStorage(); throwIfReleaseUncertain() }
    }
    private fun appendInternal(sample: ByteBuffer, info: MediaCodec.BufferInfo, format: MediaFormat) {
        if(frozen || allocationStopped) return
        if(!VideoPrivacyRevocation.permits(privacyGeneration)) { close(); return }
        if(info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 || info.size == 0) return
        require(info.offset >= 0 && info.size >= 0 && info.offset.toLong()+info.size <= sample.limit())
        val identity = VideoCodecFormat.from(format)
        if(formatIdentity != null && formatIdentity != identity) clearRing()
        if(allocationStopped) return
        formatIdentity = identity
        if(info.presentationTimeUs <= lastPts) { abortActive(); return }
        lastPts = info.presentationTimeUs
        val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        active?.let {
            if(key && info.presentationTimeUs-it.first >= 2_000_000) finishActive()
            else if(info.presentationTimeUs-it.first >= minOf(4_000_000,retentionUs)) abortActive()
        }
        evict(info.presentationTimeUs)
        if(allocationStopped) return
        if(active == null) {
            if(!key || info.size.toLong()+CLOSE_RESERVE >= SEGMENT_CAP) return
            while(closed.isNotEmpty() && (closed.size >= MAX_FILES-1 || totalBytes+SEGMENT_CAP > RING_CAP)) {
                discard(closed.removeFirst().ownedFile)
                if(allocationStopped) return
            }
            if (!recordingAdmission(info.presentationTimeUs, totalBytes + SEGMENT_CAP, closed.size + 1)) return
            val reservation = budget.reserve(SEGMENT_CAP) ?: return
            var file: VideoOwnedFile? = null
            try {
                check(directory.isDirectory || directory.mkdirs())
                val path = File.createTempFile("gop-${UUID.randomUUID()}-",".mp4",directory)
                file = VideoOwnedFile(path,reservation,budget,deleteFile)
                active = Active(file,muxerFactory(path,format),info.presentationTimeUs,identity)
            } catch(t:Throwable) {
                recordReleaseFailure(t)
                if(file == null) reservation.close() else discard(file)
                return
            }
        }
        val a = active ?: return
        if(maxOf(a.file.physicalBytes,a.sampleBytes)+info.size+CLOSE_RESERVE >= SEGMENT_CAP) { abortActive(); return }
        try {
            val local = MediaCodec.BufferInfo().apply { set(info.offset,info.size,info.presentationTimeUs-a.first,info.flags) }
            a.muxer.write(sample,local)
            a.sampleBytes += info.size; a.last=info.presentationTimeUs
            if(a.file.physicalBytes+CLOSE_RESERVE > SEGMENT_CAP || totalBytes > RING_CAP) abortActive()
        } catch(_:Throwable) { abortActive() }
    }
    private fun observeStorage() {
        val files = closed.map { it.ownedFile } + cleanup + listOfNotNull(active?.file)
        storageObserver(files.sumOf { it.physicalBytes }, files.size)
    }
    fun trim(nowPtsUs: Long) {
        if(frozen) return
        if(active?.let { nowPtsUs-it.first > retentionUs } == true) abortActive()
        evict(nowPtsUs)
        throwIfReleaseUncertain()
    }
    fun freeze(): List<VideoSegment> {
        if(frozen) return emptyList()
        if(!VideoPrivacyRevocation.permits(privacyGeneration) || allocationStopped) { close(); return emptyList() }
        finishActive()
        throwIfReleaseUncertain()
        if(allocationStopped) {close();return emptyList()}
        frozen=true
        return closed.toList().also{closed.clear(); observeStorage()}
    }
    private fun discard(file: VideoOwnedFile) {
        if(file.delete()) cleanup.remove(file)
        else {cleanup.add(file);allocationStopped=true}
    }
    private fun evict(now:Long) {
        while(closed.isNotEmpty() && now-closed.first().firstPtsUs > retentionUs) {
            discard(closed.removeFirst().ownedFile)
            if(allocationStopped) return
        }
    }
    private fun finishActive() {
        val a = active ?: return
        active=null
        var okay = false
        try { a.muxer.close(); okay=true } catch(t:Throwable) { recordReleaseFailure(t) }
        val length=a.file.physicalBytes
        if(!okay || length <= 0 || length > SEGMENT_CAP || !VideoPrivacyRevocation.permits(privacyGeneration)) {
            discard(a.file);return
        }
        a.file.reservation.shrink(length)
        closed.addLast(VideoSegment(owner,a.file.path,length,a.first,a.last,a.format,privacyGeneration,timeAnchor,a.file))
        while(closed.size > MAX_FILES || totalBytes > RING_CAP) {
            discard(closed.removeFirst().ownedFile)
            if(allocationStopped) return
        }
    }
    private fun abortActive() {
        val a=active ?: return;active=null
        try { a.muxer.close() } catch(t:Throwable) { recordReleaseFailure(t) }
        discard(a.file)
    }
    private fun clearRing() {
        abortActive()
        while(closed.isNotEmpty()) discard(closed.removeFirst().ownedFile)
        cleanup.toList().forEach{discard(it)}
        lastPts=Long.MIN_VALUE
    }
    private fun recordReleaseFailure(error: Throwable) {
        if(error is VideoMuxerReleaseFailure) {releaseFailure=error;allocationStopped=true}
    }
    private fun throwIfReleaseUncertain() {releaseFailure?.let{throw it}}
    override fun close() {
        clearRing();frozen=true;observeStorage()
        // Propagate only after every remaining file/muxer cleanup has been attempted.
        throwIfReleaseUncertain()
    }
    companion object {
        const val CLOSE_RESERVE=128L*1024
        const val SEGMENT_CAP=1024L*1024
        const val RING_CAP=8L*1024*1024
        const val MAX_FILES=32
    }
}

private class AndroidSegmentMuxer(file:File,format:MediaFormat):VideoSegmentMuxer {
    private val muxer=MediaMuxer(file.absolutePath,MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private val track:Int
    init {
        try {track=muxer.addTrack(format);muxer.start()} catch(t:Throwable) {
            try {muxer.release()} catch(release:Throwable) {throw VideoMuxerReleaseFailure(release).apply{addSuppressed(t)}}
            throw t
        }
    }
    override fun write(sample:ByteBuffer,info:MediaCodec.BufferInfo)=muxer.writeSampleData(track,sample,info)
    override fun close() {
        var stopFailure:Throwable?=null
        try {muxer.stop()} catch(t:Throwable) {stopFailure=t}
        try {muxer.release()} catch(t:Throwable) {
            throw VideoMuxerReleaseFailure(t).apply {stopFailure?.let{addSuppressed(it)}}
        }
        stopFailure?.let{throw it} // File may be invalid, but native release was confirmed.
    }
}
