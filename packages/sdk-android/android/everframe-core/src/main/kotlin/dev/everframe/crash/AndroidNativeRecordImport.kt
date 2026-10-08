// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Durable import primitive. No signal installation or public SDK activation API. */
@androidx.annotation.RequiresApi(26)
internal class AndroidNativeRecordImport(private val capsules:OutboxStore,private val prepared:OutboxStore) {
    companion object { const val MAX_AGE_MS=14L*24*60*60*1000; private const val MAX_CONTEXT=65536 }
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
    @Synchronized fun arm(value:OutboxEntry,processLaunchId:String,authorization:OutboxAuthorization,provision:(String,ByteArray)->Boolean):Boolean {
        require(processLaunchId.isNotBlank() && processLaunchId.length<=128)
        val frozen=template(value);val gate=gate(revision.get(),authorization);check(gate)
        val key=ByteArray(32).also { SecureRandom().nextBytes(it) };val epoch=value.reportId.replace("-","")
        var token:OutboxToken?=null
        try {
            val capsule=buildJsonObject { put("version",1);put("launch",processLaunchId);put("key",Base64.getEncoder().encodeToString(key));put("envelope",frozen) }.toString().toByteArray()
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
            if (native == null) {
                if (nowMs > context.createdAt && nowMs - context.createdAt > MAX_AGE_MS) capsules.removeIfPresent(token)
                continue
            }
            val capturedAt = native.getValue("snapshotTimeMs").jsonPrimitive.long
            if (nowMs > capturedAt && nowMs - capturedAt > MAX_AGE_MS) { capsules.removeIfPresent(token); continue }
            check(gate)
            val frozen=capsule.getValue("envelope").jsonObject
            val original=context.copy(envelopeBytes=frozen.toString().toByteArray())
            template(original)
            val report=report(original,frozen,native,nowMs)
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
            if(nowMs>entry.createdAt && nowMs-entry.createdAt>MAX_AGE_MS) { removeCapsules(entry.reportId);prepared.removeIfPresent(token);continue }
            check(gate)
            if(!admit(entry,gate)) continue
            check(gate)
            removeCapsules(entry.reportId)
            prepared.removeIfPresent(token);count++
        }
        return count
    }
    @Synchronized fun retainedEpochs(): Set<String> = capsules.snapshotTokens().mapNotNull {
        capsules.readIfPresent(it)?.entry?.reportId?.replace("-", "")
    }.toSet()
    /** Retire only the current live process's armed context after its producer is paused. */
    @Synchronized fun retireArmed(reportId: String) { removeCapsules(reportId) }
    private fun removeCapsules(id:String) { for(token in capsules.snapshotTokens()) if(capsules.readIfPresent(token)?.entry?.reportId==id) capsules.removeIfPresent(token) }
    private fun report(context:OutboxEntry,frozen:JsonObject,record:JsonObject,nowMs:Long):OutboxEntry {
        val timestamp=record.getValue("snapshotTimeMs").jsonPrimitive.long
        val native=JsonObject(record-"snapshotTimeMs")
        val frame=native.getValue("frames").jsonArray.single().jsonObject
        val raw="${frame.getValue("module").jsonPrimitive.content} ${frame.getValue("relativePc").jsonPrimitive.content}"
        val kind="Native signal ${native.getValue("signalNumber").jsonPrimitive.int}"
        val crash=buildJsonObject {
            put("exceptionType",kind);put("message","Native fault (partial handler snapshot)");put("mechanism","android-native-handler");put("handled",false);put("fatal",true)
            put("occurredAt",Instant.ofEpochMilli(timestamp).toString());put("timestampSource","handler-snapshot")
            put("fingerprint",digest((kind+frame.getValue("buildId").jsonPrimitive.content+":"+raw).toByteArray()).take(16))
            put("frames",buildJsonArray { add(buildJsonObject { put("raw",raw) }) });put("androidNative",native)
        }
        val bytes=JsonObject(frozen+mapOf("source" to JsonPrimitive("crash"),"submittedAt" to JsonPrimitive(Instant.ofEpochMilli(nowMs).toString()),"payload" to buildJsonObject { put("crash",crash) })).toString().toByteArray()
        // The retry window begins when a valid record is first recovered, not when
        // a potentially long-running process armed its crash context.
        return context.copy(createdAt=nowMs,envelopeBytes=bytes,idempotencyKey=digest(bytes))
    }
    fun invalidate() { revision.incrementAndGet();capsules.invalidateSync();prepared.invalidateSync() }
    /** Invalidate both generations before producer shutdown or any fallible disk operation. */
    fun revoke(stopProducer:()->Boolean={true}) {
        invalidate();var failure:Exception?=null
        try { check(stopProducer()) { "Native producer revocation failed" } } catch(error:Exception) { failure=error }
        for(store in listOf(capsules,prepared)) try { store.revokeSync() } catch(error:Exception) { if(failure==null) failure=error else failure.addSuppressed(error) }
        failure?.let { throw it }
    }
}
