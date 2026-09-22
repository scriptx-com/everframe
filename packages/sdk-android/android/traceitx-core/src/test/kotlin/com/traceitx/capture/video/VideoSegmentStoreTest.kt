// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video
import android.media.MediaCodec
import android.media.MediaFormat
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(sdk=[29])
class VideoSegmentStoreTest {
 private val format get() = MediaFormat.createVideoFormat("video/avc",4,4).apply { setByteBuffer("csd-0",ByteBuffer.wrap(byteArrayOf(1,2,3))) }
 private class Harness(val duration:Long=30_000_000,val closeGrowth:Int=0,val budget:VideoDiskBudget=VideoDiskBudget(),val delete:(File)->Boolean={it.delete()}) {
  val dir=kotlin.io.path.createTempDirectory("segments").toFile()
  val localPts=mutableListOf<Long>()
  val store=VideoSegmentStore(dir,VideoOwner("s","c"),duration,VideoTimeAnchor(0,0),budget=budget,deleteFile=delete,muxerFactory={ file, _ ->
   object:VideoSegmentMuxer {
    val out=RandomAccessFile(file,"rw")
    override fun write(sample:ByteBuffer,info:MediaCodec.BufferInfo) { localPts+=info.presentationTimeUs; out.setLength(out.length()+info.size) }
    override fun close() { out.setLength(out.length()+closeGrowth); out.close() }
   }
  })
  fun output(pts:Long,key:Boolean=false,bytes:Int=1024,fmt:MediaFormat=MediaFormat.createVideoFormat("video/avc",4,4),flags:Int=0) {
   store.append(ByteBuffer.allocate(bytes),MediaCodec.BufferInfo().apply {set(0,bytes,pts,flags or if(key) 1 else 0)},fmt)
  }
 }
 @Test fun failedEvictionKeepsPhysicalOwnershipAndStopsAllocation() {
  var allowDelete=false
  val h=Harness(duration=3_000_000,delete={allowDelete && it.delete()})
  h.output(0,true);h.output(2_000_000,true);h.output(4_000_000,true)
  val count=h.dir.listFiles()!!.size
  repeat(100){h.output(6_000_000+it*2_000_000L,true)}
  assertEquals(count,h.dir.listFiles()!!.size);assertTrue(count<=32)
  h.store.close()
  val physical=h.dir.listFiles()!!.sumOf{it.length()}
  assertEquals(physical,h.store.totalBytes);assertEquals(physical,h.budget.usedBytes)
  assertNull(h.budget.reserve(1))
  allowDelete=true;h.budget.retryCleanup();h.store.close()
  assertEquals(0,h.dir.listFiles()!!.size);assertEquals(0,h.budget.usedBytes)
 }
 @Test fun failedOversizedCloseIsChargedAtActualSizeAndRemainsRetryable() {
  var allowDelete=false
  val h=Harness(closeGrowth=2*1024*1024,budget=VideoDiskBudget(1024*1024L),delete={allowDelete && it.delete()})
  h.output(0,true);assertTrue(h.store.freeze().isEmpty())
  val physical=h.dir.listFiles()!!.single().length();assertTrue(physical>1024*1024)
  assertEquals(physical,h.store.totalBytes);assertEquals(physical,h.budget.usedBytes);assertNull(h.budget.reserve(1))
  repeat(100){h.output(it*2_000_000L,true)};assertEquals(1,h.dir.listFiles()!!.size)
  allowDelete=true;h.budget.retryCleanup();h.store.close()
  assertEquals(0,h.budget.usedBytes);assertEquals(0,h.dir.listFiles()!!.size)
 }
 @Test fun failedFrozenOwnerDeletionTransfersRetryOwnershipToProcessBudget() {
  var allowDelete=false
  val h=Harness(delete={allowDelete && it.delete()});h.output(0,true)
  h.store.freeze().single().close() // No retained caller reference after this expression.
  h.store.close();assertEquals(1,h.dir.listFiles()!!.size);assertNull(h.budget.reserve(1))
  allowDelete=true;h.budget.retryCleanup();assertEquals(0,h.dir.listFiles()!!.size);assertEquals(0,h.budget.usedBytes)
 }
 @Test fun outputWithoutKeyframesCannotGrowStoreIndefinitely() {
  val h=Harness(); repeat(100){h.output(it*200_000L,bytes=128*1024)}
  assertEquals(0,h.dir.listFiles()!!.size); assertTrue(h.store.freeze().isEmpty()); h.store.close()
 }
 @Test fun syncSplitsAndPreservesAbsoluteGapsWithLocalPts() {
  val h=Harness(); h.output(1_000_000,true); h.output(1_200_000); h.output(3_200_000,true); h.output(3_900_000)
  val segments=h.store.freeze(); assertEquals(2,segments.size)
  assertEquals(listOf(0L,200_000L,0L,700_000L),h.localPts)
  assertEquals(3_200_000L,segments[1].firstPtsUs); segments.forEach{it.close()}
  assertEquals(0,h.budget.usedBytes)
 }
 @Test fun configIsNeverAMediaSampleAndNonmonotonicPtsAbortsActive() {
  val h=Harness(); h.output(100,true); h.output(110,flags=MediaCodec.BUFFER_FLAG_CODEC_CONFIG);h.output(90)
  assertEquals(listOf(0L),h.localPts);assertTrue(h.store.freeze().isEmpty());h.store.close()
 }
 @Test fun missingSyncAtFourSecondsAbortsAndSizeCapAborts() {
  val h=Harness();h.output(0,true);h.output(4_000_000);assertTrue(h.store.freeze().isEmpty());h.store.close()
  val b=Harness();b.output(0,true,800*1024);b.output(200_000,bytes=200*1024);assertTrue(b.store.freeze().isEmpty());b.store.close()
 }
 @Test fun formatChangeClearsOldRingAndCloseGrowthCannotEscapeCap() {
  val h=Harness();h.output(0,true,fmt=format);h.output(2_000_000,true,fmt=format)
  h.output(2_200_000,true,fmt=MediaFormat.createVideoFormat("video/avc",8,4))
  val frozen=h.store.freeze();assertEquals(1,frozen.size);assertEquals(2_200_000,frozen.single().firstPtsUs);frozen.forEach{it.close()}
  val b=Harness(closeGrowth=2*1024*1024);b.output(0,true);assertTrue(b.store.freeze().isEmpty());b.store.close();assertEquals(0,b.budget.usedBytes)
 }
 @Test fun durationAndFileCountEvictWholeSegmentsWhileFrozenOwnersStayPinned() {
  val h=Harness(duration=3_000_000);repeat(100){h.output(it*2_000_000L,true,200*1024)}
  val frozen=h.store.freeze();assertTrue(frozen.size<=2);assertTrue(frozen.last().lastPtsUs-frozen.first().firstPtsUs<=3_000_000)
  h.store.close();assertTrue(frozen.all{it.path.exists()});frozen.forEach{it.close()};assertEquals(0,h.budget.usedBytes)
 }
 @Test fun durationClampAndRollingBytesNeverExtendConfiguredLimit() {
  val h=Harness(duration=120_000_000);repeat(100){h.output(it*2_000_000L,true,800*1024)}
  assertTrue(h.store.totalBytes<=8L*1024*1024);assertTrue(h.dir.listFiles()!!.size<=32)
  val segments=h.store.freeze();assertTrue(segments.last().lastPtsUs-segments.first().firstPtsUs<=60_000_000)
  segments.forEach{it.close()};h.store.close()
  for(duration in listOf(0L,-1L)) try{Harness(duration=duration);fail("nonpositive duration accepted")}catch(_:IllegalArgumentException){}
 }
 @Test fun frozenIdentityDoesNotAliasMutableCodecConfigurationAndLateAppendIsIgnored() {
  val h=Harness();val format=format;h.output(0,true,fmt=format);val segments=h.store.freeze()
  val identity=segments.single().format;format.getByteBuffer("csd-0")!!.put(0,99)
  assertNotEquals(identity,VideoCodecFormat.from(format));h.output(2_000_000,true)
  assertEquals(1,h.dir.listFiles()!!.size);segments.forEach{it.close()};h.store.close()
 }
 @Test fun explicitRevocationDiscardsRetainedHistory() {
  val h=Harness();h.output(0,true);h.output(2_000_000,true);VideoPrivacyRevocation.revoke()
  assertTrue(h.store.freeze().isEmpty());assertEquals(0,h.dir.listFiles()!!.size)
 }
 @Test fun idleGapExpiresWholeGopsBeforeFreeze() {
  val h=Harness(duration=3_000_000);h.output(0,true);h.output(2_000_000,true)
  h.store.trim(6_000_000);assertTrue(h.store.freeze().isEmpty());assertEquals(0,h.budget.usedBytes)
 }
 @Test fun pinnedBudgetRejectsNewAllocations() {
  val budget=VideoDiskBudget(1024*1024L);val a=Harness(budget=budget);a.output(0,true,800*1024);val frozen=a.store.freeze()
  val b=Harness(budget=budget);b.output(0,true);assertTrue(b.store.freeze().isEmpty());frozen.forEach{it.close()};a.store.close();b.store.close()
 }
}
