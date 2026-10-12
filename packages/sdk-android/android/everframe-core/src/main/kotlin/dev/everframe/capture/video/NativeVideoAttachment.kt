// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import dev.everframe.protocol.generated.Attachment
import dev.everframe.protocol.generated.AttachmentKind
import dev.everframe.protocol.generated.Format
import dev.everframe.transport.ReportSubmitter
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

data class VideoAttachmentPair internal constructor(val envelope:Attachment,val part:ReportSubmitter.Attachment)

class NativeVideoAttachment internal constructor(private val scheduler:VideoCaptureScheduler,
    private val admission:VideoEncoderWorkerAdmission=VideoEncoderWorkerAdmission.export,
    private val openInput:(java.io.File)->java.io.InputStream={it.inputStream()}) {
    constructor():this(AndroidVideoExportScheduler)
    /** The clip is consumed on the shared worker, including cancellation and invalid bytes. */
    suspend fun build(clip:OwnedVideoClip):VideoAttachmentPair?=suspendCancellableCoroutine { continuation ->
        val admitted = admission.acquire()
        if (admitted == null) { clip.close(); continuation.resume(null); return@suspendCancellableCoroutine }
        val completion=VideoOperationCompletion()
        val enteredWorker=java.util.concurrent.atomic.AtomicBoolean()
        val deadline=scheduler.nowNanos()+3_000_000_000L
        val ticket:VideoEncoderWorkerAdmission.Ticket?=admitted
        val timer=scheduler.later(3_000) {
            completion.timeout {if(enteredWorker.get()) ticket?.quarantine();continuation.resume(null)}
        }
        continuation.invokeOnCancellation {completion.timeout {if(enteredWorker.get()) ticket?.quarantine()}}
        scheduler.worker {
            fun checkAllowed() {check(!completion.isCancelled && scheduler.nowNanos()<deadline && continuation.isActive)}
            val pair=try {
                checkAllowed()
                synchronized(completion) {checkAllowed();enteredWorker.set(true)}
                run {
                    val metadata=clip.metadata
                    require(metadata.byteLength in 1..VideoExporter.MAX_BYTES && clip.file.length()==metadata.byteLength)
                    val bytes=openInput(clip.file).use {input ->
                        val result=ByteArray(metadata.byteLength.toInt());var offset=0
                        while(offset<result.size) {checkAllowed();val count=input.read(result,offset,result.size-offset);require(count>0);offset+=count}
                        checkAllowed();require(input.read()==-1);result
                    }
                    require(sha256(bytes)==metadata.sha256);checkAllowed()
                    VideoAttachmentPair(Attachment(
                        byteLength=metadata.byteLength.toDouble(),contentType="video/mp4",
                        durationMS=metadata.durationMs.toDouble(),format=Format.EverframeVideoV1,
                        height=metadata.size.height.toDouble(),kind=AttachmentKind.SessionReplay,
                        partName="replay",replayStartEpochMS=metadata.replayStartEpochMs.toDouble(),
                        sha256=metadata.sha256,width=metadata.size.width.toDouble()),
                        ReportSubmitter.Attachment("replay","replay.mp4","video/mp4",bytes,metadata.sha256))
                }
            } catch(_:Throwable) {null} finally {
                clip.close();synchronized(completion){ticket?.close()};timer()
            }
            completion.finish {continuation.resume(pair)}
        }
    }
}
