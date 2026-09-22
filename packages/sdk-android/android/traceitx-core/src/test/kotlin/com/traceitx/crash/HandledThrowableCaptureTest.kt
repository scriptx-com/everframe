// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.CaptureExceptionOptions
import com.traceitx.ErrorSeverity
import com.traceitx.TraceItX
import com.traceitx.config.TraceItXConfig
import com.traceitx.outbox.CrashSidecar
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.outbox.JceTestOutboxKeyProvider
import com.traceitx.outbox.JvmOutboxFileOps
import com.traceitx.outbox.OutboxEntry
import com.traceitx.shared.SharedData
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class HandledThrowableCaptureTest {
    @get:Rule val tmp = TemporaryFolder()
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val config = TraceItXConfig(appId = "app", sdkKey = "sk", r8MappingId = "mapping-A")
    private val startThreads = mutableListOf<Pair<Thread, java.util.concurrent.CountDownLatch>>()
    private val appContextField = TraceItX::class.java.getDeclaredField("appContext").apply { isAccessible = true }
    private var previousAppContext: Any? = null
    private val keys = JceTestOutboxKeyProvider()
    private lateinit var storageDir: File
    private fun encryptedOutbox() = JSONLOutbox(File(storageDir, "outbox.jsonl"), keys, JvmOutboxFileOps())
    private fun entries() = runBlocking { encryptedOutbox().hydrate() }
    private fun envelopes() = entries().map { Json.parseToJsonElement(String(it.envelopeBytes)).jsonObject }
    private fun crash() = envelopes().single()["payload"]!!.jsonObject["crash"]!!.jsonObject
    private fun restoreStorage() {
        CrashReporter.sidecarFactory = { CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, JvmOutboxFileOps()) }
    }
    private fun holderEntry(label: String) = OutboxEntry(
        reportId = "holder-$label",
        createdAt = 1L,
        envelopeBytes = "{}".toByteArray(),
        idempotencyKey = "holder-$label",
        attachmentRefs = emptyList(),
        sdkKey = "sk",
        endpoint = "https://example.invalid/api/ingest",
    )

    @Before fun setUp() {
        previousAppContext = appContextField.get(null)
        appContextField.set(null, null)
        SharedData.init(context)
        CrashReporter.__resetForTesting()
        storageDir = tmp.newFolder()
        restoreStorage()
        CrashReporter.configure(context)
        TraceItX.captureGate = true
        TraceItX.__setConfigForTesting(config)
        TraceItX.setUser(null)
    }

    @After fun tearDown() {
        if (startThreads.isNotEmpty()) TraceItX.kill()
        startThreads.forEach { (thread, release) -> release.countDown(); thread.join(5_000); assertFalse(thread.isAlive) }
        TraceItX.__resetStartTailDelayHookForTesting()
        TraceItX.setUser(null)
        appContextField.set(null, previousAppContext)
        TraceItX.__setConfigForTesting(null)
        TraceItX.captureGate = false
        CrashReporter.__resetForTesting()
    }

    @Test fun `public capture durably stores a handled nonfatal error`() {
        TraceItX.captureException(IllegalStateException("handled probe", IllegalArgumentException("cause")))
        val envelope = envelopes().single()
        val crash = crash()
        assertEquals("error", envelope["source"]!!.jsonPrimitive.content)
        assertEquals(true, crash["handled"]!!.jsonPrimitive.boolean)
        assertEquals(false, crash["fatal"]!!.jsonPrimitive.boolean)
        assertEquals("captureException", crash["mechanism"]!!.jsonPrimitive.content)
        assertEquals("handled probe", crash["message"]!!.jsonPrimitive.content)
        assertEquals("error", crash["details"]!!.jsonObject["severity"]!!.jsonPrimitive.content)
        assertFalse(File(storageDir, "outbox.jsonl.encrypted").walkTopDown().filter { it.isFile }
            .any { String(it.readBytes()).contains("handled probe") })
    }

    @Test fun `public capture owns supplied details before returning`() {
        val metadata = linkedMapOf<String, Any?>("attempt" to 3, "credential" to "Bearer abc.def-123")

        TraceItX.captureException(
            IllegalStateException("handled with details"),
            CaptureExceptionOptions(ErrorSeverity.WARNING, "checkout", metadata),
        )
        metadata["attempt"] = 99
        metadata["later"] = true

        val details = crash()["details"]!!.jsonObject
        assertEquals("warning", details["severity"]!!.jsonPrimitive.content)
        assertEquals("checkout", details["context"]!!.jsonPrimitive.content)
        assertEquals(3, details["metadata"]!!.jsonObject["attempt"]!!.jsonPrimitive.int)
        assertEquals("[REDACTED]", details["metadata"]!!.jsonObject["credential"]!!.jsonPrimitive.content)
        assertNull(details["metadata"]!!.jsonObject["later"])
    }

    @Test fun `deliberate captures wait for startup storage coordination while fatal capture remains nonblocking`() {
        fun verify(label: String, capture: () -> Boolean) {
            val entered = java.util.concurrent.CountDownLatch(1)
            val release = java.util.concurrent.CountDownLatch(1)
            val holderAccepted = java.util.concurrent.atomic.AtomicBoolean(false)
            val ops = object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
                override fun syncFile(file: File) {
                    if (file.extension == "tmp") {
                        entered.countDown()
                        check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                    }
                    JvmOutboxFileOps().syncFile(file)
                }
            }
            val holder = Thread {
                holderAccepted.set(CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, ops)
                    .appendSyncAccepted(holderEntry(label)))
            }
            val captureStarted = java.util.concurrent.CountDownLatch(1)
            val captureFinished = java.util.concurrent.CountDownLatch(1)
            val captureAccepted = java.util.concurrent.atomic.AtomicBoolean(false)
            val captureThread = Thread {
                captureStarted.countDown()
                captureAccepted.set(capture())
                captureFinished.countDown()
            }
            holder.start()
            try {
                assertTrue("coordinator holder entered for $label",
                    entered.await(5, java.util.concurrent.TimeUnit.SECONDS))

                val fatal = java.util.concurrent.FutureTask {
                    CrashReporter.captureFactsAccepted(
                        "FatalProbe", "fatal-$label", emptyList(), "errorutils", true,
                        "2026-09-16T00:00:00Z",
                    )
                }
                Thread(fatal).start()
                assertFalse("fatal capture must refuse contention without waiting",
                    fatal.get(1, java.util.concurrent.TimeUnit.SECONDS))

                captureThread.start()
                assertTrue("deliberate capture started for $label",
                    captureStarted.await(1, java.util.concurrent.TimeUnit.SECONDS))
                assertFalse("deliberate $label capture must wait for storage coordination",
                    captureFinished.await(250, java.util.concurrent.TimeUnit.MILLISECONDS))
            } finally {
                release.countDown()
                holder.join(5_000)
                captureThread.join(5_000)
            }
            assertFalse("coordinator holder terminated for $label", holder.isAlive)
            assertFalse("capture thread terminated for $label", captureThread.isAlive)
            assertTrue("coordinator holder persisted for $label", holderAccepted.get())
            assertTrue("deliberate $label capture persisted after coordination", captureAccepted.get())
        }

        verify("native") {
            CrashReporter.captureHandledThrowable(RuntimeException("native-after-coordination"))
        }

        storageDir = tmp.newFolder()
        restoreStorage()
        verify("rn-facts") {
            CrashReporter.captureHandledFactsWithDetails(
                "RNDetailsRetryError",
                "rn-facts-after-coordination",
                listOf("at App.tsx:1:1"),
                "2026-09-16T00:00:00Z",
                null,
                null,
            )
        }
    }

    @Test fun `deliberate capture waiting on storage is rejected by kill`() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val holder = Thread {
            val ops = object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
                override fun syncFile(file: File) {
                    if (file.extension == "tmp") {
                        entered.countDown()
                        check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                    }
                    JvmOutboxFileOps().syncFile(file)
                }
            }
            CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, ops)
                .appendSyncAccepted(holderEntry("kill"))
        }
        val captureStarted = java.util.concurrent.CountDownLatch(1)
        val captureFinished = java.util.concurrent.CountDownLatch(1)
        val accepted = java.util.concurrent.atomic.AtomicBoolean(true)
        val capture = Thread {
            captureStarted.countDown()
            accepted.set(CrashReporter.captureHandledThrowable(RuntimeException("revoked while waiting")))
            captureFinished.countDown()
        }
        var kill: Thread? = null
        holder.start()
        try {
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            capture.start()
            assertTrue(captureStarted.await(1, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse(captureFinished.await(250, java.util.concurrent.TimeUnit.MILLISECONDS))
            kill = Thread { TraceItX.kill() }.also { it.start() }
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2)
            while (TraceItX.captureGate && System.nanoTime() < deadline) Thread.yield()
            assertFalse("kill must revoke capture before storage is released", TraceItX.captureGate)
        } finally {
            release.countDown()
            holder.join(5_000)
            capture.join(5_000)
            kill?.join(5_000)
        }
        assertFalse(holder.isAlive)
        assertFalse(capture.isAlive)
        assertFalse(kill?.isAlive ?: true)
        assertFalse(accepted.get())
        assertEquals(listOf("holder-kill"), entries().map { it.reportId })
    }

    @Test fun `RN deliberate capture waiting on storage is rejected by a newer start`() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val holder = Thread {
            val ops = object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
                override fun syncFile(file: File) {
                    if (file.extension == "tmp") {
                        entered.countDown()
                        check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                    }
                    JvmOutboxFileOps().syncFile(file)
                }
            }
            CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, ops)
                .appendSyncAccepted(holderEntry("restart"))
        }
        val captureStarted = java.util.concurrent.CountDownLatch(1)
        val captureFinished = java.util.concurrent.CountDownLatch(1)
        val accepted = java.util.concurrent.atomic.AtomicBoolean(true)
        val capture = Thread {
            captureStarted.countDown()
            accepted.set(CrashReporter.captureHandledFactsWithDetails(
                "RNDetailsRetryError", "stale while waiting", emptyList(),
                "2026-09-16T00:00:00Z", null, null,
            ))
            captureFinished.countDown()
        }
        holder.start()
        try {
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            capture.start()
            assertTrue(captureStarted.await(1, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse(captureFinished.await(250, java.util.concurrent.TimeUnit.MILLISECONDS))
            restart()
        } finally {
            release.countDown()
            holder.join(5_000)
            capture.join(5_000)
        }
        assertFalse(holder.isAlive)
        assertFalse(capture.isAlive)
        assertFalse(accepted.get())
        assertEquals(listOf("holder-restart"), entries().map { it.reportId })
    }

    @Test fun `deliberate capture refuses same-thread storage reentry`() {
        var nestedAccepted = true
        var firstAuthorization = true
        val outerAccepted = CrashSidecar(
            File(storageDir, "crash-outbox.jsonl"), keys, JvmOutboxFileOps(),
        ).appendSyncAccepted(holderEntry("reentrant"), object : com.traceitx.outbox.OutboxAuthorization {
            override fun isAllowed(): Boolean {
                if (firstAuthorization) {
                    firstAuthorization = false
                    nestedAccepted = CrashReporter.captureHandledFactsWithDetails(
                        "RNDetailsRetryError", "reentrant capture", emptyList(),
                        "2026-09-16T00:00:00Z", null, null,
                    )
                }
                return true
            }
        })

        assertTrue(outerAccepted)
        assertFalse(nestedAccepted)
        assertEquals(listOf("holder-reentrant"), entries().map { it.reportId })
    }

    @Test fun `different details retain the same fingerprint and handled allowance`() {
        repeat(10) { index ->
            val throwable = RuntimeException("same facts").apply {
                stackTrace = arrayOf(StackTraceElement("sample.Failure", "run", "Failure.kt", 42))
            }
            assertTrue(CrashReporter.captureHandledThrowable(
                throwable,
                CaptureExceptionOptions(
                    severity = ErrorSeverity.entries[index % ErrorSeverity.entries.size],
                    context = "context-$index",
                    metadata = mapOf("index" to index),
                ),
            ))
        }
        assertFalse(CrashReporter.captureHandledThrowable(
            RuntimeException("same facts"),
            CaptureExceptionOptions(metadata = mapOf("index" to 10)),
        ))
        val crashes = envelopes().map { it["payload"]!!.jsonObject["crash"]!!.jsonObject }
        assertEquals(10, crashes.size)
        assertEquals(1, crashes.map { it["fingerprint"]!!.jsonPrimitive.content }.toSet().size)
    }

    @Test fun `metadata restart rejects stale attempt without consuming successor allowance`() {
        val metadata = object : AbstractMap<String, Any?>() {
            override val entries: Set<Map.Entry<String, Any?>>
                get() {
                    TraceItX.kill()
                    restart()
                    return setOf(java.util.AbstractMap.SimpleImmutableEntry("phase", "old"))
                }
        }

        assertFalse(CrashReporter.captureHandledThrowable(
            RuntimeException("stale metadata"),
            CaptureExceptionOptions(metadata = metadata),
        ))
        assertTrue(envelopes().isEmpty())
        repeat(10) { index ->
            assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("successor-$index")))
        }
        assertFalse(CrashReporter.captureHandledThrowable(RuntimeException("successor-over-budget")))
        assertEquals(10, envelopes().size)
    }

    @Test fun `metadata callback cannot reenter deliberate capture`() {
        val metadata = object : AbstractMap<String, Any?>() {
            override val entries: Set<Map.Entry<String, Any?>>
                get() {
                    TraceItX.captureException(
                        RuntimeException("reentrant metadata"),
                        CaptureExceptionOptions(metadata = mapOf("nested" to true)),
                    )
                    return setOf(java.util.AbstractMap.SimpleImmutableEntry("outer", true))
                }
        }

        assertTrue(CrashReporter.captureHandledThrowable(
            RuntimeException("outer metadata"),
            CaptureExceptionOptions(metadata = metadata),
        ))

        val crash = crash()
        assertEquals("outer metadata", crash["message"]!!.jsonPrimitive.content)
        assertEquals(true, crash["details"]!!.jsonObject["metadata"]!!.jsonObject["outer"]!!.jsonPrimitive.boolean)
    }

    @Test fun `fatal persists while handled metadata callback is parked`() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val metadata = object : AbstractMap<String, Any?>() {
            override val entries: Set<Map.Entry<String, Any?>>
                get() {
                    entered.countDown()
                    check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                    return setOf(java.util.AbstractMap.SimpleImmutableEntry("ready", true))
                }
        }
        var accepted = false
        val thread = Thread {
            accepted = CrashReporter.captureHandledThrowable(
                RuntimeException("parked metadata"),
                CaptureExceptionOptions(metadata = metadata),
            )
        }
        thread.start()
        try {
            assertTrue("metadata callback entered", entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("fatal during metadata"))
            val fatal = envelopes().single()["payload"]!!.jsonObject["crash"]!!.jsonObject
            assertEquals("fatal during metadata", fatal["message"]!!.jsonPrimitive.content)
            assertEquals(true, fatal["fatal"]!!.jsonPrimitive.boolean)
            assertEquals("error", fatal["details"]!!.jsonObject["severity"]!!.jsonPrimitive.content)
            assertEquals(1L, release.count)
        } finally {
            release.countDown()
            thread.join(5_000)
        }
        assertFalse(thread.isAlive)
        assertTrue(accepted)
        assertEquals(2, envelopes().size)
    }

    // Let real start publish its epoch/config, then park before async work is launched.
    // Teardown kills that generation before releasing the hook: no network or collectors.
    private fun restart() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        TraceItX.__beforeDrainLaunchForTesting = { entered.countDown(); check(release.await(30, java.util.concurrent.TimeUnit.SECONDS)) }
        val thread = Thread { TraceItX.start(context, config) }
        startThreads += thread to release
        thread.start()
        assertTrue("start must reach its published epoch", entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        TraceItX.__beforeDrainLaunchForTesting = null
    }

    @Test fun `same object is accepted only once but distinct equal objects avoid equals and hashCode`() {
        var equalityCalls = 0
        class EqualError : RuntimeException("equal") {
            override fun equals(other: Any?): Boolean { equalityCalls++; return other is EqualError }
            override fun hashCode(): Int { equalityCalls++; return 1 }
        }
        val first = EqualError()
        assertTrue(CrashReporter.captureHandledThrowable(first))
        assertFalse(CrashReporter.captureHandledThrowable(first))
        assertTrue(CrashReporter.captureHandledThrowable(EqualError()))
        assertEquals(0, equalityCalls)
        assertEquals(2, envelopes().size)
    }

    @Test fun `eleven distinct attempts persist only ten errors`() {
        repeat(11) { i -> assertEquals(i < 10, CrashReporter.captureHandledThrowable(IllegalStateException("error-$i"))) }
        assertEquals(10, envelopes().size)
    }

    @Test fun `refused storage leaves the same identity and final allowance available for retry`() {
        repeat(9) { assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("accepted-$it"))) }
        val retry = RuntimeException("retry")
        CrashReporter.sidecarFactory = { CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys,
            object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
                override fun syncFile(file: File) { throw java.io.IOException("refused storage") }
            }) }
        assertFalse(CrashReporter.captureHandledThrowable(retry))
        assertEquals(9, envelopes().size)
        restoreStorage()
        assertTrue(CrashReporter.captureHandledThrowable(retry))
        assertFalse(CrashReporter.captureHandledThrowable(RuntimeException("over budget")))
        assertEquals(10, envelopes().size)
    }

    @Test fun `a real start resets both the budget and accepted identities`() {
        val reused = RuntimeException("same object across starts")
        assertTrue(CrashReporter.captureHandledThrowable(reused))
        repeat(9) { assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("before-$it"))) }
        restart()
        assertTrue(CrashReporter.captureHandledThrowable(reused))
        repeat(9) { assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("after-$it"))) }
        assertFalse(CrashReporter.captureHandledThrowable(RuntimeException("eleventh")))
        assertEquals(20, envelopes().size)
    }

    @Test fun `prestart disabled and killed capture never touches host getters`() {
        var reads = 0
        val error = object : RuntimeException() {
            override val message: String get() { reads++; return "message" }
            override fun getStackTrace(): Array<StackTraceElement> { reads++; return emptyArray() }
            override val cause: Throwable? get() { reads++; return null }
        }
        TraceItX.__setConfigForTesting(null)
        TraceItX.captureException(error)
        assertFalse(CrashReporter.captureHandledThrowable(error))
        TraceItX.__setConfigForTesting(config.copy(capture = config.capture.copy(crash = false)))
        TraceItX.captureException(error)
        assertFalse(CrashReporter.captureHandledThrowable(error))
        TraceItX.__setConfigForTesting(config)
        TraceItX.kill()
        TraceItX.captureException(error)
        assertFalse(CrashReporter.captureHandledThrowable(error))
        assertEquals(0, reads)
        assertEquals(0, envelopes().size)
    }

    @Test fun `restart during a getter discards the old attempt without consuming the new budget`() {
        val old = object : RuntimeException("old") {
            override fun getStackTrace(): Array<StackTraceElement> { restart(); return emptyArray() }
        }
        assertFalse(CrashReporter.captureHandledThrowable(old))
        repeat(10) { assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("new-$it"))) }
        assertFalse(CrashReporter.captureHandledThrowable(RuntimeException("new-eleventh")))
        assertEquals(10, envelopes().size)
        assertTrue(envelopes().all { it["payload"]!!.jsonObject["crash"]!!.jsonObject["message"]!!.jsonPrimitive.content.startsWith("new-") })
    }

    @Test fun `kill then restart during a getter cannot resurrect the old attempt`() {
        val old = object : RuntimeException("old") {
            override val message: String get() { TraceItX.kill(); restart(); return "revoked" }
        }
        assertFalse(CrashReporter.captureHandledThrowable(old))
        assertEquals(0, envelopes().size)
        assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("new")))
        assertEquals("new", crash()["message"]!!.jsonPrimitive.content)
    }

    @Test fun `restart at encrypted write boundary refuses old epoch persistence`() {
        CrashReporter.sidecarFactory = {
            restart()
            CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, JvmOutboxFileOps())
        }
        assertFalse(CrashReporter.captureHandledThrowable(RuntimeException("stale")))
        assertEquals(0, envelopes().size)
    }

    @Test fun `throwing getters retain the outer type with safe fallbacks`() {
        val hostile = object : RuntimeException() {
            override val message: String get() = error("message getter")
            override fun getStackTrace(): Array<StackTraceElement> = error("stack getter")
            override val cause: Throwable? get() = error("cause getter")
        }
        assertTrue(CrashReporter.captureHandledThrowable(hostile))
        val crash = crash()
        assertEquals(hostile.javaClass.name, crash["message"]!!.jsonPrimitive.content)
        assertTrue(crash["frames"]!!.jsonArray.isEmpty())
        assertTrue(crash["jvm"]!!.jsonObject["causesTruncated"]!!.jsonPrimitive.boolean)
    }

    @Test fun `every overridable accessor is protected against recursive handled capture`() {
        var messageReads = 0
        var stackReads = 0
        var causeReads = 0
        val error = object : RuntimeException() {
            override val message: String get() {
                messageReads++
                if (messageReads < 3) TraceItX.captureException(this)
                return "outer"
            }
            override fun getStackTrace(): Array<StackTraceElement> {
                stackReads++
                if (stackReads < 3) TraceItX.captureException(this)
                return emptyArray()
            }
            override val cause: Throwable? get() {
                causeReads++
                if (causeReads < 3) TraceItX.captureException(this)
                return null
            }
        }
        assertTrue(CrashReporter.captureHandledThrowable(error))
        assertEquals(listOf(1, 1, 1), listOf(messageReads, stackReads, causeReads))
        assertEquals("outer", crash()["message"]!!.jsonPrimitive.content)
    }

    @Test fun `original stack causes mapping and user are retained when a getter changes live context`() {
        TraceItX.setUser(com.traceitx.config.TXUser(id = "original-user"))
        val cause = IllegalArgumentException("cause Bearer abc.def-123").apply {
            stackTrace = Array(33) { StackTraceElement("sample.Cause", "run", "Cause.kt", 11) }
        }
        val outer = object : RuntimeException("outer", cause) {
            override fun getStackTrace(): Array<StackTraceElement> {
                TraceItX.setUser(com.traceitx.config.TXUser(id = "later-user"))
                TraceItX.__setConfigForTesting(config.copy(r8MappingId = "mapping-B", sdkKey = "later-key"))
                return arrayOf(StackTraceElement("sample.Outer", "original", "Original.kt", 42))
            }
        }
        assertTrue(CrashReporter.captureHandledThrowable(outer))
        val envelope = envelopes().single()
        val crash = crash()
        val frame = crash["frames"]!!.jsonArray.single().jsonObject
        assertEquals("sample.Outer.original(Original.kt:42)", frame["raw"]!!.jsonPrimitive.content)
        assertEquals("Original.kt", frame["file"]!!.jsonPrimitive.content)
        assertEquals("original", frame["function"]!!.jsonPrimitive.content)
        assertEquals(42, frame["line"]!!.jsonPrimitive.int)
        val jvm = crash["jvm"]!!.jsonObject
        assertEquals("mapping-A", jvm["mappingId"]!!.jsonPrimitive.content)
        val savedCause = jvm["causes"]!!.jsonArray.single().jsonObject
        assertEquals("cause [REDACTED]", savedCause["message"]!!.jsonPrimitive.content)
        assertEquals(32, savedCause["frames"]!!.jsonArray.size)
        assertTrue(savedCause["framesTruncated"]!!.jsonPrimitive.boolean)
        assertEquals("original-user", envelope["reporter"]!!.jsonObject["user"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("sk", entries().single().sdkKey)
        assertNull(crash["jsBundle"])
        assertNotNull(envelope["context"]!!.jsonObject["app"]!!.jsonObject["build"])
    }

    @Test fun `outer strings are redacted bounded and JSONB safe without losing valid Unicode`() {
        val originalName = Thread.currentThread().name
        try {
            Thread.currentThread().name = "thread\u0000" + "x".repeat(300)
            val error = RuntimeException("😀\u0000\uD800" + "a".repeat(4088) + "123-45-6789").apply {
                stackTrace = Array(257) { StackTraceElement("sample\u0000", "fn\uDC00" + "f".repeat(600),
                    "file😀\u0000" + "x".repeat(1100), 7) }
            }
            assertTrue(CrashReporter.captureHandledThrowable(error))
            val crash = crash()
            val message = crash["message"]!!.jsonPrimitive.content
            assertTrue(message.startsWith("😀��"))
            assertTrue(message.length <= 4096)
            assertFalse(message.contains("123-45-6789"))
            assertEquals(256, crash["threadName"]!!.jsonPrimitive.content.length)
            val frames = crash["frames"]!!.jsonArray
            assertEquals(256, frames.size)
            val frame = frames.first().jsonObject
            assertEquals(1024, frame["raw"]!!.jsonPrimitive.content.length)
            assertEquals(1024, frame["file"]!!.jsonPrimitive.content.length)
            assertEquals(512, frame["function"]!!.jsonPrimitive.content.length)
            fun verifyText(value: JsonElement) {
                when (value) {
                    is JsonObject -> value.values.forEach(::verifyText)
                    is JsonArray -> value.forEach(::verifyText)
                    is JsonPrimitive -> if (value.isString) {
                        val text = value.content
                        assertFalse(text.contains('\u0000'))
                        var i = 0
                        while (i < text.length) {
                            val c = text[i++]
                            if (Character.isHighSurrogate(c)) {
                                assertTrue(i < text.length && Character.isLowSurrogate(text[i])); i++
                            } else assertFalse(Character.isLowSurrogate(c))
                        }
                    }
                }
            }
            verifyText(envelopes().single())
        } finally { Thread.currentThread().name = originalName }
    }

    @Test fun `handled then fatal still persists a separate fatal event after budget exhaustion`() {
        val error = IllegalStateException("handled then fatal")
        assertTrue(CrashReporter.captureHandledThrowable(error))
        repeat(9) { assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("fill-$it"))) }
        CrashReporter.captureThrowable(Thread.currentThread(), error)
        val fatal = envelopes().single { it["source"]!!.jsonPrimitive.content == "crash" }["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertFalse(fatal["handled"]!!.jsonPrimitive.boolean)
        assertTrue(fatal["fatal"]!!.jsonPrimitive.boolean)
        assertEquals("uncaught-exception-handler", fatal["mechanism"]!!.jsonPrimitive.content)
        assertEquals(11, envelopes().size)
    }

    @Test fun `late reservation and settlement cannot reset or release a newer epochs allowance`() {
        var epoch = 1
        val admission = HandledThrowableAdmission { epoch }
        val old = admission.reserve(RuntimeException("old"), 1)!!
        epoch = 2
        repeat(9) {
            val reservation = admission.reserve(RuntimeException("new-$it"), 2)!!
            admission.settle(reservation, true)
        }
        val tenth = admission.reserve(RuntimeException("tenth"), 2)!!
        assertNull(admission.reserve(RuntimeException("late old"), 1))
        admission.settle(old, true)
        assertNull(admission.reserve(RuntimeException("while tenth pending"), 2))
        admission.settle(tenth, true)
        assertNull(admission.reserve(RuntimeException("eleventh"), 2))
    }

    @Test fun `concurrent attempt does not enter getters and may retry after the first completes`() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        var accepted = false
        val first = object : RuntimeException("first") {
            override val message: String get() {
                entered.countDown()
                check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                return "first"
            }
        }
        var secondReads = 0
        val second = object : RuntimeException("second") {
            override val message: String get() { secondReads++; return "second" }
        }
        val thread = Thread { accepted = CrashReporter.captureHandledThrowable(first) }
        thread.start()
        try {
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse(CrashReporter.captureHandledThrowable(second))
            assertEquals(0, secondReads)
        } finally { release.countDown(); thread.join(5_000) }
        assertFalse(thread.isAlive)
        assertTrue(accepted)
        assertTrue(CrashReporter.captureHandledThrowable(second))
        assertEquals(setOf("first", "second"), envelopes().map {
            it["payload"]!!.jsonObject["crash"]!!.jsonObject["message"]!!.jsonPrimitive.content
        }.toSet())
    }

    @Test fun `UTF16 cap replaces a cut surrogate pair in message and title`() {
        val prefix = "java.lang.RuntimeException: "
        val error = RuntimeException("a".repeat(50 - prefix.length - 1) + "😀" + "b".repeat(4100))
        assertTrue(CrashReporter.captureHandledThrowable(error))
        assertEquals("java.lang.RuntimeException: " + "a".repeat(21) + "�",
            envelopes().single()["reporter"]!!.jsonObject["title"]!!.jsonPrimitive.content)
        val next = RuntimeException("a".repeat(4095) + "😀")
        assertTrue(CrashReporter.captureHandledThrowable(next))
        assertTrue(envelopes().any { it["payload"]!!.jsonObject["crash"]!!.jsonObject["message"]!!.jsonPrimitive.content == "a".repeat(4095) + "�" })
    }

    @Test fun `fatal persists while handled message getter is parked`() = fatalPersistsWhileGetterParked("message")
    @Test fun `fatal persists while handled stack getter is parked`() = fatalPersistsWhileGetterParked("stack")
    @Test fun `fatal persists while handled cause getter is parked`() = fatalPersistsWhileGetterParked("cause")
    @Test fun `fatal persists while nested cause message getter is parked`() = fatalPersistsWhileGetterParked("cause-message")
    @Test fun `fatal persists while nested cause stack getter is parked`() = fatalPersistsWhileGetterParked("cause-stack")
    @Test fun `fatal persists while nested cause traversal getter is parked`() = fatalPersistsWhileGetterParked("cause-next")

    private fun fatalPersistsWhileGetterParked(target: String) {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        fun park(getter: String) {
            if (getter == target) {
                entered.countDown()
                check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
            }
        }
        val nested = object : RuntimeException() {
            override val message: String get() { park("cause-message"); return "nested" }
            override fun getStackTrace(): Array<StackTraceElement> { park("cause-stack"); return emptyArray() }
            override val cause: Throwable? get() { park("cause-next"); return null }
        }
        val handled = object : RuntimeException() {
            override val message: String get() { park("message"); return "handled" }
            override fun getStackTrace(): Array<StackTraceElement> { park("stack"); return emptyArray() }
            override val cause: Throwable? get() { park("cause"); return nested }
        }
        var accepted = false
        val thread = Thread { accepted = CrashReporter.captureHandledThrowable(handled) }
        thread.start()
        try {
            assertTrue("handled getter entered", entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("concurrent fatal"))
            val fatal = crash()
            assertEquals("concurrent fatal", fatal["message"]!!.jsonPrimitive.content)
            assertTrue(fatal["fatal"]!!.jsonPrimitive.boolean)
            assertFalse(fatal["handled"]!!.jsonPrimitive.boolean)
            assertEquals("crash", envelopes().single()["source"]!!.jsonPrimitive.content)
            assertEquals("getter is still parked when fatal is durable", 1L, release.count)
        } finally { release.countDown(); thread.join(5_000) }
        assertFalse(thread.isAlive)
        assertTrue(accepted)
        assertEquals(setOf("error", "crash"), envelopes().map { it["source"]!!.jsonPrimitive.content }.toSet())
    }

    @Test fun `handled completion cannot release a concurrent automatic collectors latch`() {
        val handledEntered = java.util.concurrent.CountDownLatch(1)
        val handledRelease = java.util.concurrent.CountDownLatch(1)
        val fatalEntered = java.util.concurrent.CountDownLatch(1)
        val fatalRelease = java.util.concurrent.CountDownLatch(1)
        val error = object : RuntimeException() {
            override val message: String get() {
                handledEntered.countDown()
                check(handledRelease.await(5, java.util.concurrent.TimeUnit.SECONDS))
                return "retry handled"
            }
        }
        var accepted = true
        val handledThread = Thread { accepted = CrashReporter.captureHandledThrowable(error) }
        val fatalThread = Thread { CrashReporter.captureThrowable(Thread.currentThread(), RuntimeException("fatal owner")) }
        handledThread.start()
        try {
            assertTrue(handledEntered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            CrashReporter.__afterUserSnapshotHookForTesting = {
                CrashReporter.__afterUserSnapshotHookForTesting = null
                fatalEntered.countDown()
                check(fatalRelease.await(5, java.util.concurrent.TimeUnit.SECONDS))
            }
            fatalThread.start()
            assertTrue("automatic collector owns its latch", fatalEntered.await(3, java.util.concurrent.TimeUnit.SECONDS))
            handledRelease.countDown()
            handledThread.join(3_000)
            assertFalse(handledThread.isAlive)
            assertFalse(accepted)
            assertFalse(CrashReporter.captureFactsAccepted("Other", "still blocked", emptyList(), "errorutils", true,
                "2026-09-14T12:00:00Z"))
            assertTrue(envelopes().isEmpty())
        } finally {
            handledRelease.countDown(); fatalRelease.countDown()
            handledThread.join(5_000); fatalThread.join(5_000)
            CrashReporter.__afterUserSnapshotHookForTesting = null
        }
        assertFalse(fatalThread.isAlive)
        assertEquals("fatal owner", crash()["message"]!!.jsonPrimitive.content)
        assertTrue(CrashReporter.captureHandledThrowable(error))
        assertEquals(2, envelopes().size)
    }

    @Test fun `automatic collector reentry refuses handled getters before extraction`() {
        var reads = 0
        val error = object : RuntimeException() {
            override val message: String get() { reads++; return "unexpected" }
            override fun getStackTrace(): Array<StackTraceElement> { reads++; return emptyArray() }
            override val cause: Throwable? get() { reads++; return null }
        }
        CrashReporter.__enterForTesting()
        assertFalse(CrashReporter.captureHandledThrowable(error))
        assertEquals(0, reads)
        assertTrue(envelopes().isEmpty())
    }

    // Returning only weak handles ends this frame's ownership of the full host graph.
    private fun captureCollectibleGraph(): Pair<java.lang.ref.WeakReference<Throwable>, java.lang.ref.WeakReference<Any>> {
        val graph = Any()
        val error = object : RuntimeException("collectible") { val hostGraph = graph }
        assertTrue(CrashReporter.captureHandledThrowable(error))
        return java.lang.ref.WeakReference<Throwable>(error) to java.lang.ref.WeakReference(graph)
    }

    private fun awaitCollected(reference: java.lang.ref.WeakReference<*>) {
        repeat(40) {
            System.gc()
            if (reference.get() == null) return
            Thread.sleep(25)
        }
        assertNull("accepted capture must not retain the host Throwable graph", reference.get())
    }

    @Test fun `accepted Throwable and host graph can be collected without refunding budget or live identity`() {
        val (error, graph) = captureCollectibleGraph()
        val live = RuntimeException("still live")
        assertTrue(CrashReporter.captureHandledThrowable(live))
        awaitCollected(error)
        awaitCollected(graph)
        assertFalse(CrashReporter.captureHandledThrowable(live))
        repeat(8) { assertTrue(CrashReporter.captureHandledThrowable(RuntimeException("remaining-$it"))) }
        assertFalse(CrashReporter.captureHandledThrowable(RuntimeException("over budget after GC")))
        assertEquals(10, envelopes().size)
        assertEquals(1, envelopes().count { it["payload"]!!.jsonObject["crash"]!!.jsonObject["message"]!!.jsonPrimitive.content == "still live" })
    }
}
