// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

class ReportDiagnosticsTest {
    @Test fun initialQueueIsUnknownRatherThanEmpty() {
        val status = ReportDiagnostics().snapshot()
        assertEquals("not-started", status.status)
        assertEquals("not-observed", status.queue.observation)
        assertNull(status.queue.pendingCount)
        assertEquals("reject-new", status.queue.capacityPolicy)
        assertEquals("retain", status.queue.terminalHttpPolicy)
        assertFalse(status.capture.enabled)
    }

    @Test fun retiredCaptureCannotPopulateSuccessorEvenWithSameEpoch() {
        val ledger = ReportDiagnostics()
        val first = ledger.beginGeneration(1, true)
        first.capture(CapturePath.NATIVE_HANDLED, CaptureOutcome.PERSISTED)
        val retained = ledger.snapshot()
        val second = ledger.beginGeneration(1, false)
        first.capture(CapturePath.BRIDGE_AUTOMATIC, CaptureOutcome.PERSISTED)
        second.capture(CapturePath.NATIVE_HANDLED, CaptureOutcome.DISABLED)
        val current = ledger.snapshot()
        assertEquals(1, retained.capture.paths.getValue("native-handled").outcomes.getValue("persisted"))
        assertFalse(current.capture.enabled)
        assertEquals(0, current.capture.paths.getValue("bridge-automatic").settledAttempts)
        assertEquals(1, current.capture.paths.getValue("native-handled").outcomes.getValue("disabled"))
        ledger.retireGeneration(2)
        second.capture(CapturePath.NATIVE_HANDLED, CaptureOutcome.PERSISTED)
        assertEquals("disabled", ledger.snapshot().status)
        assertEquals(0, ledger.snapshot().capture.paths.getValue("native-handled").settledAttempts)
    }

    @Test fun successfulHttpIsIndependentOfFailedRemoval() {
        val ledger = ReportDiagnostics()
        val owner = ledger.beginGeneration(4, true)
        owner.queueObserved(1, QueueQuality.COMPLETE)
        owner.transport(TransportOrigin.OUTBOX_DRAIN, TransportOutcome.SERVER_ACCEPTED, 202)
        owner.queueOperation(QueueOperation.REMOVAL_FAILED, failure = StorageFailure.IO)
        val result = ledger.snapshot()
        assertEquals(1, result.transport.getValue("outbox-drain").outcomes.getValue("server-accepted"))
        assertEquals(202, result.transport.getValue("outbox-drain").lastHttpStatus)
        assertEquals(0, result.queue.operations.getValue("removed-after-acceptance"))
        assertEquals(1, result.queue.operations.getValue("removal-failed"))
        assertEquals("failed", result.queue.observation)
        assertNull(result.queue.pendingCount)
        assertEquals("io", result.queue.lastFailure)
    }

    @Test fun oldQueueSnapshotAndNestedMapsStayDetached() {
        val ledger = ReportDiagnostics()
        val owner = ledger.beginGeneration(1, true)
        owner.queueObserved(3, QueueQuality.PARTIAL)
        val before = ledger.snapshot()
        owner.queueObserved(0, QueueQuality.COMPLETE)
        assertEquals(3, before.queue.pendingCount)
        assertEquals("partial", before.queue.quality)
        assertEquals(0, ledger.snapshot().queue.pendingCount)
        runCatching { (before.capture.paths as MutableMap).clear() }
        runCatching { (before.queue.operations as MutableMap)["enqueue-failed"] = 99 }
        assertEquals(4, ledger.snapshot().capture.paths.size)
        assertEquals(0, ledger.snapshot().queue.operations.getValue("enqueue-failed"))
    }

    @Test fun bulkEvictionSaturatesAndRejectsInvalidAmounts() {
        val ledger = ReportDiagnostics()
        val owner = ledger.beginGeneration(1, true)
        owner.queueOperation(QueueOperation.CAPACITY_EVICTED, Int.MAX_VALUE)
        owner.queueOperation(QueueOperation.CAPACITY_EVICTED, 9)
        owner.queueOperation(QueueOperation.CAPACITY_EVICTED, -1)
        assertEquals(Int.MAX_VALUE, ledger.snapshot().queue.operations.getValue("capacity-evicted"))
    }

    @Test fun statusReadAndFatalObservationNeverWaitForDiagnosticLock() {
        val lock = ReentrantLock()
        val ledger = ReportDiagnostics(lock)
        val owner = ledger.beginGeneration(1, true)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = Thread {
            lock.lock()
            try { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
            finally { lock.unlock() }
        }
        holder.start()
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        try {
            val done = CountDownLatch(1)
            var status: ReportDeliveryStatus? = null
            val reader = Thread {
                owner.capture(CapturePath.JVM_UNCAUGHT, CaptureOutcome.PERSISTED)
                status = ledger.snapshot()
                done.countDown()
            }
            reader.start()
            assertTrue("reader or fatal observation waited on holder", done.await(1, TimeUnit.SECONDS))
            assertEquals("snapshot-busy", status?.reason)
            reader.join(1000)
        } finally { release.countDown(); holder.join(2000) }
        assertEquals(0, ledger.snapshot().capture.paths.getValue("jvm-uncaught").settledAttempts)
    }

    @Test fun jsonOmitsUnknownCountAndArbitraryContent() {
        val ledger = ReportDiagnostics()
        val owner = ledger.beginGeneration(1, true)
        owner.capture(CapturePath.BRIDGE_HANDLED, CaptureOutcome.INVALID_INPUT)
        owner.transport(TransportOrigin.LIVE_SUBMIT, TransportOutcome.NETWORK_FAILURE, -1)
        val encoded = ledger.snapshot().toJson()
        val parsed = Json.parseToJsonElement(encoded).jsonObject
        assertFalse(parsed.getValue("queue").jsonObject.containsKey("pendingCount"))
        assertFalse(parsed.getValue("transport").jsonObject.getValue("live-submit").jsonObject.containsKey("lastHttpStatus"))
        assertEquals(setOf("schemaVersion", "status", "reason", "scope", "coverage", "revision", "capture", "queue", "transport"), parsed.keys)
        assertTrue(encoded.toByteArray().size < 16 * 1024)
        assertFalse(encoded.contains("reportId"))
    }
}
