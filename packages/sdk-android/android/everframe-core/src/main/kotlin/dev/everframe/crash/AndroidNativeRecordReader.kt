// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import kotlinx.serialization.json.*
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.StandardOpenOption
import java.nio.file.Files
import java.nio.file.attribute.BasicFileAttributes
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Qualification EVQC v1: authenticate before parsing; never a minidump reader. */
@androidx.annotation.RequiresApi(26)
internal object AndroidNativeRecordReader {
    const val MAX_BYTES = 4096
    private val header = byteArrayOf(69,86,81,67,1,0,0,0)
    /** Null only when no usable record exists: absent, not a regular file (a symlink
     * included) or outside the size bound. Other read failures throw. */
    fun readFile(file: File): ByteArray? = try {
        val path=file.toPath()
        val attributes=Files.readAttributes(path,BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS)
        if (!attributes.isRegularFile || attributes.size() !in 36..MAX_BYTES.toLong()) null
        else FileChannel.open(path,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS).use { channel ->
            val buffer=ByteBuffer.allocate(MAX_BYTES+1)
            while(buffer.hasRemaining() && channel.read(buffer)>=0) { }
            if(buffer.position()>MAX_BYTES) null else buffer.array().copyOf(buffer.position())
        }
    } catch(_:NoSuchFileException) { null }

    fun open(bytes: ByteArray,key: ByteArray,epoch: String,createdAt: Long,nowMs: Long): JsonObject? = try {
        require(bytes.size in 36..MAX_BYTES && key.size==32 && bytes.copyOfRange(0,8).contentEquals(header))
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,bytes.copyOfRange(8,20)))
        cipher.updateAAD(header)
        val plain=cipher.doFinal(bytes,20,bytes.size-20)
        val record=try { Json.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject } finally { plain.fill(0) }
        require(record["version"]?.jsonPrimitive?.int==1 && record["epoch"]?.jsonPrimitive?.content==epoch)
        val identity = listOf("reportId", "owner", "release").map { record[it]?.jsonPrimitive?.content }
        require(identity == listOf("android-qualification", "anonymous-qualification", "frozen-native-qualification") ||
            identity == listOf(epoch, "anonymous", "frozen"))
        require(record["partial"]?.jsonPrimitive?.boolean==true)
        val signal=record.getValue("signal").jsonPrimitive.int;require(signal in 1..64)
        // Records written before signal codes were captured have none.
        val code=record["signalCode"]?.jsonPrimitive?.long;require(code==null || code in Int.MIN_VALUE..Int.MAX_VALUE)
        val tid=record.getValue("threadId").jsonPrimitive.long;require(tid in 1..4294967295L)
        val captured=record.getValue("snapshotTimeMs").jsonPrimitive.long
        // Both clocks are wall clocks. A clock adjustment is not evidence that an
        // authenticated native record is invalid; age is applied by the importer.
        require(captured > 0)
        val abi=when(record.getValue("architecture").jsonPrimitive.int) { 1->"x86";2->"x86_64";3->"armeabi-v7a";4->"arm64-v8a";else->error("architecture") }
        // A fault PC outside one nameable loaded module is recorded without a frame.
        val frame=if("module" !in record) { require(frameFields.none { it in record });null } else {
            fun address(name:String)=record.getValue(name).jsonPrimitive.content.toULong()
            val pc=address("pc");val base=address("moduleBase");val relative=address("moduleOffset")
            require(pc>0u && pc>=base && pc-base==relative)
            val module=record.getValue("module").jsonPrimitive.also { require(it.isString) }.content
            val build=record["buildId"]?.jsonPrimitive?.also { require(it.isString) }?.content
            require(moduleName(module) && (build==null || build.matches(Regex("(?:[0-9a-f]{2}){1,64}"))))
            buildJsonObject { put("pc","0x${pc.toString(16)}");put("relativePc","0x${relative.toString(16)}");put("module",module);if(build!=null) put("buildId",build) }
        }
        buildJsonObject {
            put("source","android-native-handler");put("abi",abi);put("crashedThreadId",tid);put("framesIncomplete",true);put("signalNumber",signal)
            if(code!=null) put("signalCode",code)
            put("frames",buildJsonArray { if(frame!=null) add(frame) })
            // Internal projection field, removed before serializing AndroidNativeMetadata.
            put("snapshotTimeMs",captured)
        }
    } catch(_:Exception) { null }
    private val frameFields=listOf("pc","moduleBase","moduleOffset","buildId")
    /** The report protocol's module rule: 1..256 UTF-16 units, well-formed, and no
     * path separator or control character. */
    private fun moduleName(text:String):Boolean {
        if(text.length !in 1..256 || text.any { it=='/' || it=='\\' || it.code<32 || it.code==127 }) return false
        var index=0
        while(index<text.length) {
            val c=text[index]
            if(c.isLowSurrogate() || (c.isHighSurrogate() && (index+1==text.length || !text[index+1].isLowSurrogate()))) return false
            index+=if(c.isHighSurrogate()) 2 else 1
        }
        return true
    }
}
