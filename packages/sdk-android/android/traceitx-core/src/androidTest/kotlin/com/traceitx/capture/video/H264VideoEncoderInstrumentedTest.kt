// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Synthetic pixels only. Controller retrieves files/video-encoder-fixture-yuv via run-as com.traceitx.test. */
class H264VideoEncoderInstrumentedTest {
    @Test fun flexibleYuvProducesBoundedSyncSegmentsWithColorsOrientationAndGap() = runFixture(false)
    @Test fun eglProducesBoundedSyncSegmentsWithColorsOrientationAndGap() = runFixture(true)
    private fun runFixture(egl:Boolean) {
        val adapter=if(egl) "egl" else "yuv"
        val context=InstrumentationRegistry.getInstrumentation().context
        val directory=File(context.filesDir,"video-encoder-fixture-$adapter")
        directory.deleteRecursively();assertTrue(directory.mkdirs())
        val owner=VideoOwner("synthetic-device-fixture",adapter)
        val timings=VideoEncoderTimings()
        val encoder=H264VideoEncoder(owner,directory,30_000_000,timings=timings,backendFactory={
            AndroidH264Backend(if(egl)EglVideoEncoderInput(timings) else FlexibleYuvVideoEncoderInput(timings))
        })
        try {
            val size=encoder.prepare(VideoSize(384,852),5)
            assertNotNull("No supported $adapter baseline AVC candidate",size)
            size!!
            val accepted=mutableListOf<Long>()
            // Real elapsed acquisition opportunities. Skip a window, never catch up with index/fps timestamps.
            repeat(32) { index ->
                if(index > 0) Thread.sleep(if(index==12) 900 else 200)
                val captureTime=SystemClock.elapsedRealtimeNanos()
                onWorker {
                    val bitmap=Bitmap.createBitmap(size.width,size.height,Bitmap.Config.ARGB_8888)
                    val canvas=Canvas(bitmap);val paint=Paint()
                    val halfWidth=size.width/2f;val halfHeight=size.height/2f
                    paint.color=Color.RED;canvas.drawRect(0f,0f,halfWidth,halfHeight,paint)
                    paint.color=Color.GREEN;canvas.drawRect(halfWidth,0f,size.width.toFloat(),halfHeight,paint)
                    paint.color=Color.BLUE;canvas.drawRect(0f,halfHeight,halfWidth,size.height.toFloat(),paint)
                    paint.color=Color.WHITE;canvas.drawRect(halfWidth,halfHeight,size.width.toFloat(),size.height.toFloat(),paint)
                    val lease=checkNotNull(VideoCaptureLease().tryAcquire(owner,size))
                    val frame=SafeVideoFrame.fromCapture(owner,0,captureTime,bitmap,lease,AndroidVideoCaptureScheduler){true}
                    if(encoder.offer(frame)) accepted+=encoder.timeAnchor.ptsUs(captureTime)
                }
            }
            val finishStarted=SystemClock.elapsedRealtime()
            val segments=encoder.finish(finishStarted+3_000)
            val finishMs=SystemClock.elapsedRealtime()-finishStarted
            assertTrue("No completed MP4 segments",segments.isNotEmpty())
            assertTrue(finishMs<=3_100)
            assertTrue(segments.size<=32)
            assertTrue(segments.sumOf{it.byteLength}<=8L*1024*1024)
            val pts=mutableListOf<Long>()
            val entries=JSONArray()
            for(segment in segments) {
                assertEquals(owner,segment.owner);assertEquals(segment.path.length(),segment.byteLength)
                assertTrue(segment.byteLength<=1024L*1024)
                val extractor=MediaExtractor()
                try {
                    extractor.setDataSource(segment.path.absolutePath)
                    assertEquals(1,extractor.trackCount)
                    val format=extractor.getTrackFormat(0)
                    assertEquals("video/avc",format.getString(MediaFormat.KEY_MIME))
                    assertEquals(size.width,format.getInteger(MediaFormat.KEY_WIDTH))
                    assertEquals(size.height,format.getInteger(MediaFormat.KEY_HEIGHT))
                    extractor.selectTrack(0)
                    assertTrue(extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
                    assertEquals(0L,extractor.sampleTime)
                    do {pts+=segment.firstPtsUs+extractor.sampleTime} while(extractor.advance())
                } finally {extractor.release()}
                entries.put(JSONObject().put("file",segment.path.name).put("firstPtsUs",segment.firstPtsUs)
                    .put("lastPtsUs",segment.lastPtsUs).put("bytes",segment.byteLength))
            }
            assertTrue(pts.zipWithNext().all{(a,b)->b>a})
            assertTrue("Deliberate gap was lost",pts.zipWithNext().any{(a,b)->b-a>=800_000})
            fun phase(counter:VideoEncoderTimings.Counter):JSONObject {
                val values=counter.snapshot().sorted()
                return JSONObject().put("count",values.size).put("p50Ns",values.getOrElse(values.size/2){0})
                    .put("p95Ns",values.getOrElse(((values.size-1)*.95).toInt().coerceAtLeast(0)){0})
            }
            val manifest=JSONObject().put("adapter",adapter).put("synthetic",true)
                .put("wallEpochMs",encoder.timeAnchor.wallEpochMs).put("elapsedAnchorNanos",encoder.timeAnchor.elapsedAnchorNanos)
                .put("width",size.width).put("height",size.height).put("finishMs",finishMs)
                .put("segments",entries).put("acceptedPtsUs",JSONArray(accepted)).put("outputPtsUs",JSONArray(pts))
                .put("rgbReadNs",phase(encoder.timings.rgbReadNs)).put("yuvConversionNs",phase(encoder.timings.yuvConversionNs))
                .put("textureUploadNs",phase(encoder.timings.textureUploadNs))
                .put("inputSubmissionNs",phase(encoder.timings.inputSubmissionNs)).put("outputDrainNs",phase(encoder.timings.outputDrainNs))
                .put("expectedQuadrants","top-left red; top-right green; bottom-left blue; bottom-right white")
            File(directory,"manifest.json").writeText(manifest.toString(2))
            Log.i("TraceItXEncoderFixture",manifest.toString())
            // MPEG4Writer uses 90kHz ticks AND groups near-equal durations by <100us.
            // Permit <100us grouping plus <=6us tick conversion, preserving ordered 1:1 frames.
            // https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/libstagefright/MPEG4Writer.cpp
            assertEquals(accepted.size,pts.size)
            assertTrue("Container PTS drift exceeds grouping plus tick rounding",
                pts.zip(accepted).all{(output,input)->kotlin.math.abs(output-input)<=106})
            if(egl) onWorker {assertEquals(android.opengl.EGL14.EGL_NO_CONTEXT,android.opengl.EGL14.eglGetCurrentContext())}
            // Intentionally retain synthetic closed artifacts for controller full-decode inspection.
        } finally {encoder.close()}
    }
    private fun onWorker(block:()->Unit) {
        val latch=CountDownLatch(1);val error=AtomicReference<Throwable?>()
        AndroidVideoCaptureScheduler.worker {try{block()}catch(t:Throwable){error.set(t)}finally{latch.countDown()}}
        assertTrue("Capture worker did not return",latch.await(3,TimeUnit.SECONDS))
        error.get()?.let{throw it}
    }
}
