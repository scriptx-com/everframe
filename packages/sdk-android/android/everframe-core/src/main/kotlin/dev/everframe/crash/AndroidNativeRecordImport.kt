// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import dev.everframe.health.NativeExposurePointer
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Durable import primitive. No signal installation or public SDK activation API.
 * [delivered] receipts name ended launches whose report entered the outbox (see [captured]). A receipt
 * lasts as long as the exit-info context of its launch, which exit recovery reports through
 * [retainReceipts], and at most [MAX_RECEIPTS] are kept; it never expires by age, because a matched
 * exit-info context is reported however far the clock moved. */
@androidx.annotation.RequiresApi(26)
internal class AndroidNativeRecordImport(private val capsules:OutboxStore,private val prepared:OutboxStore,private val delivered:OutboxStore?=null) {
    companion object {
        const val MAX_AGE_MS=14L*24*60*60*1000; private const val MAX_CONTEXT=65536; private const val MAX_RECEIPTS=8
        /** More than 14 days apart in either direction, so a wall clock that jumps back cannot keep a record forever. */
        fun expired(createdAt:Long,nowMs:Long)=kotlin.math.abs(nowMs-createdAt)>MAX_AGE_MS
    }
    private val revision=AtomicLong()
    private fun gate(captured:Long,authorization:OutboxAuthorization)=object:OutboxAuthorization {
        override fun isAllowed()=revision.get()==captured && capsules.hasCurrentLease() && prepared.hasCurrentLease() && authorization.isAllowed()
    }
    private fun check(gate:OutboxAuthorization) { if(!gate.isAllowed()) throw OutboxWriteException(OutboxFailure.REVOKED,IllegalStateException("Native import revoked")) }
    private fun digest(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun template(entry:OutboxEntry):JsonObject {
        require(UUID.fromString(entry.reportId).toString()==entry.reportId && entry.envelopeBytes.size<=MAX_CONTEXT)
        require(entry.identitySubject==null && entry.attachmentRefs.isEmpty())
        val root=Json.parseToJsonElement(entry.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        require(root["reportId"]?.jsonPrimitive?.content==entry.reportId && root["payload"]?.jsonObject?.isEmpty()==true)
        require(root["sessionId"]==null || root["sessionId"]==JsonNull)
        require(root["reporter"]?.jsonObject?.get("user")==null || root["reporter"]?.jsonObject?.get("user")==JsonNull)
        return root
    }

    /** Provision callback is synchronous; borrowed key bytes are cleared on every exit. */
    @Synchronized fun arm(value:OutboxEntry,processLaunchId:String,authorization:OutboxAuthorization,nativeExposure:NativeExposurePointer?=null,provision:(String,ByteArray)->Boolean):Boolean {
        require(processLaunchId.isNotBlank() && processLaunchId.length<=128)
        require(nativeExposure==null || (nativeExposure.valid() && nativeExposure.processLaunchId==processLaunchId))
        val frozen=template(value);val gate=gate(revision.get(),authorization);check(gate)
        val key=ByteArray(32).also { SecureRandom().nextBytes(it) };val epoch=value.reportId.replace("-","")
        var token:OutboxToken?=null
        try {
            val capsule=buildJsonObject { put("version",1);put("launch",processLaunchId);put("key",Base64.getEncoder().encodeToString(key));put("envelope",frozen);if(nativeExposure!=null) put("nativeExposure",nativeExposure.toJson()) }.toString().toByteArray()
            require(capsule.size<=MAX_CONTEXT)
            token=capsules.enqueueSync(value.copy(envelopeBytes=capsule,idempotencyKey=digest(capsule)),gate)
            check(gate)
            if(!provision(epoch,key)) { capsules.removeIfPresent(token);return false }
            check(gate);return true
        } catch(error:Exception) {
            if(token!=null) try { capsules.removeIfPresent(token) } catch(cleanup:Exception) { error.addSuppressed(cleanup) }
            throw error
        } finally { key.fill(0) }
    }

    /** Reader owns a bounded no-follow read and returns null only when no usable record
     * exists; it throws when it cannot tell. Admission MUST pass its supplied gate to
     * the durable outbox write, and return true only after that write commits.
     * Supported model: process death, then relaunch. A capsule from another launch that
     * has no record is retired, since that launch ended without a captured fault, so
     * recover on every launch to keep per-launch arm() within the capsule store bound. */
    @Synchronized fun recover(currentProcessLaunchId:String,nowMs:Long,authorization:OutboxAuthorization,readRecord:(String)->ByteArray?,admit:(OutboxEntry,OutboxAuthorization)->Boolean):Int {
        val gate=gate(revision.get(),authorization);if(!gate.isAllowed()) return 0
        var count=drain(nowMs,gate,admit)
        val ready=prepared.snapshotTokens().mapNotNull { prepared.readIfPresent(it)?.entry?.reportId }.toSet()
        for(token in capsules.snapshotTokens()) {
            if(!gate.isAllowed()) break
            val context=capsules.readIfPresent(token)?.entry ?: continue
            if(context.reportId in ready) continue
            val capsule=try { require(context.envelopeBytes.size<=MAX_CONTEXT);Json.parseToJsonElement(context.envelopeBytes.toString(Charsets.UTF_8)).jsonObject } catch(_:Exception) { continue }
            if(capsule["version"]?.jsonPrimitive?.intOrNull!=1 || capsule["launch"]?.jsonPrimitive?.content==currentProcessLaunchId) continue
            val key=try { Base64.getDecoder().decode(capsule.getValue("key").jsonPrimitive.content) } catch(_:Exception) { continue }
            val native=try {
                val bytes=readRecord(context.reportId.replace("-",""))
                // An ended launch that left no record can never produce one.
                if(bytes==null) { capsules.removeIfPresent(token);continue }
                AndroidNativeRecordReader.open(bytes,key,context.reportId.replace("-",""),context.createdAt,nowMs)
            } finally { key.fill(0) }
            // Both are wall clocks. An unreadable record expires 14 days from its capsule in either clock
            // direction; an authenticated one is reported however far the clock moved.
            if (native == null) {
                if (expired(context.createdAt, nowMs)) capsules.removeIfPresent(token)
                continue
            }
            check(gate)
            val frozen=capsule.getValue("envelope").jsonObject
            val original=context.copy(envelopeBytes=frozen.toString().toByteArray())
            template(original)
            val report=report(original,frozen,native,nowMs, (capsule["nativeExposure"] as? JsonObject)?.let(NativeExposurePointer::parse)?.takeIf { it.processLaunchId == capsule["launch"]?.jsonPrimitive?.content })
            prepared.enqueueSync(report,gate)
            count+=drain(nowMs,gate,admit)
        }
        return count
    }
    private fun drain(nowMs:Long,gate:OutboxAuthorization,admit:(OutboxEntry,OutboxAuthorization)->Boolean):Int {
        var count=0
        for(token in prepared.snapshotTokens()) {
            if(!gate.isAllowed()) break
            // Reconcile the capsule store's durable revocation intent first. A prepared
            // receipt never becomes independent delivery authority after capsule erasure.
            val owners=capsules.snapshotTokens().mapNotNull { capsules.readIfPresent(it)?.entry?.reportId }.toSet()
            val entry=prepared.readIfPresent(token)?.entry ?: continue
            if(entry.reportId !in owners) { prepared.removeIfPresent(token);continue }
            check(gate)
            // Offered before its age is judged: a clock jump alone never drops a report unseen.
            if(!admit(entry,gate)) {
                if(expired(entry.createdAt,nowMs)) { removeCapsules(entry.reportId);prepared.removeIfPresent(token) }
                continue
            }
            check(gate)
            receipt(entry,nowMs,gate)
            removeCapsules(entry.reportId)
            prepared.removeIfPresent(token);count++
        }
        return count
    }
    private fun launchOf(entry:OutboxEntry)=try { Json.parseToJsonElement(entry.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["launch"]?.jsonPrimitive?.contentOrNull } catch(_:Exception) { null }
    /** Written before the capsule goes, so a captured launch always has a capsule or a receipt.
     * Best effort and bounded: a lost receipt can only let exit-info report the fault again. The
     * exit-info journal holds at most 8 contexts, one of them the live process's, so the 8 newest
     * receipts cover every ended launch it can still report. */
    private fun receipt(report:OutboxEntry,nowMs:Long,gate:OutboxAuthorization) {
        val store=delivered ?: return
        try {
            val launch=capsules.snapshotTokens().firstNotNullOfOrNull { token -> capsules.readIfPresent(token)?.entry?.takeIf { it.reportId==report.reportId } }?.let(::launchOf) ?: return
            store.snapshotTokens().dropLast(MAX_RECEIPTS-1).forEach { store.removeIfPresent(it) }
            val bytes=buildJsonObject { put("version",1);put("launch",launch) }.toString().toByteArray()
            store.enqueueSync(OutboxEntry(report.reportId,nowMs,bytes,digest(bytes),emptyList(),"",""),gate)
        } catch(_:Exception) {}
    }
    /** Exit-info recovery finished with contexts for [launches] only: every other receipt has no OS
     * exit left to settle, including the one whose context recovery just retired as delivered. */
    @Synchronized fun retainReceipts(launches:Set<String>) {
        val store=delivered ?: return
        try {
            for(token in store.snapshotTokens()) {
                if(store.readIfPresent(token)?.entry?.let(::launchOf) !in launches) store.removeIfPresent(token)
            }
        } catch(_:Exception) {}
    }
    /** Exit-info coordination for an ended launch's native fault; never imports, admits or retires. */
    @Synchronized fun captured(launch:String,nowMs:Long,readRecord:(String)->ByteArray?):NativeSignalCapture {
        // An unreadable receipt store still lets a held record be found below.
        delivered?.let { store -> if(runCatching { store.snapshotTokens().any { store.readIfPresent(it)?.entry?.let(::launchOf)==launch } }.getOrDefault(false)) return NativeSignalCapture.DELIVERED }
        for(token in capsules.snapshotTokens()) {
            val context=capsules.readIfPresent(token)?.entry ?: continue
            val capsule=try { Json.parseToJsonElement(context.envelopeBytes.toString(Charsets.UTF_8)).jsonObject } catch(_:Exception) { continue }
            if(capsule["version"]?.jsonPrimitive?.intOrNull!=1 || capsule["launch"]?.jsonPrimitive?.contentOrNull!=launch) continue
            val key=try { Base64.getDecoder().decode(capsule.getValue("key").jsonPrimitive.content) } catch(_:Exception) { continue }
            val epoch=context.reportId.replace("-","")
            // Only a record that recovery would import counts; anything else is the OS exit's to report.
            try { readRecord(epoch)?.let { AndroidNativeRecordReader.open(it,key,epoch,context.createdAt,nowMs) } } finally { key.fill(0) } ?: continue
            return NativeSignalCapture.PENDING
        }
        return NativeSignalCapture.NONE
    }
    @Synchronized fun retainedEpochs(): Set<String> = capsules.snapshotTokens().mapNotNull {
        capsules.readIfPresent(it)?.entry?.reportId?.replace("-", "")
    }.toSet()
    /** Retire only the current live process's armed context after its producer is paused. */
    @Synchronized fun retireArmed(reportId: String) { removeCapsules(reportId) }
    private fun removeCapsules(id:String) { for(token in capsules.snapshotTokens()) if(capsules.readIfPresent(token)?.entry?.reportId==id) capsules.removeIfPresent(token) }
    private fun report(context:OutboxEntry,frozen:JsonObject,record:JsonObject,nowMs:Long,nativeExposure:NativeExposurePointer?=null):OutboxEntry {
        val timestamp=record.getValue("snapshotTimeMs").jsonPrimitive.long
        val native=JsonObject(record-"snapshotTimeMs")
        val frames=native.getValue("frames").jsonArray;require(frames.size<=1)
        val frame=frames.firstOrNull()?.jsonObject
        val raw=frame?.let { "${it.getValue("module").jsonPrimitive.content} ${it.getValue("relativePc").jsonPrimitive.content}" }
        val kind="Native signal ${native.getValue("signalNumber").jsonPrimitive.int}"
        // A frame groups by its ELF-relative identity. A frameless fault groups by signal,
        // with the same key as an OS exit-info report without frames.
        val key=if(frame==null) "$kind|" else kind+(frame["buildId"]?.jsonPrimitive?.content ?: "")+":"+raw
        val crash=buildJsonObject {
            put("exceptionType",kind);put("message",if(frame==null) "Native fault (partial handler snapshot without a module frame)" else "Native fault (partial handler snapshot)")
            put("mechanism","android-native-handler");put("handled",false);put("fatal",true)
            put("occurredAt",Instant.ofEpochMilli(timestamp).toString());put("timestampSource","handler-snapshot")
            put("fingerprint",digest(key.toByteArray()).take(16))
            if(nativeExposure!=null) put("nativeExposure",nativeExposure.toJson())
            put("frames",buildJsonArray { if(raw!=null) add(buildJsonObject { put("raw",raw) }) });put("androidNative",native)
        }
        // A clock that moved back since the fault never makes submission precede it. The crash-only
        // envelope has no evidence timestamp the protocol compares, but keep the order consistent.
        val submitted=maxOf(nowMs,timestamp)
        val bytes=JsonObject(frozen+mapOf("source" to JsonPrimitive("crash"),"submittedAt" to JsonPrimitive(Instant.ofEpochMilli(submitted).toString()),"payload" to buildJsonObject { put("crash",crash) })).toString().toByteArray()
        // The retry window begins when a valid record is first recovered, not when
        // a potentially long-running process armed its crash context.
        return context.copy(createdAt=nowMs,envelopeBytes=bytes,idempotencyKey=digest(bytes))
    }
    fun invalidate() { revision.incrementAndGet();capsules.invalidateSync();prepared.invalidateSync();delivered?.invalidateSync() }
    /** Invalidate every generation before producer shutdown or any fallible disk operation. */
    fun revoke(stopProducer:()->Boolean={true}) {
        invalidate();var failure:Exception?=null
        try { check(stopProducer()) { "Native producer revocation failed" } } catch(error:Exception) { failure=error }
        for(store in listOfNotNull(capsules,prepared,delivered)) try { store.revokeSync() } catch(error:Exception) { if(failure==null) failure=error else failure.addSuppressed(error) }
        failure?.let { throw it }
    }
}
