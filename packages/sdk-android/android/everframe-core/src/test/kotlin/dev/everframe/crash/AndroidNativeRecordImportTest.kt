// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class AndroidNativeRecordImportTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private var interruptRemoval = false
    private var failCapsuleSync = false
    private val ops = object : OutboxFileOps by JvmOutboxFileOps() {
        override fun syncDirectory(dir: File) {
            if(failCapsuleSync && dir.name=="capsules") throw java.io.IOException("capsule revocation sync failure")
            JvmOutboxFileOps().syncDirectory(dir)
            if (interruptRemoval && dir.name == "active" && dir.parentFile?.name == "capsules" && dir.listFiles().orEmpty().none { it.extension == "txq" }) {
                interruptRemoval = false; throw java.io.IOException("source removal interrupted")
            }
        }
    }
    private fun store(name: String, count: Int = 8) = OutboxStore(File(folder.root, name), keys, ops, count, 2*1024*1024)
    private fun importer() = AndroidNativeRecordImport(store("capsules"), store("prepared"))
    private fun template() : OutboxEntry {
        val id = UUID.randomUUID().toString()
        return OutboxEntry(id,1000,"""{"reportId":"$id","submittedAt":"2026-10-08T00:00:00Z","context":{"app":{"name":"old","version":"1","build":"old-build"}},"reporter":{"title":"","description":""},"payload":{}}""".toByteArray(),"template",emptyList(),"old-key","https://old.example")
    }
    private data class Armed(val template: OutboxEntry, val epoch: String, val key: ByteArray)
    private fun arm(engine: AndroidNativeRecordImport = importer()): Armed {
        val value = template(); var retained = byteArrayOf(); var epoch = ""
        engine.arm(value,"previous-process",allowed) { e,k -> epoch=e;retained=k.copyOf();true }
        return Armed(value,epoch,retained)
    }
    private fun cipher(a: Armed, epoch: String = a.epoch, plain: String? = null, captured: Long = 2000, production: Boolean = false): ByteArray {
        val header = byteArrayOf(69,86,81,67,1,0,0,0); val nonce=ByteArray(12).also { SecureRandom().nextBytes(it) }
        val text=plain ?: """{"version":1,"reportId":"android-qualification","epoch":"$epoch","owner":"anonymous-qualification","release":"frozen-native-qualification","signal":11,"architecture":4,"threadId":99,"snapshotTimeMs":2000,"pc":4112,"moduleBase":4096,"moduleOffset":16,"module":"libfault.so","buildId":"aabb","partial":true}"""
        val finalText=text.replace("\"snapshotTimeMs\":2000", "\"snapshotTimeMs\":$captured").let { if(production) it.replace("android-qualification",epoch).replace("anonymous-qualification","anonymous").replace("frozen-native-qualification","frozen") else it }
        val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,SecretKeySpec(a.key,"AES"),GCMParameterSpec(128,nonce));c.updateAAD(header)
        return header+nonce+c.doFinal(finalText.toByteArray())
    }
    @Test fun `capsule is encrypted and durable before provisioning and temporary key is cleared`() {
        val value=template();var borrowed:ByteArray?=null
        importer().arm(value,"old",allowed) { epoch,key ->
            borrowed=key;assertEquals(value.reportId.replace("-",""),epoch);assertEquals(1,store("capsules").snapshotTokens().size)
            val disk=folder.root.walkTopDown().filter { it.isFile }.flatMap { it.readBytes().asSequence() }.toList().toByteArray().toString(Charsets.ISO_8859_1)
            assertFalse(disk.contains("old-key"));assertFalse(disk.contains("old-build"));true
        }
        assertTrue(borrowed!!.all { it==0.toByte() })
    }
    @Test fun `relaunch imports into real outbox with frozen ownership and native provenance`() {
        val a=arm();val bytes=cipher(a);val main=store("main")
        assertEquals(1,importer().recover("new-process",3000,allowed,{ bytes }) { it, admission -> main.enqueueSync(it,admission);true })
        val e=main.readIfPresent(main.snapshotTokens().single())!!.entry
        assertEquals(a.template.reportId,e.reportId);assertEquals("old-key",e.sdkKey);assertEquals("https://old.example",e.endpoint);assertNull(e.identitySubject)
        val j=Json.parseToJsonElement(e.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        assertEquals("old-build",j["context"]!!.jsonObject["app"]!!.jsonObject["build"]!!.jsonPrimitive.content)
        val crash=j["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("android-native-handler",crash["androidNative"]!!.jsonObject["source"]!!.jsonPrimitive.content)
        assertEquals("1970-01-01T00:00:02Z",crash["occurredAt"]!!.jsonPrimitive.content)
        assertEquals(0,importer().recover("newer",4000,allowed,{ bytes }) { it, admission -> error("duplicate") })
    }
    @Test fun `current process and wrong epoch cannot import`() {
        val a=arm();assertEquals(0,importer().recover("previous-process",3000,allowed,{ cipher(a) }) { it, admission -> error("live") })
        assertEquals(0,importer().recover("new",3000,allowed,{ cipher(a,"0".repeat(32)) }) { it, admission -> error("epoch") })
    }
    @Test fun `authenticates header ciphertext and tag before parsing`() {
        val a=arm();val good=cipher(a)
        for(index in listOf(0,10,25,good.lastIndex)) {
            val bad=good.copyOf();bad[index]=(bad[index].toInt() xor 1).toByte()
            assertEquals(0,importer().recover("new",3000,allowed,{ bad }) { it, admission -> error("unauthenticated") })
        }
        assertEquals(1,importer().recover("new",3000,allowed,{ good }) { it, admission -> true })
    }
    @Test fun `capacity failure retains immutable prepared bytes after later native file loss`() {
        val a=arm();var first:OutboxEntry?=null
        assertEquals(0,importer().recover("new",3000,allowed,{ cipher(a) }) { it, admission -> first=it;false })
        assertEquals(1,store("prepared").snapshotTokens().size)
        assertEquals(1,importer().recover("later",5000,allowed,{ null }) { it, admission -> assertEquals(first,it);true })
    }
    @Test fun `source cleanup interruption cannot reenqueue after the durable source is gone`() {
        val a=arm();var first:OutboxEntry?=null
        try { importer().recover("new",3000,allowed,{ cipher(a) }) { it, admission -> first=it;interruptRemoval=true;true };fail("injection") } catch(_:OutboxWriteException) {}
        assertNotNull(first)
        assertEquals(0,importer().recover("later",5000,allowed,{ null }) { it, admission -> error("already admitted source was removed") })
        assertTrue(store("prepared").snapshotTokens().isEmpty())
    }
    @Test fun `revocation and stale authorization cannot resurrect capsules`() {
        val a=arm();val old=importer();old.revoke()
        assertEquals(0,importer().recover("new",3000,allowed,{ cipher(a) }) { it, admission -> error("revoked") })
        val b=arm();val denied=object:OutboxAuthorization { override fun isAllowed()=false }
        assertEquals(0,importer().recover("new",3000,denied,{ cipher(b) }) { it, admission -> error("stale") })
    }
    @Test fun `expired authenticated record is removed after checking capture time`() {
        val a=arm();assertEquals(0,importer().recover("new",15L*24*60*60*1000,allowed,{ cipher(a) }) { it, admission -> error("expired") })
        assertTrue(store("capsules").snapshotTokens().isEmpty())
    }
    @Test fun `launches that end without a native fault retire their capsules`() {
        repeat(9) { i ->
            assertEquals(0,importer().recover("launch-$i",2000,allowed,{ null }) { _, _ -> error("no fault") })
            assertTrue(importer().arm(template(),"launch-$i",allowed) { _,_ -> true })
        }
        // The current launch may still fault, so its capsule survives a missing record.
        assertEquals(0,importer().recover("launch-8",3000,allowed,{ null }) { _, _ -> error("live") })
        assertEquals(1,store("capsules").snapshotTokens().size)
    }
    @Test fun `native record that cannot be read keeps its capsule`() {
        val a=arm();val file=File(folder.root,"record").apply { writeBytes(cipher(a));setReadable(false) }
        org.junit.Assume.assumeFalse("needs a user that file permissions apply to",file.canRead())
        try { importer().recover("new",3000,allowed,{ AndroidNativeRecordReader.readFile(file) }) { _, _ -> error("unreadable") } } catch(_:java.io.IOException) {}
        file.setReadable(true)
        assertEquals(1,importer().recover("later",4000,allowed,{ AndroidNativeRecordReader.readFile(file) }) { _, _ -> true })
    }
    @Test fun `full main outbox preserves prepared import until capacity returns`() {
        val a=arm();val main=store("bounded",1);val other=template();main.enqueueSync(other,allowed)
        assertEquals(0,importer().recover("new",3000,allowed,{cipher(a)}) { it, admission -> try { main.enqueueSync(it,admission);true } catch(_:OutboxWriteException) { false } })
        main.removeIfPresent(main.snapshotTokens().single())
        assertEquals(1,importer().recover("later",4000,allowed,{null}) { it, admission -> main.enqueueSync(it,admission);true })
        assertEquals(a.template.reportId,main.readIfPresent(main.snapshotTokens().single())!!.entry.reportId)
    }
    @Test fun `failed producer shutdown still erases both durable stores`() {
        val a=arm();importer().recover("new",3000,allowed,{cipher(a)}) { it, admission -> false }
        val engine=importer()
        try { engine.revoke { false };fail("must report producer failure") } catch(_:IllegalStateException) {}
        assertTrue(store("capsules").snapshotTokens().isEmpty());assertTrue(store("prepared").snapshotTokens().isEmpty())
        assertEquals(0,engine.recover("later",4000,allowed,{cipher(a)}) { it, admission -> error("old lease") })
    }
    @Test fun `authorization changing during provision removes unadmitted capsule`() {
        var yes=true;val gate=object:OutboxAuthorization { override fun isAllowed()=yes }
        try { importer().arm(template(),"old",gate) { _,_->yes=false;true };fail("stale provision") } catch(_:OutboxWriteException) {}
        assertTrue(store("capsules").snapshotTokens().isEmpty())
    }
    @Test fun `prepared record also expires and cannot survive erasure boundary`() {
        val a=arm();importer().recover("new",3000,allowed,{cipher(a)}) { it, admission -> false }
        assertEquals(0,importer().recover("later",15L*24*60*60*1000,allowed,{error("expired")}) { it, admission -> error("expired prepared") })
        assertTrue(store("capsules").snapshotTokens().isEmpty());assertTrue(store("prepared").snapshotTokens().isEmpty())
    }
    @Test fun `invalid native addresses time and thread identity cannot be projected`() {
        val a=arm()
        for(plain in listOf("{}", "[]", "not json")) assertEquals(0,importer().recover("new",3000,allowed,{cipher(a,plain=plain)}) { it, admission -> error("invalid") })
        assertNull(AndroidNativeRecordReader.open(ByteArray(4097),a.key,a.epoch,1000,3000))
    }
    @Test fun `native source reader refuses symlinks and oversize files`() {
        val file=File(folder.root,"native").apply { writeBytes(ByteArray(4097)) }
        assertNull(AndroidNativeRecordReader.readFile(file))
        file.writeBytes(ByteArray(40))
        val link=File(folder.root,"link");java.nio.file.Files.createSymbolicLink(link.toPath(),file.toPath())
        assertNull(AndroidNativeRecordReader.readFile(link))
    }

    @Test fun `grouping uses ELF relative identity rather than ASLR absolute PC`() {
        val a=arm();var first:OutboxEntry?=null
        importer().recover("new",3000,allowed,{cipher(a)}) { it, admission -> first=it;true }
        val b=arm();val shifted="""{"version":1,"reportId":"android-qualification","epoch":"${b.epoch}","owner":"anonymous-qualification","release":"frozen-native-qualification","signal":11,"architecture":4,"threadId":100,"snapshotTimeMs":2000,"pc":8208,"moduleBase":8192,"moduleOffset":16,"module":"libfault.so","buildId":"aabb","partial":true}"""
        var second:OutboxEntry?=null;importer().recover("new",3000,allowed,{cipher(b,plain=shifted)}) { it, admission -> second=it;true }
        fun fingerprint(e:OutboxEntry)=Json.parseToJsonElement(e.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject["fingerprint"]
        assertEquals(fingerprint(first!!),fingerprint(second!!))
    }

    @Test fun `capsule revocation interrupted before prepared erasure cannot reauthorize prepared report`() {
        val a=arm();importer().recover("new",3000,allowed,{cipher(a)}) { it, admission -> false }
        store("capsules").revokeSync() // crash before the second store is erased
        assertEquals(1,store("prepared").snapshotTokens().size)
        assertEquals(0,importer().recover("newer",4000,allowed,{cipher(a)}) { it, admission -> error("revoked capsule must fence prepared admission") })
    }

    @Test fun `failed capsule erasure still clears prepared and cannot rearm until reconciled`() {
        val a=arm();importer().recover("new",3000,allowed,{cipher(a)}) { it, admission -> false };val engine=importer()
        failCapsuleSync=true
        try { engine.revoke();fail("injection") } catch(_:Exception) {}
        assertTrue(store("prepared").snapshotTokens().isEmpty())
        assertEquals(0,engine.recover("later",4000,allowed,{cipher(a)}) { it, admission -> error("revoked") })
        try { importer().arm(template(),"next",allowed) { _,_->error("must not provision") };fail("pending erasure") } catch(_:OutboxWriteException) {}
        failCapsuleSync=false;importer().revoke()
        assertEquals(0,importer().recover("later",4000,allowed,{cipher(a)}) { it, admission -> error("resurrected") })
    }
    @Test fun `revocation while native bytes are read fences prepared admission`() {
        val a=arm();var active=true;val gate=object:OutboxAuthorization { override fun isAllowed()=active }
        try { importer().recover("new",3000,gate,{active=false;cipher(a)}) { it, admission -> error("stale") };fail("revoked") } catch(_:OutboxWriteException) {}
        assertTrue(store("prepared").snapshotTokens().isEmpty())
    }

    @Test fun `revocation at main outbox admission cannot leave a newly queued report`() {
        val engine=importer();val a=arm(engine);val main=store("main")
        try { engine.recover("new",3000,allowed,{cipher(a)}) { entry, admission ->
            engine.revoke()
            main.enqueueSync(entry,admission)
            true
        } } catch(_:OutboxWriteException) {}
        assertTrue(main.snapshotTokens().isEmpty())
    }

    @Test fun `production native identity imports with original anonymous capsule`() {
        val a=arm();val main=store("main")
        assertEquals(1,importer().recover("next",3000,allowed,{ cipher(a,production=true) }) { e,g -> main.enqueueSync(e,g);true })
        assertEquals(a.template.reportId,main.readIfPresent(main.snapshotTokens().single())!!.entry.reportId)
    }
    @Test fun `fresh crash after long process uptime survives arm age`() {
        val a=arm();val now=AndroidNativeRecordImport.MAX_AGE_MS+6000
        assertEquals(1,importer().recover("next",now,allowed,{ cipher(a,captured=now-1000) }) { _,_ -> true })
    }
    @Test fun `clock rollback cannot retire current process capsule`() {
        arm()
        assertEquals(0,importer().recover("previous-process",999,allowed,{ error("live") }) { _,_ -> error("live") })
        assertEquals(1,store("capsules").snapshotTokens().size)
    }
    @Test fun `clock rollback still authenticates previous process crash`() {
        val a=arm()
        assertEquals(1,importer().recover("next",500,allowed,{cipher(a)}) { _,_ -> true })
    }
    @Test fun `fresh late crash keeps prepared receipt for retry`() {
        val a=arm();val now=AndroidNativeRecordImport.MAX_AGE_MS+6000
        var staged:OutboxEntry?=null
        assertEquals(0,importer().recover("next",now,allowed,{cipher(a,captured=now-1000)}) { e,_ -> staged=e;false })
        assertNotNull(staged)
        assertEquals(1,importer().recover("later",now+1000,allowed,{null}) { e,_ -> assertEquals(staged,e);true })
    }

}
