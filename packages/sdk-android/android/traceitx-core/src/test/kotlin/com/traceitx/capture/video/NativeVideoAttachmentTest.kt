// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.*
import org.junit.Test
import com.traceitx.protocol.generated.Format
import com.traceitx.protocol.generated.AttachmentKind

class NativeVideoAttachmentTest {
 @Test fun normalAttachmentContainsMatchingBoundedBytesAndClosesClip()=runBlocking {
  val h=VideoExporterTest.Harness();val clip=h.exporter.export(h.owner,listOf(h.segment())){true}!!
  val pair=NativeVideoAttachment(h.scheduler).build(clip)!!
  assertEquals("replay",pair.envelope.partName);assertEquals("replay",pair.part.name)
  assertEquals("replay.mp4",pair.part.filename);assertEquals("video/mp4",pair.part.contentType)
  assertEquals(Format.TraceitxVideoV1,pair.envelope.format);assertEquals(AttachmentKind.SessionReplay,pair.envelope.kind)
  assertEquals(pair.envelope.sha256,sha256(pair.part.data));assertEquals(pair.part.sha256Hex,pair.envelope.sha256)
  assertEquals(3.0,pair.envelope.byteLength!!,0.0);assertEquals(4.0,pair.envelope.width!!,0.0)
  assertEquals(12_000.0,pair.envelope.replayStartEpochMS!!,0.0);assertFalse(clip.file.exists());assertEquals(0,h.budget.usedBytes)
 }
 @Test fun modifiedFileIsRejectedAndDeleted()=runBlocking {
  val h=VideoExporterTest.Harness();val clip=h.exporter.export(h.owner,listOf(h.segment())){true}!!
  clip.file.writeBytes(byteArrayOf(4,5,6));assertNull(NativeVideoAttachment(h.scheduler).build(clip));assertFalse(clip.file.exists())
 }
 @Test fun realMultipartCarriesSharedVideoMetadataAndExactMedia()=runBlocking {
  val h=VideoExporterTest.Harness();val clip=h.exporter.export(h.owner,listOf(h.segment())){true}!!
  val pair=NativeVideoAttachment(h.scheduler).build(clip)!!
  val json=kotlinx.serialization.json.Json.encodeToString(com.traceitx.protocol.generated.Attachment.serializer(),pair.envelope)
  val server=okhttp3.mockwebserver.MockWebServer();server.start()
  try {
   server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(200).setBody("{}"))
   val part=pair.part
   com.traceitx.transport.MultipartUploader(okhttp3.OkHttpClient()).upload(
    endpoint=server.url("/ingest").toString(),sdkKey="test",idempotencyKey="test",
    envelopeBytes=("{\"attachments\":["+json+"]}").toByteArray(),
    attachments=listOf(com.traceitx.transport.MultipartUploader.Part(part.name,part.filename,part.data,part.contentType)))
   val request=server.takeRequest(2,java.util.concurrent.TimeUnit.SECONDS)!!
   val boundary=request.getHeader("Content-Type")!!.substringAfter("boundary=")
   val parts=request.body.readByteArray().toString(Charsets.ISO_8859_1).split("--$boundary")
   val envelope=parts.single{it.contains("name=\"envelope\"")}.substringAfter("\r\n\r\n").removeSuffix("\r\n")
   val parsed=kotlinx.serialization.json.Json.parseToJsonElement(envelope) as kotlinx.serialization.json.JsonObject
   val metadata=(parsed["attachments"] as kotlinx.serialization.json.JsonArray).single() as kotlinx.serialization.json.JsonObject
   assertEquals("\"traceitx-video-v1\"",metadata["format"].toString())
   assertEquals("\"session-replay\"",metadata["kind"].toString())
   val media=parts.single{it.contains("name=\"replay\"")}.substringAfter("\r\n\r\n").removeSuffix("\r\n").toByteArray(Charsets.ISO_8859_1)
   assertArrayEquals(part.data,media);assertEquals(part.sha256Hex,sha256(media))
   assertEquals(pair.envelope,kotlinx.serialization.json.Json.decodeFromString(com.traceitx.protocol.generated.Attachment.serializer(),metadata.toString()))
  } finally {server.shutdown()}
 }
 internal class QueuedScheduler:VideoCaptureScheduler {
  val tasks=java.util.ArrayDeque<()->Unit>();var timer:(()->Unit)?=null;var worker=false
  override fun main(block:()->Unit)=block()
  override fun worker(block:()->Unit){tasks.add(block)}
  override fun later(delayMs:Long,block:()->Unit):()->Unit {timer=block;return {timer=null}}
  override fun isWorkerThread()=worker
  override fun nowNanos()=0L
  fun drain(){worker=true;try{while(tasks.isNotEmpty()) tasks.removeFirst()()}finally{worker=false}}
 }
 @Test fun queuedAttachmentTimeoutResolvesWithoutDeletingClipUntilWorkerReturns()=runBlocking {
  val h=VideoExporterTest.Harness();val clip=h.exporter.export(h.owner,listOf(h.segment())){true}!!
  val scheduler=QueuedScheduler()
  val result=async(start=kotlinx.coroutines.CoroutineStart.UNDISPATCHED){NativeVideoAttachment(scheduler).build(clip)}
  try {
   assertNotNull("Bounded attachment must register a deadline",scheduler.timer)
   scheduler.timer!!();assertNull(result.await());assertTrue(clip.file.exists())
   scheduler.drain();assertFalse(clip.file.exists());assertEquals(0,h.budget.usedBytes)
  } finally {result.cancel();scheduler.drain()}
 }
 @Test fun runningAttachmentTimeoutQuarantinesAndLateReadCleansExactClip()=runBlocking {
  val h=VideoExporterTest.Harness();val clip=h.exporter.export(h.owner,listOf(h.segment())){true}!!
  val admission=VideoEncoderWorkerAdmission()
  val builder=NativeVideoAttachment(h.scheduler,admission,openInput={file ->
   h.scheduler.timeout!!();file.inputStream()
  })
  assertNull(builder.build(clip));assertFalse(clip.file.exists());assertNull(admission.acquire());assertEquals(0,h.budget.usedBytes)
 }
 @Test fun cancelledQueuedAttachmentRetainsCleanupUntilWorkerReturns()=runBlocking {
  val h=VideoExporterTest.Harness();val clip=h.exporter.export(h.owner,listOf(h.segment())){true}!!
  val scheduler=QueuedScheduler()
  val result=async(start=kotlinx.coroutines.CoroutineStart.UNDISPATCHED){NativeVideoAttachment(scheduler).build(clip)}
  result.cancel();assertTrue(clip.file.exists());scheduler.drain();assertFalse(clip.file.exists());assertEquals(0,h.budget.usedBytes)
 }
}
