// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

data class VideoMetadata internal constructor(val size: VideoSize, val durationMs: Long,
    val replayStartEpochMs: Long, val byteLength: Long, val sha256: String)

class OwnedVideoClip internal constructor(val owner: VideoOwner, val file: File, val metadata: VideoMetadata,
    private val owned: VideoOwnedFile, private val scheduler: VideoCaptureScheduler,
    private val lease: AutoCloseable,
) : AutoCloseable {
    private val closed=AtomicBoolean()
    override fun close() {
        if(closed.compareAndSet(false,true)) {
            val cleanup:()->Unit={ try {owned.delete()} finally {lease.close()} }
            if(scheduler.isWorkerThread()) cleanup() else scheduler.worker(cleanup)
        }
    }
}

/** Short process-wide ownership transitions; startup filesystem work never holds this monitor. */
internal object VideoDirectoryLeases {
    private var count = 0
    private var cleaning = false
    @Synchronized fun acquire(): AutoCloseable {
        check(!cleaning) { "Video startup cleanup in progress" }
        count++
        val closed = AtomicBoolean()
        return AutoCloseable { synchronized(this) { if (closed.compareAndSet(false, true)) count-- } }
    }
    @Synchronized internal fun beginCleanup(): Boolean {
        if (count != 0 || cleaning) return false
        cleaning = true
        return true
    }
    @Synchronized internal fun endCleanup() { cleaning = false }
    fun cleanStartup(root: File, budget: VideoDiskBudget = VideoDiskBudget.process, startedNanos: Long = System.nanoTime()): Boolean =
        VideoStartupCleaner(budget).clean(root, startedNanos)
    internal fun recognizedArtifact(name: String): Boolean {
        val plain = name.substringBeforeLast('.')
        if ((name.endsWith(".partial") || name.endsWith(".mp4")) && validId(plain)) return true
        val match = Regex("gop-([0-9a-fA-F-]{36})-[0-9]+\\.mp4").matchEntire(name) ?: return false
        return validId(match.groupValues[1])
    }
    internal fun validId(value: String) = runCatching { UUID.fromString(value).toString() == value.lowercase() }.getOrDefault(false)
}

internal class VideoExportSizeOverflow:RuntimeException()

/** One completion winner; a losing, already-running timer cannot change publication state. */
internal class VideoOperationCompletion {
    private enum class State { PENDING, FINISHED, CANCELLED }
    @Volatile private var state=State.PENDING
    val isCancelled:Boolean get()=state==State.CANCELLED
    @Synchronized fun finish(resolve:()->Unit):Boolean {
        if(state!=State.PENDING) return false
        state=State.FINISHED
        resolve();return true
    }
    @Synchronized fun timeout(resolve:()->Unit):Boolean {
        if(state!=State.PENDING) return false
        state=State.CANCELLED
        resolve();return true
    }
}

internal data class VideoMediaInfo(val size:VideoSize,val durationUs:Long,val firstAbsolutePtsUs:Long)
internal interface VideoExportMedia {
    fun remux(segments:List<VideoSegment>,target:File,check:()->Unit):VideoMediaInfo
}

internal class VideoExporter(
    private val root:File, private val scheduler:VideoCaptureScheduler=AndroidVideoCaptureScheduler,
    private val budget:VideoDiskBudget=VideoDiskBudget.process,
    private val admission:VideoEncoderWorkerAdmission=VideoEncoderWorkerAdmission.process,
    private val media:VideoExportMedia=AndroidVideoExportMedia(),
) {
    constructor(context:Context):this(File(context.noBackupFilesDir,"everframe-video"))
    /** Consumes all supplied references, including on rejection or cancellation. */
    suspend fun export(owner:VideoOwner,segments:List<VideoSegment>,replayAllowed:()->Boolean):OwnedVideoClip? =
        suspendCancellableCoroutine { continuation ->
            val lease = try { VideoDirectoryLeases.acquire() } catch (_: IllegalStateException) {
                scheduler.worker { segments.forEach { it.close() } }
                continuation.resume(null)
                return@suspendCancellableCoroutine
            }
            val completion=VideoOperationCompletion()
            val deadline=scheduler.nowNanos()+3_000_000_000L
            var ticket:VideoEncoderWorkerAdmission.Ticket?=null
            val lock=completion
            val timer=scheduler.later(3_000) {
                completion.timeout {ticket?.quarantine();continuation.resume(null)}
            }
            continuation.invokeOnCancellation {completion.timeout {ticket?.quarantine()}}
            scheduler.worker {
                var clip:OwnedVideoClip?=null
                fun checkAllowed() {check(!completion.isCancelled && scheduler.nowNanos()<deadline && replayAllowed())}
                try {
                    checkAllowed()
                    synchronized(lock) {check(!completion.isCancelled);ticket=admission.acquire();check(ticket!=null)}
                    require(VideoDirectoryLeases.validId(owner.sessionId) && VideoDirectoryLeases.validId(owner.captureId))
                    require(segments.isNotEmpty() && segments.size<=32 && segments.all{it.owner==owner})
                    val last=segments.last()
                    var selected=segments.takeLastWhile {it.format==last.format && it.timeAnchor==last.timeAnchor &&
                        it.privacyGeneration==last.privacyGeneration}
                    require(selected.zipWithNext().all{(a,b)->a.lastPtsUs<b.firstPtsUs})
                    check(VideoPrivacyRevocation.permits(last.privacyGeneration))
                    val dir=File(File(root,owner.sessionId),owner.captureId)
                    check(dir.isDirectory || dir.mkdirs())
                    repeat(2) { attempt ->
                        if(clip==null && selected.isNotEmpty()) {
                            checkAllowed()
                            val reservation=budget.reserve(MAX_BYTES+VideoSegmentStore.CLOSE_RESERVE) ?: error("Disk budget")
                            var owned=VideoOwnedFile(File(dir,"${UUID.randomUUID()}.partial"),reservation,budget){it.delete()}
                            var transferred=false
                            try {
                                val info=try {
                                    media.remux(selected,owned.path) {checkAllowed();check(VideoPrivacyRevocation.permits(last.privacyGeneration))}
                                } catch(_:VideoExportSizeOverflow) {null}
                                checkAllowed()
                                if(info==null || owned.physicalBytes>MAX_BYTES) {
                                    if(attempt==0) selected=selected.drop(1)
                                } else {
                                    require(owned.physicalBytes>0 && info.durationUs>=1_000)
                                    reservation.shrink(owned.physicalBytes)
                                    val metadata=VideoMetadata(info.size,info.durationUs/1_000,
                                        Math.addExact(last.timeAnchor.wallEpochMs,info.firstAbsolutePtsUs/1_000),owned.physicalBytes,sha256(owned.path.readBytes()))
                                    checkAllowed();check(VideoPrivacyRevocation.permits(last.privacyGeneration))
                                    val target=File(dir,"${UUID.randomUUID()}.mp4")
                                    check(owned.path.renameTo(target))
                                    owned=VideoOwnedFile(target,reservation,budget){it.delete()}
                                    clip=OwnedVideoClip(owner,target,metadata,owned,scheduler,lease)
                                    transferred=true
                                }
                            } finally {if(!transferred) owned.delete()}
                        }
                    }
                    checkAllowed();check(VideoPrivacyRevocation.permits(last.privacyGeneration))
                } catch(t:Throwable) {
                    if(t is VideoMuxerReleaseFailure) synchronized(lock){ticket?.quarantine()}
                    clip?.close();clip=null
                } finally {
                    segments.forEach{it.close()};synchronized(lock){ticket?.close()};timer()
                }
                val result=clip
                if(!completion.finish {
                    continuation.resume(result) { _, value, _ -> value?.close() }
                }) result?.close()
                if(result==null) lease.close()
            }
        }
    companion object {const val MAX_BYTES=8L*1024*1024}
}

internal fun sha256(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}

internal class AndroidVideoExportMedia:VideoExportMedia {
    override fun remux(segments:List<VideoSegment>,target:File,check:()->Unit):VideoMediaInfo {
        require(android.os.Build.VERSION.SDK_INT>=29)
        var muxer:MediaMuxer?=null;var started=false
        var overflow:VideoExportSizeOverflow?=null
        var origin:Long?=null;var last=-1L;var actualIdentity:VideoCodecFormat?=null
        val buffer=ByteBuffer.allocateDirect(VideoSegmentStore.SEGMENT_CAP.toInt())
        try {
            for(segment in segments) {
                check()
                val extractor=MediaExtractor()
                try {
                    extractor.setDataSource(segment.path.absolutePath)
                    require(extractor.trackCount==1)
                    val format=extractor.getTrackFormat(0)
                    val actual=VideoCodecFormat.from(format)
                    require(actual.mime==segment.format.mime && actual.width==segment.format.width && actual.height==segment.format.height)
                    require(actualIdentity==null || actualIdentity==actual);actualIdentity=actual
                    extractor.selectTrack(0)
                    require(extractor.sampleTime>=0 && extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC!=0)
                    if(muxer==null) {
                        muxer=MediaMuxer(target.absolutePath,MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                        muxer.addTrack(format);muxer.start();started=true
                    }
                    do {
                        check();buffer.clear()
                        val length=extractor.readSampleData(buffer,0)
                        require(length in 1..buffer.capacity())
                        val absolute=Math.addExact(segment.firstPtsUs,extractor.sampleTime)
                        if(origin==null) origin=absolute
                        val pts=absolute-origin!!;require(pts>last);last=pts
                        val info=MediaCodec.BufferInfo().apply {set(0,length,pts,if(extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC!=0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)}
                        muxer!!.writeSampleData(0,buffer,info)
                        if(target.length()>VideoExporter.MAX_BYTES+VideoSegmentStore.CLOSE_RESERVE) {
                            throw VideoExportSizeOverflow().also{overflow=it}
                        }
                    } while(extractor.advance())
                } finally {extractor.release()}
            }
        } finally {
            val m=muxer
            if(m!=null) {
                var failure:Throwable?=null
                try {if(started)m.stop()} catch(t:Throwable){failure=t}
                try {m.release()} catch(t:Throwable){throw VideoMuxerReleaseFailure(t)}
                failure?.let {stopFailure ->
                    val sizeFailure=overflow
                    if(sizeFailure==null) throw stopFailure else sizeFailure.addSuppressed(stopFailure)
                }
            }
        }
        check()
        val extractor=MediaExtractor()
        try {
            extractor.setDataSource(target.absolutePath);require(extractor.trackCount==1)
            val format=extractor.getTrackFormat(0);extractor.selectTrack(0)
            val size=VideoSize(format.getInteger(MediaFormat.KEY_WIDTH),format.getInteger(MediaFormat.KEY_HEIGHT))
            require(extractor.sampleTime==0L && extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC!=0)
            var previous=-1L;var count=0
            do {check();require(extractor.sampleTime>previous);previous=extractor.sampleTime;count++} while(extractor.advance())
            require(format.containsKey(MediaFormat.KEY_DURATION))
            val duration=format.getLong(MediaFormat.KEY_DURATION)
            require(count>0 && duration>previous && duration>0)
            return VideoMediaInfo(size,duration,requireNotNull(origin))
        } finally {extractor.release()}
    }
}
