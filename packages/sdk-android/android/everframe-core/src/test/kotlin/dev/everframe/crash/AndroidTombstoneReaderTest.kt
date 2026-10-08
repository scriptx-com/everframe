// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class AndroidTombstoneReaderTest {
    private fun v(value: ULong): ByteArray {
        var n = value
        val result = ArrayList<Byte>()
        do { val part = (n and 127u).toInt(); n = n shr 7; result.add((part or if (n != 0uL) 128 else 0).toByte()) } while (n != 0uL)
        return result.toByteArray()
    }
    private fun n(field: Int, value: ULong) = v((field * 8).toULong()) + v(value)
    private fun b(field: Int, value: ByteArray) = v((field * 8 + 2).toULong()) + v(value.size.toULong()) + value
    private fun s(field: Int, value: String) = b(field, value.toByteArray())
    private fun frame(pc: ULong = ULong.MAX_VALUE) = n(1, 0x20000000000001uL) + n(2, pc) +
        s(4, "privateFunction") + s(6, "/data/app/secret/base.apk!/lib/arm64-v8a/libfault.so") + s(8, "AABBCCDD")
    private fun entry(tid: Int = 42, count: Int = 1, embedded: Int = tid): ByteArray =
        n(1, tid.toULong()) + b(2, n(1, embedded.toULong()) + s(2, "sensitive thread") +
            (0 until count).fold(byteArrayOf()) { all, _ -> all + b(4, frame()) } + b(5, ByteArray(1000) { 65 }))
    private fun trace(arch: Int = 1, thread: ByteArray = entry()) = n(1, arch.toULong()) + n(5, 99u) + n(6, 42u) +
        b(10, n(1, 11u) + n(3, 1u)) + b(16, entry(7)) + b(16, thread) + s(14, "private abort message")
    private fun read(bytes: ByteArray) = AndroidTombstoneReader.read(ByteArrayInputStream(bytes))

    @Test fun `selects crashed thread and preserves exact unsigned addresses and ELF identity`() {
        val value = requireNotNull(read(trace()))
        assertEquals("arm64-v8a", value.abi.value)
        assertEquals(42L, value.crashedThreadID)
        assertEquals(11L, value.signalNumber)
        assertEquals(1L, value.signalCode)
        assertFalse(value.framesIncomplete)
        assertEquals(1, value.frames.size)
        assertEquals("0xffffffffffffffff", value.frames[0].pc)
        assertEquals("0x20000000000001", value.frames[0].relativePC)
        assertEquals("libfault.so", value.frames[0].module)
        assertEquals("aabbccdd", value.frames[0].buildID)
        assertFalse(value.toString().contains("private"))
        assertFalse(value.toString().contains("sensitive"))
        assertFalse(value.toString().contains("/data"))
    }
    @Test fun `OS record PID must agree with the tombstone before attaching frames`() {
        assertNotNull(AndroidTombstoneReader.read(ByteArrayInputStream(trace()), expectedPid = 99))
        assertNull(AndroidTombstoneReader.read(ByteArrayInputStream(trace()), expectedPid = 100))
    }
    @Test fun `protobuf ARM32 and zero pc defaults are valid`() {
        val minimal = n(6, 42u) + b(16, n(1, 42u) + b(2, n(1, 42u) + b(4, byteArrayOf())))
        val value = requireNotNull(read(minimal))
        assertEquals("armeabi-v7a", value.abi.value)
        assertEquals("0x0", value.frames[0].pc)
        assertEquals("0x0", value.frames[0].relativePC)
        assertNull(value.frames[0].buildID)
        assertNull(value.frames[0].module)
    }
    @Test fun `missing mismatched and duplicate crashed thread fail closed`() {
        assertNull(read(trace(thread = entry(7))))
        assertNull(read(trace(thread = entry(42, embedded = 7))))
        assertNull(read(trace() + b(16, entry())))
        assertNull(read(trace() + n(6, 43u)))
        assertNull(read(trace(arch = 99)))
    }
    @Test fun `unknown scalar and length fields skip without leaking contents`() {
        val unknown = n(1001, ULong.MAX_VALUE) + b(1002, "unknown-private".toByteArray()) +
            v((1003 * 8 + 1).toULong()) + ByteArray(8) + v((1004 * 8 + 5).toULong()) + ByteArray(4)
        assertEquals(read(trace()), read(unknown + trace() + unknown))
    }
    @Test fun `malformed wire data fails without throwing`() {
        for (bad in listOf(byteArrayOf(0), byteArrayOf(15), byteArrayOf(10, 127),
            ByteArray(11) { 0x80.toByte() }, byteArrayOf(8) + ByteArray(9) { 0xff.toByte() } + byteArrayOf(2),
            byteArrayOf(0x80.toByte(), 0), byteArrayOf(0x0b), byteArrayOf(0x0d, 1))) {
            assertNull(read(trace() + bad))
        }
        val full = trace()
        for (cut in 1..4) assertNull(read(full.copyOf(full.size - cut)))
    }
    @Test fun `frame cap keeps prefix and marks incomplete`() {
        val value = requireNotNull(read(trace(thread = entry(count = 257))))
        assertEquals(256, value.frames.size)
        assertTrue(value.framesIncomplete)
    }
    @Test fun `stream size and field count are bounded and streams close on failure`() {
        var consumed = 0
        var closed = false
        val stream = object : InputStream() {
            override fun read(): Int { consumed++; return 0 }
            override fun close() { closed = true }
        }
        assertNull(AndroidTombstoneReader.read(stream))
        assertTrue(consumed <= 4 * 1024 * 1024 + 1)
        assertTrue(closed)
        val manyFields = (0..100000).fold(java.io.ByteArrayOutputStream()) { out, _ -> out.apply { write(n(1001, 1u)) } }.toByteArray()
        assertNull(read(trace() + manyFields))
    }
    @Test fun `negative signal code round trips signed int32 and frames missing means incomplete`() {
        val value = requireNotNull(read(n(6, 42u) + b(10, n(1, 6u) + n(3, (-6L).toULong())) + b(16, entry(count = 0))))
        assertEquals(-6L, value.signalCode)
        assertTrue(value.framesIncomplete)
    }
    @Test fun `legacy generated copy preserves new Android evidence and legacy constructor descriptors`() {
        val metadata = requireNotNull(read(trace()))
        val crash = dev.everframe.protocol.generated.Crash(exceptionType = "SIGSEGV", fingerprint = "0123456789abcdef",
            frames = emptyList(), handled = false, fatal = true, mechanism = "android-exit-info", message = "native crash",
            occurredAt = "2026-10-07T18:00:00Z", androidNative = metadata)
        assertEquals(metadata, crash.copy(message = "changed").androidNative)
        val types = dev.everframe.protocol.generated.Crash::class.java.constructors.map { it.parameterTypes.size }.toSet()
        for (count in listOf(12, 13, 14, 15)) assertTrue("Constructor $count missing", count in types)
        val copies = dev.everframe.protocol.generated.Crash::class.java.methods.filter { it.name == "copy" }.map { it.parameterTypes.size }
        for (count in listOf(12, 13, 14, 15)) assertTrue("Copy $count missing", count in copies)
    }
    @Test fun `only app-packaged libraries are grouping code`() {
        val paths = linkedMapOf(
            "/data/app/~~a==/dev.example-b==/base.apk!libfault.so" to true,
            "/data/app/~~a==/dev.example-b==/split_config.arm64_v8a.apk!libfault.so" to true,
            "/data/app/~~a==/dev.example-b==/lib/arm64/libfault.so" to true,
            "/data/user/0/dev.example/files/libplugin.so" to true,
            "/mnt/expand/0f1e/app/~~a==/dev.example-b==/base.apk!libfault.so" to true,
            "/apex/com.android.runtime/lib64/bionic/libc.so" to false,
            "/system/lib64/libhwui.so" to false,
            "/vendor/lib64/egl/libGLESv2_adreno.so" to false,
            "/system/framework/arm64/boot.oat" to false,
            "/data/app/~~a==/dev.example-b==/oat/arm64/base.odex" to false,
            "/data/app/~~a==/dev.example-b==/oat/arm64/base.vdex" to false,
            "/data/dalvik-cache/arm64/system@framework@boot.oat" to false,
            "/memfd:jit-cache (deleted)" to false,
            "[anon:dalvik-jit-code-cache]" to false,
            "/data/app/~~a==/dev.example-b==/base.apk" to false,
        )
        val trace = n(6, 42u) + b(16, n(1, 42u) + b(2, n(1, 42u) + paths.keys.fold(byteArrayOf()) { all, path -> all + b(4, n(1, 1u) + s(6, path)) }))
        val value = requireNotNull(AndroidTombstoneReader.readTombstone(ByteArrayInputStream(trace)))
        assertEquals(paths.values.toList(), value.appCode)
        assertEquals(read(trace), value.metadata)
    }
    @Test fun `known fields with wrong wire types and invalid utf8 fail closed`() {
        assertNull(read(n(6, 42u) + b(16, n(1, 42u) + b(2, n(1, 42u) + b(4, b(6, byteArrayOf(0xc3.toByte())))))))
        assertNull(read(trace() + b(6, byteArrayOf(42))))
    }
}
