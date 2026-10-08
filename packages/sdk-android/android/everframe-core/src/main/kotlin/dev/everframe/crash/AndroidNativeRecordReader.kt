// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import kotlinx.serialization.json.*
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.LinkOption
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
    fun readFile(file: File): ByteArray? = try {
        val path=file.toPath()
        val attributes=Files.readAttributes(path,BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS)
        if (!attributes.isRegularFile || attributes.size() !in 36..MAX_BYTES.toLong()) null
        else FileChannel.open(path,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS).use { channel ->
            val buffer=ByteBuffer.allocate(MAX_BYTES+1)
            while(buffer.hasRemaining() && channel.read(buffer)>=0) { }
            if(buffer.position()>MAX_BYTES) null else buffer.array().copyOf(buffer.position())
        }
    } catch(_:Exception) { null }

    fun open(bytes: ByteArray,key: ByteArray,epoch: String,createdAt: Long,nowMs: Long): JsonObject? = try {
        require(bytes.size in 36..MAX_BYTES && key.size==32 && bytes.copyOfRange(0,8).contentEquals(header))
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,bytes.copyOfRange(8,20)))
        cipher.updateAAD(header)
        val plain=cipher.doFinal(bytes,20,bytes.size-20)
        val record=try { Json.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject } finally { plain.fill(0) }
        require(record["version"]?.jsonPrimitive?.int==1 && record["epoch"]?.jsonPrimitive?.content==epoch)
        require(record["reportId"]?.jsonPrimitive?.content=="android-qualification" && record["owner"]?.jsonPrimitive?.content=="anonymous-qualification" && record["release"]?.jsonPrimitive?.content=="frozen-native-qualification")
        require(record["partial"]?.jsonPrimitive?.boolean==true)
        val signal=record.getValue("signal").jsonPrimitive.int;require(signal in 1..64)
        val tid=record.getValue("threadId").jsonPrimitive.long;require(tid in 1..4294967295L)
        val captured=record.getValue("snapshotTimeMs").jsonPrimitive.long
        require(captured>=createdAt && captured<=nowMs && captured>0)
        val abi=when(record.getValue("architecture").jsonPrimitive.int) { 1->"x86";2->"x86_64";3->"armeabi-v7a";4->"arm64-v8a";else->error("architecture") }
        fun address(name:String)=record.getValue(name).jsonPrimitive.content.toULong()
        val pc=address("pc");val base=address("moduleBase");val relative=address("moduleOffset")
        require(pc>0u && pc>=base && pc-base==relative)
        val module=record.getValue("module").jsonPrimitive.content;val build=record.getValue("buildId").jsonPrimitive.content
        require(module.matches(Regex("[A-Za-z0-9._-]{1,255}")) && build.matches(Regex("(?:[0-9a-f]{2}){1,64}")))
        buildJsonObject {
            put("source","android-native-handler");put("abi",abi);put("crashedThreadId",tid);put("framesIncomplete",true);put("signalNumber",signal)
            put("frames",buildJsonArray { add(buildJsonObject { put("pc","0x${pc.toString(16)}");put("relativePc","0x${relative.toString(16)}");put("module",module);put("buildId",build) }) })
            // Internal projection field, removed before serializing AndroidNativeMetadata.
            put("snapshotTimeMs",captured)
        }
    } catch(_:Exception) { null }
}
