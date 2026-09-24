// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaExtractor
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Synthetic pixels only; controller pulls files/video-export-fixture from dev.everframe.test. */
class VideoExportInstrumentedTest {
 @Test fun remuxRetainedGopsPreservesGapActualDurationAndAttachment()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().context
  val artifacts=File(context.filesDir,"video-export-fixture").apply{mkdirs()}
  val owner=VideoOwner(UUID.randomUUID().toString(),UUID.randomUUID().toString())
  val root=File(context.noBackupFilesDir,"everframe-video")
  val directory=File(File(root,owner.sessionId),owner.captureId)
  val lease=VideoDirectoryLeases.acquire()
  val encoder=H264VideoEncoder(owner,directory,30_000_000,backendFactory={AndroidH264Backend(FlexibleYuvVideoEncoderInput(VideoEncoderTimings()))})
  try {
   val size=checkNotNull(encoder.prepare(VideoSize(384,852),5))
   repeat(32) { index ->
    if(index>0) Thread.sleep(if(index==20)1_000 else 200)
    val time=SystemClock.elapsedRealtimeNanos()
    onWorker {
     val bitmap=Bitmap.createBitmap(size.width,size.height,Bitmap.Config.ARGB_8888)
     val canvas=Canvas(bitmap);val paint=Paint()
     for((i,color) in listOf(Color.RED,Color.GREEN,Color.BLUE,Color.WHITE).withIndex()) {
      paint.color=color;val x=(i%2)*size.width/2f;val y=(i/2)*size.height/2f
      canvas.drawRect(x,y,x+size.width/2f,y+size.height/2f,paint)
     }
     val slot=checkNotNull(VideoCaptureLease().tryAcquire(owner,size))
     assertTrue(encoder.offer(SafeVideoFrame.fromCapture(owner,0,time,bitmap,slot,AndroidVideoCaptureScheduler){true}))
    }
   }
   val all=encoder.finish(SystemClock.elapsedRealtime()+3_000);assertTrue(all.size>=3)
   // Simulate eviction of the oldest complete GOP; retained PTS still use original session anchor.
   onWorker{all.first().close()}
   val selected=all.drop(1);val selectedFirst=selected.first().firstPtsUs
   val clip=checkNotNull(VideoExporter(context).export(owner,selected){true})
   assertEquals(encoder.timeAnchor.wallEpochMs+selectedFirst/1_000,clip.metadata.replayStartEpochMs)
   val pts=mutableListOf<Long>();val extractor=MediaExtractor()
   try {extractor.setDataSource(clip.file.absolutePath);extractor.selectTrack(0)
    do{pts+=extractor.sampleTime}while(extractor.advance())
   } finally {extractor.release()}
   assertEquals(0L,pts.first());assertTrue(pts.zipWithNext().any{(a,b)->b-a>=800_000})
   val pair=checkNotNull(NativeVideoAttachment().build(clip))
   assertFalse(clip.file.exists());assertEquals(pair.envelope.sha256,sha256(pair.part.data))
   val final=File(artifacts,"replay.mp4");final.writeBytes(pair.part.data)
   val manifest=JSONObject().put("synthetic",true).put("file",final.name)
    .put("width",size.width).put("height",size.height).put("byteLength",pair.part.data.size)
    .put("sha256",pair.part.sha256Hex).put("durationMs",pair.envelope.durationMS)
    .put("replayStartEpochMs",pair.envelope.replayStartEpochMS).put("wallEpochMs",encoder.timeAnchor.wallEpochMs)
    .put("selectedFirstPtsUs",selectedFirst).put("outputPtsUs",JSONArray(pts))
    .put("expectedQuadrants","top-left red; top-right green; bottom-left blue; bottom-right white")
   File(artifacts,"manifest.json").writeText(manifest.toString(2))
   verifyEdgeClips(final,context)
  } finally {encoder.close();lease.close()}
 }
 private suspend fun verifyEdgeClips(source:File,context:android.content.Context) {
  val extractor=MediaExtractor()
  val format:android.media.MediaFormat
  val samples=mutableListOf<ByteArray>()
  try {
   extractor.setDataSource(source.absolutePath);format=extractor.getTrackFormat(0);extractor.selectTrack(0)
   repeat(2) {index ->
    if(index==1) assertEquals("Source second sample must be genuine non-sync",0,extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC)
    val buffer=java.nio.ByteBuffer.allocate(1024*1024);val size=extractor.readSampleData(buffer,0)
    samples+=ByteArray(size).also{buffer.position(0);buffer.get(it)};extractor.advance()
   }
  } finally {extractor.release()}
  for(noSync in listOf(false,true)) {
   val owner=VideoOwner(UUID.randomUUID().toString(),UUID.randomUUID().toString())
   val directory=File(File(File(context.noBackupFilesDir,"everframe-video"),owner.sessionId),owner.captureId).apply{mkdirs()}
   val file=File(directory,"${UUID.randomUUID()}.mp4")
   val reservation=checkNotNull(VideoDiskBudget.process.reserve(VideoSegmentStore.SEGMENT_CAP))
   val owned=VideoOwnedFile(file,reservation,VideoDiskBudget.process){it.delete()}
   try {
    onWorker {
     if(noSync) {
      // MPEG4Writer did not retain the requested leading non-sync input.
      // Move the source's genuine P sample first without changing encoded bytes.
      source.copyTo(file,overwrite=true)
      markFirstSampleNonSync(file)
     } else {
      val muxer=android.media.MediaMuxer(file.absolutePath,android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      try {
       val track=muxer.addTrack(format);muxer.start()
       val bytes=samples.first()
       muxer.writeSampleData(track,java.nio.ByteBuffer.wrap(bytes),android.media.MediaCodec.BufferInfo().apply {
        set(0,bytes.size,0,android.media.MediaCodec.BUFFER_FLAG_KEY_FRAME)
       })
       muxer.stop()
      } finally {muxer.release()}
     }
     reservation.shrink(file.length())
    }
    val inspect=MediaExtractor();val validSingleDuration:Boolean
    try {
     inspect.setDataSource(file.absolutePath);inspect.selectTrack(0)
     if(noSync) assertEquals("Patched stss must expose non-sync first sample",0,inspect.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC)
     val actual=inspect.getTrackFormat(0)
     validSingleDuration=actual.containsKey(android.media.MediaFormat.KEY_DURATION) && actual.getLong(android.media.MediaFormat.KEY_DURATION)>=1_000
    } finally {inspect.release()}
    val segment=VideoSegment(owner,file,file.length(),0,if(noSync)200_000 else 0,
     VideoCodecFormat.from(format),VideoPrivacyRevocation.current,VideoTimeAnchor(10_000,0),owned)
    val clip=VideoExporter(context).export(owner,listOf(segment)){true}
    try {
     if(noSync || !validSingleDuration) assertNull(clip) else assertNotNull(clip)
    } finally {clip?.close()}
   } finally {onWorker{owned.delete()}}
  }
 }
 /** Fixture-only sample reorder. Sample payloads are unchanged; update stsz and stss together. */
 private fun markFirstSampleNonSync(file:File) {
  java.io.RandomAccessFile(file,"rw").use {input ->
   var syncEntry=-1L;var sizeEntries=-1L;var dataOffset=-1L;var samplesPerChunk=0
   fun walk(start:Long,end:Long) {
    var position=start
    while(position+8<=end) {
     input.seek(position)
     var size=input.readInt().toLong() and 0xffffffffL
     val type=ByteArray(4).also{input.readFully(it)}.toString(Charsets.US_ASCII)
     var header=8L
     if(size==1L) {size=input.readLong();header=16}
     require(size>=header && position+size<=end)
     when(type) {
      "stss" -> {
       input.seek(position+12);val count=input.readInt();require(count>0)
       require(input.readInt()==1)
       if(count>1) require(input.readInt()>2)
       syncEntry=position+16
      }
      "stsz" -> {
       input.seek(position+12);require(input.readInt()==0);require(input.readInt()>=2)
       sizeEntries=position+20
      }
      "stco", "co64" -> {
       input.seek(position+12);require(input.readInt()>0)
       dataOffset=if(type=="co64")input.readLong() else input.readInt().toLong() and 0xffffffffL
      }
      "stsc" -> {
       input.seek(position+12);require(input.readInt()>0);require(input.readInt()==1)
       samplesPerChunk=input.readInt()
      }
     }
     if(type in listOf("moov","trak","mdia","minf","stbl")) walk(position+header,position+size)
     position+=size
    }
   }
   walk(0,input.length())
   require(syncEntry>=0 && sizeEntries>=0 && dataOffset>=0 && samplesPerChunk>=2)
   input.seek(sizeEntries);val firstSize=input.readInt();val secondSize=input.readInt()
   require(firstSize>0 && secondSize>0 && firstSize.toLong()+secondSize<=VideoSegmentStore.SEGMENT_CAP)
   input.seek(dataOffset)
   val first=ByteArray(firstSize).also{input.readFully(it)}
   val second=ByteArray(secondSize).also{input.readFully(it)}
   input.seek(dataOffset);input.write(second);input.write(first)
   input.seek(sizeEntries);input.writeInt(secondSize);input.writeInt(firstSize)
   input.seek(syncEntry);input.writeInt(2)
  }
 }
 private fun onWorker(block:()->Unit) {
  val latch=CountDownLatch(1);val error=AtomicReference<Throwable?>()
  AndroidVideoCaptureScheduler.worker{try{block()}catch(t:Throwable){error.set(t)}finally{latch.countDown()}}
  check(latch.await(3,TimeUnit.SECONDS));error.get()?.let{throw it}
 }
}
