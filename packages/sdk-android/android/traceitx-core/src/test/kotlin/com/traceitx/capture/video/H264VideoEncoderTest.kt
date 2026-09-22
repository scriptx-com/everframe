// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.util.ArrayDeque
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(sdk=[29])
class H264VideoEncoderTest {
 private class Scheduler:VideoCaptureScheduler {
  var worker=false;var nanos=1_000_000_000L;var held=false
  val queued=ArrayDeque<()->Unit>();val timers=mutableListOf<()->Unit>()
  override fun main(block:()->Unit)=block()
  override fun worker(block:()->Unit) {if(held) queued.add(block) else {val was=worker;worker=true;try{block()}finally{worker=was}}}
  override fun later(delayMs:Long,block:()->Unit):()->Unit {timers+=block;return {timers.remove(block);Unit}}
  override fun isWorkerThread()=worker
  override fun nowNanos()=nanos
  fun turn(){val next=timers.toList();timers.clear();next.forEach{it()}}
 }
 private class Backend:VideoEncoderBackend {
  var submissions=0;var released=0;var closed=false;var ready=true;var outputPts=0L;var failClose=false
  var queueOutput=true;var end=true;var eosSent=false
  var input:((SafeVideoFrame,Long)->Boolean)?=null;var afterClose:(()->Unit)?=null;var sampleFlags=0
  val outputs=ArrayDeque<VideoEncoderBackend.Output>()
  override fun prepare(size:VideoSize,fps:Int):VideoSize {
   outputs.add(VideoEncoderBackend.Output.Format(MediaFormat.createVideoFormat("video/avc",4,4).apply{
    setInteger(MediaFormat.KEY_COLOR_STANDARD,1);setInteger(MediaFormat.KEY_COLOR_RANGE,2);setInteger(MediaFormat.KEY_COLOR_TRANSFER,3)
   }));return size
  }
  override fun submit(frame:SafeVideoFrame,ptsUs:Long):Boolean {
   if(!ready)return false
   if(input?.invoke(frame,ptsUs)==false)return false
   submissions++;outputPts=ptsUs
   if(queueOutput)outputs.add(sample(ptsUs,sampleFlags))
   return true
  }
  fun sample(pts:Long,flags:Int)=VideoEncoderBackend.Output.Sample(0,ByteBuffer.allocate(1),MediaCodec.BufferInfo().apply{set(0,if(flags==4)0 else 1,pts,flags)})
  override fun endInput():Boolean {if(end && !eosSent){outputs.add(sample(0,4));eosSent=true};return end}
  override fun poll()=outputs.pollFirst()
  override fun release(index:Int){released++}
  override fun requestSync()=Unit
  override fun close(){closed=true;afterClose?.invoke();if(failClose)error("Vendor release failed")}
 }
 private val owner=VideoOwner("s","c")
 private fun encoder(s:Scheduler,b:Backend,admission:VideoEncoderWorkerAdmission=VideoEncoderWorkerAdmission())=H264VideoEncoder(owner,kotlin.io.path.createTempDirectory("encoder").toFile(),30_000_000,s,admission=admission,backendFactory={b})
 private fun frame(s:Scheduler,authorized:()->Boolean={true}):SafeVideoFrame {
  val lease=VideoCaptureLease().tryAcquire(owner,VideoSize(4,4))!!
  return SafeVideoFrame.fromCapture(owner,0,s.nanos,Bitmap.createBitmap(4,4,Bitmap.Config.ARGB_8888),lease,s,authorized=authorized)
 }
 @Test fun delayedFinishKeepsClosedAndActiveGopsAtFrozenCutoff() = retentionCutoff(freeze=true, localRejection=false, stale=true)
 @Test fun queuedLocalRejectionAfterFreezeKeepsAlreadyWrittenSafeGops() = retentionCutoff(freeze=true, localRejection=true, stale=true)
 @Test fun ordinaryFinishExpiresWholeGopsAfterIdleGap() = retentionCutoff(freeze=false, localRejection=false, stale=true)
 @Test fun ordinaryFinishKeepsRecentClosedAndActiveGops() = retentionCutoff(freeze=false, localRejection=false, stale=false)
 private fun retentionCutoff(freeze:Boolean,localRejection:Boolean,stale:Boolean) {
  val s=Scheduler();val b=Backend().apply {sampleFlags=1}
  val directory=kotlin.io.path.createTempDirectory("retention-cutoff").toFile()
  val budget=VideoDiskBudget();var frozenAt:Long?=null
  val e=H264VideoEncoder(owner,directory,30_000_000,s,admission=VideoEncoderWorkerAdmission(),backendFactory={b},
   retentionTimeNanos={frozenAt ?: s.nowNanos()},
   storeFactory={anchor,privacy->VideoSegmentStore(directory,owner,30_000_000,anchor,privacy,budget=budget,muxerFactory={file,_->
    object:VideoSegmentMuxer {
     val out=java.io.RandomAccessFile(file,"rw")
     override fun write(sample:ByteBuffer,info:MediaCodec.BufferInfo){out.setLength(out.length()+info.size)}
     override fun close(){out.close()}
    }
   })})
  try {
   assertNotNull(e.prepare(VideoSize(4,4),5))
   repeat(2) {s.nanos+=2_000_000_000;s.worker{assertTrue(e.offer(frame(s)))}};s.turn()
   assertEquals("one closed and one active GOP",2,directory.listFiles()!!.size)
   s.nanos+=1_000_000_000
   val queuedFrame=if(localRejection)frame(s) else null
   if(freeze)frozenAt=s.nanos
   if(stale)s.nanos+=61_000_000_000 // Form/control-worker delay, not media timestamps.
   if(localRejection) {
    b.input={_,_->throw VideoInputRejected()}
    s.worker{assertFalse(e.offer(queuedFrame!!))}
    assertTrue("local terminal disposal precedes explicit finish",e.isTerminal)
   }
   val segments=e.finish(s.nanos/1_000_000+100)
   assertEquals(if(freeze || !stale)2 else 0,segments.size)
   if(segments.isNotEmpty()) assertEquals(listOf(2_000_000L,4_000_000L),segments.map{it.firstPtsUs})
   segments.forEach{it.close()};assertTrue(b.closed);assertEquals(0,budget.usedBytes)
  } finally {e.close();directory.deleteRecursively()}
 }
 @Test fun muxerReleaseFailureQuarantinesAdmissionAndStillCleansBackendAndFiles() = muxerReleaseFailure(false)
 @Test fun muxerConstructorReleaseFailureQuarantinesAdmissionAndCleansCreatedFile() = muxerReleaseFailure(true)
 @Test fun confirmedReleaseAfterMuxerStopFailurePreservesOlderHistoryAndAllowsSuccessor() = muxerReleaseFailure(false,false)
 private fun muxerReleaseFailure(duringConstruction:Boolean,uncertain:Boolean=true) {
  val s=Scheduler();val b=Backend();b.sampleFlags=1
  val admission=VideoEncoderWorkerAdmission();val directory=kotlin.io.path.createTempDirectory("muxer-release").toFile()
  var failRelease=duringConstruction;var attempts=0
  val e=H264VideoEncoder(owner,directory,30_000_000,s,admission=admission,backendFactory={b},
   storeFactory={anchor,privacy->VideoSegmentStore(directory,owner,30_000_000,anchor,privacy,muxerFactory={file,_->
    if(duringConstruction){file.writeBytes(byteArrayOf(1));attempts++;throw VideoMuxerReleaseFailure(IllegalStateException("constructor release"))}
    object:VideoSegmentMuxer {
     val out=java.io.RandomAccessFile(file,"rw")
     override fun write(sample:ByteBuffer,info:MediaCodec.BufferInfo){out.setLength(out.length()+info.size)}
     override fun close(){attempts++;out.close();if(failRelease)throw if(uncertain)VideoMuxerReleaseFailure(IllegalStateException("release")) else IllegalStateException("stop failed, release confirmed")}
    }
   })})
  assertNotNull(e.prepare(VideoSize(4,4),5))
  s.nanos+=2_000_000_000;s.worker{assertTrue(e.offer(frame(s)))};s.turn()
  if(!duringConstruction) {
   s.nanos+=2_000_000_000;s.worker{assertTrue(e.offer(frame(s)))};s.turn()
   assertEquals(1,attempts);assertEquals(2,directory.listFiles()!!.size)
   failRelease=true
  }
  val frozen=e.finish(s.nanos/1_000_000+100)
  if(uncertain)assertTrue(frozen.isEmpty()) else assertEquals(1,frozen.size)
  frozen.forEach{it.close()}
  assertTrue(b.closed);assertEquals(if(duringConstruction)1 else 2,attempts)
  assertEquals(0,directory.listFiles()!!.size)
  if(uncertain)assertNull("native release uncertainty must deny successors",admission.acquire())
  else admission.acquire()?.close() ?: fail("confirmed release must allow a successor")
 }
 @Test fun localCancellationAfterConversionPreservesSafeHistoryAndReleasesDequeuedSlot() = cancellationAfterInputAcquisition(false,4)
 @Test fun localCancellationBeforePixelReadPreservesSafeHistoryAndReleasesDequeuedSlot() = cancellationAfterInputAcquisition(false,3)
 @Test fun globalRevocationAfterConversionDiscardsSafeHistory() = cancellationAfterInputAcquisition(true,4)
 @Test fun replacementReusesOriginalAnchorAndPreservesGapAndFrozenFiles() = cancellationAfterInputAcquisition(false,4,true)
 private fun cancellationAfterInputAcquisition(global:Boolean,rejectAtCheck:Int,replace:Boolean=false) {
  val s=Scheduler();val b=Backend();val timing=VideoEncoderTimings();val input=FlexibleYuvVideoEncoderInput(timing)
  input.configure(MediaFormat.createVideoFormat("video/avc",4,4),VideoSize(4,4))
  var occupied=false;var dequeued=0;var queuedPixels=0
  val port=object:VideoYuvInputPort {
   override fun dequeue():Int {check(!occupied);occupied=true;dequeued++;return 0}
   override fun image(index:Int)=android.media.VideoTestImage(4,4)
   override fun queue(index:Int,size:Int,ptsUs:Long){assertTrue(occupied);assertEquals(24,size);queuedPixels++;occupied=false}
  }
  b.input={frame,pts->input.submit(port,frame,pts)};b.afterClose={input.close();occupied=false};b.sampleFlags=1
  val directory=kotlin.io.path.createTempDirectory("cancel-history").toFile()
  val e=H264VideoEncoder(owner,directory,30_000_000,s,timings=timing,admission=VideoEncoderWorkerAdmission(),
   backendFactory={b},storeFactory={anchor,privacy->VideoSegmentStore(directory,owner,30_000_000,anchor,privacy,muxerFactory={file,_->
    object:VideoSegmentMuxer {
     val out=java.io.RandomAccessFile(file,"rw")
     override fun write(sample:ByteBuffer,info:MediaCodec.BufferInfo){out.setLength(out.length()+info.size)}
     override fun close(){out.close()}
    }
   })})
  assertNotNull(e.prepare(VideoSize(4,4),5))
  repeat(2){s.nanos+=2_000_000_000;s.worker{assertTrue(e.offer(frame(s)))}}
  s.nanos+=2_000_000_000
  val privacy=VideoPrivacyRevocation.current;var checks=0
  s.worker {assertFalse(e.offer(frame(s){
   checks++
   if(checks==rejectAtCheck && global)VideoPrivacyRevocation.revoke()
   checks<rejectAtCheck && VideoPrivacyRevocation.permits(privacy)
  }))}
  assertEquals(3,dequeued);assertEquals(2,queuedPixels);assertFalse(occupied);assertTrue(b.closed);assertTrue(e.isTerminal)
  assertEquals(if(rejectAtCheck==4)3 else 2,timing.yuvConversionNs.snapshot().size)
  repeat(20){s.worker{assertFalse(e.offer(frame(s)))}}
  assertEquals(3,dequeued) // Terminated codec cannot accumulate abandoned input slots.
  val segments=e.finish(s.nanos/1_000_000+100)
  if(global)assertTrue(segments.isEmpty()) else {assertEquals(2,segments.size);assertEquals(privacy,VideoPrivacyRevocation.current)}
  if(replace) {
   e.close();assertTrue(segments.all{it.path.exists()})
   s.nanos+=5_000_000_000
   val nextBackend=Backend()
   val next=H264VideoEncoder(owner,directory,30_000_000,s,admission=VideoEncoderWorkerAdmission(),
    timeAnchor=e.timeAnchor,backendFactory={nextBackend})
   assertNotNull(next.prepare(VideoSize(4,4),5));assertSame(e.timeAnchor,next.timeAnchor)
   s.worker{assertTrue(next.offer(frame(s)))}
   assertEquals(e.timeAnchor.ptsUs(s.nanos),nextBackend.outputPts)
   assertTrue(nextBackend.outputPts-segments.last().lastPtsUs>=5_000_000)
   next.close();assertTrue(segments.all{it.path.exists()})
  }
  segments.forEach{it.close()};e.close();assertEquals(0,directory.listFiles()!!.size)
 }
 @Test fun closeAtPrepareAdmissionBarrierCannotLeakTicket() {
  val s=Scheduler();val b=Backend();val admission=VideoEncoderWorkerAdmission();val e=encoder(s,b,admission)
  val returned=java.util.concurrent.atomic.AtomicReference<VideoSize?>()
  val failure=java.util.concurrent.atomic.AtomicReference<Throwable?>()
  val thread=Thread {try{returned.set(e.prepare(VideoSize(4,4),5))}catch(t:Throwable){failure.set(t)}}
  synchronized(e) {
   thread.start()
   val deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(2)
   while(thread.state!=Thread.State.BLOCKED && System.nanoTime()<deadline) Thread.yield()
   assertEquals("prepare must be held at lifecycle admission",Thread.State.BLOCKED,thread.state)
   e.close() // Reentrant monitor: close and worker disposal complete before prepare may acquire.
  }
  thread.join(2000);assertFalse(thread.isAlive);failure.get()?.let{throw it}
  assertNull(returned.get());admission.acquire()?.close() ?: fail("ticket leaked after terminal close")
 }
 @Test fun hungWorkerIsQuarantinedAndNeverReplaced() {
  val admission=VideoEncoderWorkerAdmission();val first=admission.acquire()!!
  assertNull(admission.acquire());first.quarantine();first.close();repeat(100){assertNull(admission.acquire())}
 }
 @Test fun successfulTeardownReleasesOnlyItsOwnAdmission() {
  val admission=VideoEncoderWorkerAdmission();val first=admission.acquire()!!;first.close()
  val second=admission.acquire()!!;first.close();assertNull(admission.acquire());second.close();assertNotNull(admission.acquire())
 }
 @Test fun failedVendorReleaseQuarantinesUncertainResources() {
  val s=Scheduler();val b=Backend();val admission=VideoEncoderWorkerAdmission();val e=encoder(s,b,admission)
  assertNotNull(e.prepare(VideoSize(4,4),5));b.failClose=true;e.close();assertTrue(b.closed);assertNull(admission.acquire())
 }
 @Test fun boundedCountersRetainNoUnboundedHistory() {
  val counter=VideoEncoderTimings.Counter();repeat(10000){counter.add(it.toLong())}
  assertEquals(256,counter.snapshot().size);assertTrue(counter.snapshot().all{it>=9744})
 }
 @Test fun codecConfigurationIsIgnoredAndEosOutputReleasedBeforeTeardown() {
  val s=Scheduler();val b=Backend();val e=encoder(s,b);e.prepare(VideoSize(4,4),5)
  b.outputs.add(b.sample(9_000_000,MediaCodec.BUFFER_FLAG_CODEC_CONFIG))
  s.nanos+=200_000_000;s.worker{assertTrue(e.offer(frame(s)))}
  assertTrue(e.finish(s.nanos/1_000_000+100).isEmpty());assertTrue(b.closed);assertEquals(3,b.released)
 }
 @Test fun oneWorkerTurnDrainsAtMostSixteenOutputs() {
  val s=Scheduler();val b=Backend();val e=encoder(s,b);e.prepare(VideoSize(4,4),5)
  repeat(100){b.outputs.add(b.sample(0,MediaCodec.BUFFER_FLAG_CODEC_CONFIG))}
  s.nanos+=200_000_000;s.worker{e.offer(frame(s))};assertTrue(b.released<=16);e.close()
 }
 @Test fun backpressureAndRevokedFrameReleaseLeaseWithoutSubmitting() {
  val s=Scheduler();val b=Backend();val e=encoder(s,b);assertNotNull(e.prepare(VideoSize(4,4),5))
  b.ready=false;s.worker{assertFalse(e.offer(frame(s)))};assertFalse(e.isTerminal)
  b.ready=true;s.worker{assertFalse(e.offer(frame(s){false}))};assertEquals(0,b.submissions);e.close();assertTrue(b.closed)
 }
 @Test fun gapsUseSingleAnchorAndLateOutputAfterRevocationIsDiscarded() {
  val s=Scheduler();val b=Backend();val e=encoder(s,b);assertNotNull(e.prepare(VideoSize(4,4),5))
  s.nanos+=200_000_000;s.worker{assertTrue(e.offer(frame(s)))};val first=b.outputPts
  s.nanos+=900_000_000;s.worker{assertTrue(e.offer(frame(s)))};assertEquals(900_000,b.outputPts-first)
  b.outputs.add(b.sample(b.outputPts+1,0));VideoPrivacyRevocation.revoke();s.turn()
  assertTrue(e.finish(s.nanos/1_000_000).isEmpty());assertTrue(b.closed)
 }
 @Test fun duplicateOutputPtsFailsClosed() {
  val s=Scheduler();val b=Backend();val e=encoder(s,b);e.prepare(VideoSize(4,4),5)
  s.nanos+=200_000_000;s.worker{assertTrue(e.offer(frame(s)))};b.outputs.add(b.sample(b.outputPts,0))
  s.nanos+=200_000_000;s.worker{assertFalse(e.offer(frame(s)))};assertTrue(b.closed)
 }
 @Test fun noProgressDeadlineClosesWithoutReplacementAndEosCallerDeadlineIsIndependent() {
  val s=Scheduler();val b=Backend();val admission=VideoEncoderWorkerAdmission();val e=encoder(s,b,admission)
  e.prepare(VideoSize(4,4),5);b.queueOutput=false;s.nanos+=200_000_000;s.worker{e.offer(frame(s))}
  s.nanos+=1_001_000_000;s.turn();assertTrue(b.closed)
  val other=Backend();val e2=encoder(s,other,admission);assertNotNull(e2.prepare(VideoSize(4,4),5))
  s.held=true;val start=System.nanoTime();assertTrue(e2.finish(s.nanos/1_000_000+20).isEmpty())
  assertTrue((System.nanoTime()-start)/1_000_000<500);assertNull(admission.acquire())
  s.held=false;while(s.queued.isNotEmpty())s.worker(s.queued.removeFirst());assertTrue(other.closed);assertNull(admission.acquire())
 }
}
