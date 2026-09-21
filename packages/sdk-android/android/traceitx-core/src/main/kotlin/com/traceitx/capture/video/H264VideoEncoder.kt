// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** A vendor call cannot be force-freed safely. Quarantine is process-lifetime, without replacement threads. */
internal class VideoEncoderWorkerAdmission {
    private var occupied: Ticket? = null
    private var quarantined = false
    @Synchronized fun acquire(): Ticket? = if(quarantined || occupied != null) null else Ticket().also{occupied=it}
    inner class Ticket internal constructor(): AutoCloseable {
        fun quarantine() = synchronized(this@VideoEncoderWorkerAdmission) { if(occupied === this) quarantined=true }
        override fun close() = synchronized(this@VideoEncoderWorkerAdmission) { if(occupied === this) occupied=null }
    }
    companion object { val process=VideoEncoderWorkerAdmission() }
}

internal interface VideoEncoderBackend : AutoCloseable {
    fun prepare(size:VideoSize,fps:Int):VideoSize?
    fun submit(frame:SafeVideoFrame,ptsUs:Long):Boolean
    fun endInput():Boolean
    fun poll(): Output?
    fun release(index:Int)
    fun requestSync()
    sealed class Output {
        class Format(val format:MediaFormat):Output()
        class Sample(val index:Int,val bytes:ByteBuffer,val info:MediaCodec.BufferInfo):Output()
    }
}

/** Explicit candidate only: no startup, capability advertisement, or reporting integration. */
internal class H264VideoEncoder(
    private val owner:VideoOwner,
    private val directory:File,
    private val retentionUs:Long,
    private val scheduler:VideoCaptureScheduler=AndroidVideoCaptureScheduler,
    val timings:VideoEncoderTimings=VideoEncoderTimings(),
    private val admission:VideoEncoderWorkerAdmission=VideoEncoderWorkerAdmission.process,
    val timeAnchor:VideoTimeAnchor=VideoTimeAnchor(System.currentTimeMillis(),scheduler.nowNanos()),
    private val storeFactory:(VideoTimeAnchor,Long)->VideoSegmentStore = { anchor,privacy ->
        VideoSegmentStore(directory,owner,retentionUs,anchor,privacy)
    },
    private val backendFactory:()->VideoEncoderBackend = { AndroidH264Backend(FlexibleYuvVideoEncoderInput(timings)) },
    // Only evidence age uses this clock. Codec deadlines/watchdogs always use the live scheduler.
    private val retentionTimeNanos:()->Long = scheduler::nowNanos,
) : AutoCloseable {
    private val cancelled=AtomicBoolean()
    private val finishing=AtomicBoolean()
    private val terminal=CountDownLatch(1)
    private val result=AtomicReference<List<VideoSegment>>(emptyList())
    private val privacyGeneration=VideoPrivacyRevocation.current
    private var ticket:VideoEncoderWorkerAdmission.Ticket?=null
    private var backend:VideoEncoderBackend?=null
    private var store:VideoSegmentStore?=null
    private var format:MediaFormat?=null
    private var inflight=0
    private var lastInput=Long.MIN_VALUE
    private var lastOutput=Long.MIN_VALUE
    private var lastProgress=0L
    private var lastSync=Long.MIN_VALUE
    private var eosQueued=false
    private var finishAt=Long.MAX_VALUE
    private var cancelPoll:(()->Unit)?=null
    private var disposed=false
    /** Admission has ended; finish() still owns the bounded cleanup wait and retained-history transfer. */
    val isTerminal: Boolean get() = synchronized(this) { disposed }

    /** Call from a background control executor, never main or the capture worker. Bounded at 3 seconds. */
    fun prepare(size:VideoSize,fps:Int):VideoSize? {
        check(!scheduler.isWorkerThread())
        synchronized(this) {
            if(fps !in listOf(5,10) || retentionUs <= 0 || cancelled.get() || finishing.get() || disposed || ticket != null) return null
            ticket=admission.acquire() ?: return null
        }
        val ready=CountDownLatch(1);val prepared=AtomicReference<VideoSize?>()
        scheduler.worker {
            guarded(3_000) {
                if(!authorized()) return@guarded
                backend=backendFactory()
                prepared.set(backend!!.prepare(size,fps))
                if(prepared.get() != null && authorized()) store=storeFactory(timeAnchor,privacyGeneration)
                else { prepared.set(null);cancelled.set(true);dispose(false) }
            }
            ready.countDown()
        }
        if(!ready.await(3_000,TimeUnit.MILLISECONDS)) { quarantine();return null }
        return prepared.get().takeUnless{cancelled.get()}
    }

    /** Synchronous worker admission; the capture lease stays owned through conversion/input consumption. */
    fun offer(frame:SafeVideoFrame):Boolean {
        check(scheduler.isWorkerThread())
        var accepted=false
        try {
            guarded(1_000) {
                if(!authorized() || finishing.get() || frame.owner != owner ||
                    frame.privacyGeneration != privacyGeneration || !frame.isAuthorized() || backend == null || inflight >= 16) return@guarded
                val pts=timeAnchor.ptsUs(frame.captureTimeNanos)
                if(pts < 0 || pts <= lastInput) return@guarded
                drain()
                if(!authorized()) return@guarded
                if(backend!!.submit(frame,pts)) {
                    lastInput=pts;accepted=true
                    if(inflight++ == 0) lastProgress=nowMs()
                    if(store?.needsSync(pts) == true && (lastSync == Long.MIN_VALUE || pts-lastSync >= 500_000)) {
                        backend!!.requestSync();lastSync=pts
                    }
                }
                schedulePoll()
            }
        } finally { frame.close() }
        return accepted && !cancelled.get()
    }

    /** Independent caller deadline. Results transfer after EOS or local input rejection, muxer close, and codec teardown. */
    fun finish(deadlineElapsedMs:Long):List<VideoSegment> {
        check(!scheduler.isWorkerThread())
        if(finishing.compareAndSet(false,true)) {
            finishAt=minOf(deadlineElapsedMs,nowMs()+3_000)
            scheduler.worker { guarded(3_000) { tick() } }
        }
        val remaining=(minOf(deadlineElapsedMs,finishAt)-nowMs()).coerceAtLeast(0)
        if(!terminal.await(remaining,TimeUnit.MILLISECONDS)) { quarantine();return emptyList() }
        val segments=result.getAndSet(emptyList())
        if(!authorized()) { scheduler.worker{segments.forEach{it.close()}};return emptyList() }
        return segments
    }
    override fun close() {
        if(synchronized(this) { cancelled.compareAndSet(false,true) }) scheduler.worker { guarded(3_000) {
            dispose(false)
            result.getAndSet(emptyList()).forEach{it.close()}
        } }
    }
    private fun authorized() = !cancelled.get() && VideoPrivacyRevocation.permits(privacyGeneration)
    private fun nowMs()=scheduler.nowNanos()/1_000_000
    private fun quarantine() {
        val first=synchronized(this) { ticket?.quarantine();cancelled.compareAndSet(false,true) }
        if(first) scheduler.worker {
            result.getAndSet(emptyList()).forEach{it.close()}
            if(!disposed) guarded(3_000) {dispose(false)}
        }
    }
    private fun guarded(timeout:Long,block:()->Unit) {
        check(scheduler.isWorkerThread())
        val cancelWatchdog=scheduler.later(timeout) { quarantine() }
        try {block()} catch(_:VideoInputRejected) {
            // Stop releases the dequeued slot. Local gaps preserve already-written safe GOPs;
            // global revocation still makes authorized() false and discards all history.
            dispose(authorized())
        } catch(_:Throwable) {cancelled.set(true)} finally {
            // Keep watchdog armed across stop/release: those vendor methods may hang too.
            if(!authorized()) { cancelled.set(true);if(!disposed) dispose(false) }
            cancelWatchdog()
        }
    }
    private fun schedulePoll() {
        if(cancelPoll != null || disposed || (!finishing.get() && inflight == 0)) return
        cancelPoll=scheduler.later(10) {
            scheduler.worker { cancelPoll=null;guarded(if(finishing.get()) 3_000 else 1_000) {tick()} }
        }
    }
    private fun tick() {
        if(disposed) return
        if(!authorized() || nowMs() >= finishAt) {cancelled.set(true);dispose(false);return}
        if(finishing.get() && !eosQueued) eosQueued=backend?.endInput() ?: true
        drain()
        if(disposed) return
        if(inflight > 0 && nowMs()-lastProgress >= 1_000) {cancelled.set(true);dispose(false);return}
        if(backend == null && finishing.get()) dispose(false) else schedulePoll()
    }
    private fun drain() {
        val codec=backend ?: return
        val started=System.nanoTime()
        try {
            repeat(16) {
                if(!authorized()) {cancelled.set(true);return}
                when(val output=codec.poll() ?: return) {
                    is VideoEncoderBackend.Output.Format -> {
                        val f=output.format
                        check(f.getInteger(MediaFormat.KEY_COLOR_STANDARD)==MediaFormat.COLOR_STANDARD_BT709)
                        check(f.getInteger(MediaFormat.KEY_COLOR_RANGE)==MediaFormat.COLOR_RANGE_LIMITED)
                        check(f.getInteger(MediaFormat.KEY_COLOR_TRANSFER)==MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
                        check(!f.containsKey(MediaFormat.KEY_PROFILE) || f.getInteger(MediaFormat.KEY_PROFILE)==MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                        VideoCodecFormat.from(f);format=f
                    }
                    is VideoEncoderBackend.Output.Sample -> {
                        var eos=false
                        try {
                            val info=output.info
                            if(info.size>0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                                check(info.presentationTimeUs > lastOutput && info.presentationTimeUs <= lastInput)
                                lastOutput=info.presentationTimeUs;inflight=(inflight-1).coerceAtLeast(0);lastProgress=nowMs()
                                if(authorized()) store?.append(output.bytes,info,checkNotNull(format))
                            }
                            if(info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                                check(finishing.get());eos=true
                            }
                        } finally {codec.release(output.index)}
                        if(eos) {dispose(authorized());return}
                    }
                }
            }
        } finally {timings.outputDrainNs.add(System.nanoTime()-started)}
    }
    private fun dispose(export:Boolean) {
        synchronized(this) {if(disposed) return;disposed=true}
        cancelPoll?.invoke();cancelPoll=null
        var frozen=emptyList<VideoSegment>()
        var clean=true
        fun failed() {clean=false;cancelled.set(true);ticket?.quarantine()}
        try {
            try {
                if(export && authorized()) {
                    store?.trim(timeAnchor.ptsUs(retentionTimeNanos()))
                    frozen=store?.freeze().orEmpty()
                }
            } catch(_:Throwable) {failed()}
            // Each owned resource gets its teardown even if a preceding cleanup failed.
            try {store?.close()} catch(_:Throwable) {failed()} finally {store=null}
            try {backend?.close()} catch(_:Throwable) {failed()} finally {backend=null}
            if(clean && export && authorized()) {result.set(frozen);frozen=emptyList()}
        } finally {
            frozen.forEach {try{it.close()}catch(_:Throwable){failed()}}
            ticket?.close();terminal.countDown()
        }
    }
}

internal class AndroidH264Backend(private val input:VideoEncoderInput):VideoEncoderBackend {
    private var codec:MediaCodec?=null
    override fun prepare(size:VideoSize,fps:Int):VideoSize? {
        if(Build.VERSION.SDK_INT < 29) return null
        for(info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter{it.isEncoder}.take(32)) {
            if(!info.supportedTypes.any{it.equals("video/avc",true)}) continue
            val caps=info.getCapabilitiesForType("video/avc")
            if(caps.profileLevels.none{it.profile==MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline}) continue
            val video=caps.videoCapabilities ?: continue
            val wa=lcmEven(video.widthAlignment);val ha=lcmEven(video.heightAlignment)
            val width=size.width/wa*wa;val height=size.height/ha*ha
            if(width<2 || height<2 || !video.areSizeAndRateSupported(width,height,fps.toDouble())) continue
            val aligned=VideoSize(width,height)
            val f=MediaFormat.createVideoFormat("video/avc",width,height).apply {
                setInteger(MediaFormat.KEY_BIT_RATE,1_500_000);setInteger(MediaFormat.KEY_FRAME_RATE,fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL,2);setInteger(MediaFormat.KEY_PROFILE,MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                setInteger(MediaFormat.KEY_MAX_B_FRAMES,0)
                setInteger(MediaFormat.KEY_COLOR_STANDARD,MediaFormat.COLOR_STANDARD_BT709)
                setInteger(MediaFormat.KEY_COLOR_RANGE,MediaFormat.COLOR_RANGE_LIMITED)
                setInteger(MediaFormat.KEY_COLOR_TRANSFER,MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
            }
            if(!input.configure(f,aligned) || !caps.isFormatSupported(f)) {input.close();continue}
            // Keep ownership installed before any potentially blocking configure/start call.
            codec=MediaCodec.createByCodecName(info.name)
            codec!!.configure(f,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE)
            check(input.onCodecConfigured(codec!!));codec!!.start()
            return aligned
        }
        return null
    }
    private fun lcmEven(alignment:Int)=if(alignment%2==0) alignment else alignment*2
    override fun submit(frame:SafeVideoFrame,ptsUs:Long)=input.submit(checkNotNull(codec),frame,ptsUs)
    override fun endInput():Boolean = try {input.signalEndOfInput(checkNotNull(codec));true} catch(_:FlexibleYuvVideoEncoderInput.InputNotReady){false}
    override fun poll():VideoEncoderBackend.Output? {
        val c=checkNotNull(codec);val info=MediaCodec.BufferInfo();val index=c.dequeueOutputBuffer(info,0)
        return when {
            index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> VideoEncoderBackend.Output.Format(c.outputFormat)
            index>=0 -> VideoEncoderBackend.Output.Sample(index,c.getOutputBuffer(index) ?: ByteBuffer.allocate(0),info)
            else -> null
        }
    }
    override fun release(index:Int) {codec?.releaseOutputBuffer(index,false)}
    override fun requestSync() {codec?.setParameters(Bundle().apply{putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME,0)})}
    override fun close() {
        val c=codec;codec=null
        try {if(c != null) try{c.stop()}finally{c.release()}} finally {input.close()}
    }
}
