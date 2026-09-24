// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.*
import org.junit.Test

class VideoExporterTest {
 internal class Scheduler:VideoCaptureScheduler {
  var now=0L; var timeout:(()->Unit)?=null
  override fun main(block:()->Unit)=block()
  override fun worker(block:()->Unit)=block()
  override fun later(delayMs:Long,block:()->Unit):()->Unit {timeout=block;return {timeout=null}}
  override fun isWorkerThread()=true
  override fun nowNanos()=now
 }
 internal class Harness {
  val root=kotlin.io.path.createTempDirectory("export").toFile()
  val scheduler=Scheduler();val budget=VideoDiskBudget();val owner=VideoOwner(UUID.randomUUID().toString(),UUID.randomUUID().toString())
  val format=VideoCodecFormat("video/avc",4,4,"same")
  var attempts=0;var oversized=false;var fail=false;var allowed=true
  var duration=400_000L;var firstOnlyOversized=false;var afterRemux:()->Unit={}
  val inputs=mutableListOf<List<Long>>()
  val exporter=VideoExporter(root,scheduler,budget,VideoEncoderWorkerAdmission(),media=object:VideoExportMedia {
   override fun remux(segments:List<VideoSegment>,target:File,check:()->Unit):VideoMediaInfo {
    attempts++;inputs+=segments.map{it.firstPtsUs};target.writeBytes(byteArrayOf(1,2,3));check()
    if(fail) error("muxer failed")
    if(oversized || (firstOnlyOversized && attempts==1)) java.io.RandomAccessFile(target,"rw").use{it.setLength(VideoExporter.MAX_BYTES+1)}
    afterRemux();return VideoMediaInfo(VideoSize(4,4),duration,segments.first().firstPtsUs)
   }
  })
  fun segment(pts:Long=2_000_000,who:VideoOwner=owner,fmt:VideoCodecFormat=format):VideoSegment {
   val file=File(root,UUID.randomUUID().toString());file.writeBytes(byteArrayOf(9))
   val owned=VideoOwnedFile(file,budget.reserve(1)!!,budget){it.delete()}
   return VideoSegment(who,file,1,pts,pts+200_000,fmt,VideoPrivacyRevocation.current,VideoTimeAnchor(10_000,50),owned)
  }
 }
 @Test fun publishesActualMetadataAndConsumesOnlySuppliedOwner()=runBlocking {
  val h=Harness();val a=h.segment();val other=h.segment(who=h.owner.copy(captureId=UUID.randomUUID().toString()))
  val clip=h.exporter.export(h.owner,listOf(a)){true}!!
  assertFalse(a.path.exists());assertTrue(other.path.exists());assertEquals(12_000,clip.metadata.replayStartEpochMs)
  assertEquals(3,clip.metadata.byteLength);assertEquals(400,clip.metadata.durationMs);assertTrue(clip.file.name.endsWith(".mp4"))
  clip.close();clip.close();assertFalse(clip.file.exists());assertTrue(other.path.exists());other.close();assertEquals(0,h.budget.usedBytes)
 }
 @Test fun failedAndOversizedExportsDeleteAllUntransferredFiles()=runBlocking {
  for(failure in listOf(true,false)) {val h=Harness();h.fail=failure;h.oversized=!failure
   assertNull(h.exporter.export(h.owner,listOf(h.segment(),h.segment(4_000_000))){true})
   assertEquals(if(failure)1 else 2,h.attempts);assertEquals(0,h.budget.usedBytes);assertTrue(h.root.walk().none{it.isFile})
  }
 }
 @Test fun latestOrientationSuffixAndOriginalOffsetAreSelected()=runBlocking {
  val h=Harness();val old=h.segment(0,fmt=h.format.copy(width=6));val newer=h.segment(5_000_000)
  val clip=h.exporter.export(h.owner,listOf(old,newer)){true}!!
  assertEquals(listOf(listOf(5_000_000L)),h.inputs);assertEquals(15_000,clip.metadata.replayStartEpochMs);clip.close()
 }
 @Test fun revocationBeforeWorkConsumesSegmentsWithoutMedia()=runBlocking {
  val h=Harness();assertNull(h.exporter.export(h.owner,listOf(h.segment())){false});assertEquals(0,h.attempts);assertEquals(0,h.budget.usedBytes)
 }
 @Test fun timeoutThenLateRemuxCannotPublishOrDeleteOtherOwner()=runBlocking {
  val h=Harness();val input=h.segment();val other=h.segment(who=h.owner.copy(captureId=UUID.randomUUID().toString()))
  val admission=VideoEncoderWorkerAdmission()
  val exporter=VideoExporter(h.root,h.scheduler,h.budget,admission,object:VideoExportMedia {
   override fun remux(segments:List<VideoSegment>,target:File,check:()->Unit):VideoMediaInfo {
    target.writeBytes(byteArrayOf(1));h.scheduler.timeout!!();target.appendBytes(byteArrayOf(2))
    return VideoMediaInfo(VideoSize(4,4),400_000,2_000_000)
   }
  })
  assertNull(exporter.export(h.owner,listOf(input)){true});assertFalse(input.path.exists());assertTrue(other.path.exists())
  assertEquals(1,h.budget.usedBytes);assertNull(admission.acquire());other.close()
 }
 @Test fun reversedOwnerFinalizationKeepsFrozenSecondOwner()=runBlocking {
  val h=Harness();val a=h.segment();val b=h.segment(who=h.owner.copy(captureId=UUID.randomUUID().toString()))
  val bClip=h.exporter.export(b.owner,listOf(b)){true}!!
  assertNull(h.exporter.export(a.owner,listOf(a)){false});assertTrue(bClip.file.exists());bClip.close();assertEquals(0,h.budget.usedBytes)
 }
 @Test fun oversizedFirstAttemptDropsWholeOldestGopAndShiftsEpoch()=runBlocking {
  val h=Harness();h.firstOnlyOversized=true
  val clip=h.exporter.export(h.owner,listOf(h.segment(),h.segment(4_000_000))){true}!!
  assertEquals(listOf(listOf(2_000_000L,4_000_000L),listOf(4_000_000L)),h.inputs)
  assertEquals(14_000,clip.metadata.replayStartEpochMs);assertEquals(2,h.attempts);clip.close()
 }
 @Test fun insufficientSingleFrameDurationOmitsClip()=runBlocking {
  val h=Harness();h.duration=0
  assertNull(h.exporter.export(h.owner,listOf(h.segment())){true});assertEquals(0,h.budget.usedBytes)
 }
 @Test fun authorizationRevokedAfterRemuxDeletesOutput()=runBlocking {
  val h=Harness();h.afterRemux={h.allowed=false}
  assertNull(h.exporter.export(h.owner,listOf(h.segment())){h.allowed});assertEquals(0,h.budget.usedBytes)
 }
 @Test fun retryUsesOriginalDeadline()=runBlocking {
  val h=Harness();h.firstOnlyOversized=true;h.afterRemux={h.scheduler.now=3_000_000_000L}
  assertNull(h.exporter.export(h.owner,listOf(h.segment(),h.segment(4_000_000))){true});assertEquals(1,h.attempts);assertEquals(0,h.budget.usedBytes)
 }
 @Test fun streamingOverflowRetriesReleasedSuffixWithinSameDeadline()=runBlocking {
  val h=Harness();var writes=0
  val exporter=VideoExporter(h.root,h.scheduler,h.budget,VideoEncoderWorkerAdmission(),object:VideoExportMedia {
   override fun remux(segments:List<VideoSegment>,target:File,check:()->Unit):VideoMediaInfo {
    writes++;target.writeBytes(byteArrayOf(1));check()
    if(writes==1) {
     java.io.RandomAccessFile(target,"rw").use{it.setLength(VideoExporter.MAX_BYTES+VideoSegmentStore.CLOSE_RESERVE+1)}
     throw VideoExportSizeOverflow()
    }
    assertEquals(listOf(4_000_000L),segments.map{it.firstPtsUs})
    return VideoMediaInfo(VideoSize(4,4),400_000,segments.first().firstPtsUs)
   }
  })
  val clip=exporter.export(h.owner,listOf(h.segment(),h.segment(4_000_000))){true}
  assertNotNull(clip);assertEquals(2,writes);clip!!.close();assertEquals(0,h.budget.usedBytes)
 }
 @Test fun completionWinnerAlwaysResolvesWhileExecutingTimerWaitsAtPublication() {
  val completion=VideoOperationCompletion()
  val entered=java.util.concurrent.CountDownLatch(1);val timerStarted=java.util.concurrent.CountDownLatch(1)
  val timerFinished=java.util.concurrent.CountDownLatch(1);val results=java.util.concurrent.CopyOnWriteArrayList<String>()
  val timer=Thread {
   entered.await();timerStarted.countDown()
   completion.timeout {results+="timeout"};timerFinished.countDown()
  }.apply{start()}
  completion.finish {
   entered.countDown();assertTrue(timerStarted.await(1,java.util.concurrent.TimeUnit.SECONDS))
   assertFalse(timerFinished.await(20,java.util.concurrent.TimeUnit.MILLISECONDS));results+="published"
  }
  timer.join(1_000);assertFalse(timer.isAlive);assertEquals(listOf("published"),results)
 }
 @Test fun uncertainReleaseAfterOverflowNeverRetriesAndQuarantines()=runBlocking {
  val h=Harness();val admission=VideoEncoderWorkerAdmission();var attempts=0
  val exporter=VideoExporter(h.root,h.scheduler,h.budget,admission,object:VideoExportMedia {
   override fun remux(segments:List<VideoSegment>,target:File,check:()->Unit):VideoMediaInfo {
    attempts++;target.writeBytes(byteArrayOf(1))
    throw VideoMuxerReleaseFailure(VideoExportSizeOverflow())
   }
  })
  assertNull(exporter.export(h.owner,listOf(h.segment(),h.segment(4_000_000))){true})
  assertEquals(1,attempts);assertNull(admission.acquire());assertEquals(0,h.budget.usedBytes)
 }
 @Test fun cancelledQueuedExportClosesOnlyTransferredOwnerWhenWorkerReturns()=runBlocking {
  val h=Harness();val input=h.segment();val other=h.segment(who=h.owner.copy(captureId=UUID.randomUUID().toString()))
  val scheduler=NativeVideoAttachmentTest.QueuedScheduler()
  val exporter=VideoExporter(h.root,scheduler,h.budget,VideoEncoderWorkerAdmission())
  val result=async(start=kotlinx.coroutines.CoroutineStart.UNDISPATCHED){exporter.export(h.owner,listOf(input)){true}}
  result.cancel();assertTrue(input.path.exists());assertTrue(other.path.exists())
  scheduler.drain();assertFalse(input.path.exists());assertTrue(other.path.exists());other.close();assertEquals(0,h.budget.usedBytes)
 }
}
