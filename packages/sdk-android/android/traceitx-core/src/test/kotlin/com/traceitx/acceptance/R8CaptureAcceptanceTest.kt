// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.acceptance

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.TraceItX
import com.traceitx.config.TraceItXConfig
import com.traceitx.crash.CrashReporter
import com.traceitx.outbox.CrashSidecar
import com.traceitx.outbox.JceTestOutboxKeyProvider
import com.traceitx.outbox.JvmOutboxFileOps
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.shared.SharedData
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.net.URLClassLoader

/** Opt-in host acceptance: debug SDK captures separately R8-optimized classfiles. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class R8CaptureAcceptanceTest {
    private fun required(name: String): String = requireNotNull(System.getProperty(name)) {
        "R8 acceptance requires -P$name; run the explicit test:source-maps gate."
    }

    @Test
    fun optimizedThrowableIsPersistedByNativeCapture() {
        val fixture = File(required("traceitxR8FixtureJar"))
        val output = File(required("traceitxR8EnvelopeOutput"))
        val mappingId = required("traceitxR8MappingId")
        val appId = required("traceitxR8AppId")
        val context = ApplicationProvider.getApplicationContext<Context>()
        val storage = java.nio.file.Files.createTempDirectory("traceitx-r8-capture").toFile()
        val sidecar = File(storage, "crash-outbox.jsonl")
        val outboxFile = File(storage, "outbox.jsonl")
        val keys = JceTestOutboxKeyProvider()
        SharedData.init(context)
        TraceItX.captureGate = true
        TraceItX.__setConfigForTesting(TraceItXConfig(appId = appId, sdkKey = "acceptance-only", r8MappingId = mappingId))
        sidecar.delete()
        outboxFile.delete()
        output.delete()
        try {
            URLClassLoader(arrayOf(fixture.toURI().toURL()), javaClass.classLoader).use { loader ->
                val entry = loader.loadClass("com.traceitx.fixture.Entry").getMethod("crash")
                repeat(2) {
                    val thrown = try {
                        entry.invoke(null)
                        error("Optimized fixture did not throw")
                    } catch (wrapper: InvocationTargetException) {
                        wrapper.targetException
                    }
                    assertFalse(thrown.javaClass.name.contains("OuterFailure"))
                    assertFalse(thrown.cause!!.javaClass.name.contains("RootFailure"))
                    assertTrue(thrown.stackTrace.any { it.lineNumber > 0 })
                    CrashReporter.__resetForTesting()
                    CrashReporter.sidecarFactory = { CrashSidecar(sidecar, keys, JvmOutboxFileOps()) }
                    CrashReporter.configure(context)
                    CrashReporter.captureThrowable(Thread.currentThread(), thrown)
                    val outbox = JSONLOutbox(outboxFile, keys, JvmOutboxFileOps())
                    assertEquals(1, runBlocking { outbox.count() })
                    val persisted = runBlocking { outbox.hydrate() }.single()
                    val envelope = Json.parseToJsonElement(String(persisted.envelopeBytes)).jsonObject
                    val crash = envelope["payload"]!!.jsonObject["crash"]!!.jsonObject
                    assertEquals(thrown.javaClass.name, crash["exceptionType"]!!.jsonPrimitive.content)
                    assertEquals(mappingId, crash["jvm"]!!.jsonObject["mappingId"]!!.jsonPrimitive.content)
                    assertEquals(1, crash["jvm"]!!.jsonObject["causes"]!!.jsonArray.size)
                    // Write the actual outbox bytes. No reconstructed envelope crosses this boundary.
                    output.appendBytes(persisted.envelopeBytes)
                    output.appendText("\n")
                    runBlocking { outbox.drain { true } }
                }
            }
        } finally {
            CrashReporter.__resetForTesting()
            TraceItX.__setConfigForTesting(null)
            TraceItX.captureGate = false
            sidecar.delete()
            storage.deleteRecursively()
        }
    }
}
